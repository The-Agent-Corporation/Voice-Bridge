# Voice-Bridge

A local bridge daemon and CLI that registers Git repositories and returns an honest briefing for each one. It needs Node.js 26 or newer.

## Run it

```sh
npm ci
npm run build
node dist/daemon.js --port 4517
```

The daemon listens on `127.0.0.1` only. In another terminal:

```sh
node dist/cli.js register /path/to/repo   # reads /path/to/repo/.voice/config.json
node dist/cli.js projects
node dist/cli.js open <project_id>
node dist/cli.js sessions <project_id>
node dist/cli.js primary <project_id> [--pin <session_id> | --unpin]
node dist/cli.js status <project_id> [--why]
```

State lives in `VOICE_BRIDGE_DATA_DIR` when that is set, otherwise in the OS application-data folder (`~/Library/Application Support/voice-bridge` on macOS). The folder holds `bridge.sqlite`, the `client-token` (mode 0600) that every `/tools/*` call presents as `Authorization: Bearer <token>`, and `daemon.json`, which tells the CLI which port the running daemon chose and its pid; the CLI ignores the file once that process is gone.

## Saved sessions

`register` and `sessions` read the saved Codex and Claude Code sessions on this machine, from `VOICE_BRIDGE_CODEX_HOME` (default `~/.codex`) and `VOICE_BRIDGE_CLAUDE_HOME` (default `~/.claude`), and keep those whose working directory is, after `realpath`, exactly the project's root or, for a project at the repository's main checkout, one of its linked Git worktrees that is not registered as a project of its own; a folder with a similar name never matches. A project registered at a linked worktree owns only that worktree, so no session is listed under two projects. They only read those files. Which providers count comes from `allowed_providers` in `.voice/config.json` (`["codex", "claude-code"]` when absent). Every session found is `saved`, with every capability `false`: a saved record says nothing about whether an agent is running. Records that cannot be read or parsed are counted as `skipped_records` rather than failing the call. A provider folder that cannot be listed, or a home set by one of those variables that does not exist, fails the call with `session_discovery_failed` and leaves the stored sessions as they were.

## Primary session

`primary` (the `get_primary_session` tool) rediscovers the project's sessions and reports which one its instructions go to, as a `route`: `pinned` when you have pinned a session, which stays primary even when a newer session appears or the pinned one is `unreachable` (then `available: false`); otherwise, in the project's own worktree, `sole_connected` for its one connected session, `recent_saved_read_only` for its most recently active saved session, `ambiguous` when two or more sessions are connected or one's state is `unknown`, and `none`. `mutating_allowed` is true only for an available primary with no other connected or `unknown` session in its worktree. A pin whose session is no longer discovered is reported as `ambiguous` and kept until you unpin it. `--pin <session_id>` (`pin_primary`) takes the `<provider>:<native_session_id>` id of one of the project's sessions and refuses any other with `session_not_in_project`; `--unpin` (`unpin_primary`) removes the pin. Each also reports `skipped_records`, the records discovery could not read, so a nonzero count means the route was chosen without them. The pin lives in `bridge.sqlite`, so it survives a restart, and every pin and unpin adds a row to its `pin_audit` table.

## Events and freshness

Agents report what they did with the `ingest_event` tool: `{project_id, session_id?, source, source_event_id, source_sequence, type, payload, observed_at}`. `type` is one of `session_started`, `session_ended`, `turn_started`, `turn_completed`, `turn_failed`, `plan_updated`, `step_completed`, `git_commit`, `tool_failure`, `blocker`, `user_question`, `progress`, `final_output`, `user_decision` and `agent_ack`; `source_sequence` counts from 1 for each source; `observed_at` is any date-time `Date.parse` accepts, stored as ISO 8601. The event is stored before the call returns, and the reply is `{event_id, duplicate}`. Posting the same `(source, source_event_id)` again for the same project and `source_sequence` stores nothing and answers `duplicate: true` with the stored `event_id`, even if the payload or `observed_at` differ, so a retry is always safe; the same id for another project or sequence, or a sequence number the source already used, is a 409 `event_conflict`. A payload over 16 KiB of JSON is a 413 `payload_too_large`. The payload is kept as data only: nothing reads it back, and neither the status nor the briefing ever contains it.

Each source has a watermark, the highest N such that its sequences 1 through N are all stored. An event above the watermark is held until the gap below it fills. `status` (the `get_project_status` tool) reports `freshness`, the type and `observed_at` of the newest processed event as `last_confirmed_activity`, and its `event_id` as `last_event_id`; `--why` adds `freshness_reasons`, each source's watermark and `last_event_id`. The reasons are, in this order: `no_events` (nothing ingested yet), `sequence_gap` (a source skipped a sequence number, so events are held above its watermark) and `turn_state_conflict` (for one session, two sources' latest processed turn events disagree among `turn_started`, `turn_completed` and `turn_failed`). Every reason that holds is listed, and `freshness` is the first that applies of `unverified` (`no_events` or `sequence_gap`), `conflicted` (`turn_state_conflict`) and `current` (no reasons). Only a gap holds events back today, so `lagging` is not reported yet. `open` shows the same freshness and last confirmed activity.

## Schema versions

Opening an older `bridge.sqlite` adds the tables it lacks (`sessions` for version 1, then `primary_pins` and `pin_audit`, then `events` and `source_watermarks`) and makes it version 4, which older builds refuse to open. To go back to version 3, run `sqlite3 bridge.sqlite "DROP TABLE events; DROP TABLE source_watermarks; PRAGMA user_version = 3;"` with the daemon stopped; to go back to version 2, also drop `primary_pins` and `pin_audit` and set `user_version = 2`; to version 1, also drop `sessions` and set `user_version = 1`.

## Probe the providers

```sh
node dist/cli.js probe
```

This runs on its own; the daemon need not be up. It prints JSON recording what the installed Codex and Claude Code can prove. For each provider it gives the realpath it ran, the version, and, for every surface, each capability as `supported`, `unsupported` or `unverified`, with the command and exit code as evidence. Only Codex's app-server is checked live: it runs in a throwaway home with no credentials and an environment built from nothing but your `PATH`. `probe` exits 1 if any process it started could not be killed. The observed matrix and what it means are in [docs/compatibility.md](docs/compatibility.md).

## Checks

```sh
python harness/ci.py   # runs npx --no-install tsc --noEmit, then npm test
```

`npm test` keeps `--test-reporter=tap`: the harness counts tests from TAP's `# tests N` line, and Node's default reporter does not print one.
