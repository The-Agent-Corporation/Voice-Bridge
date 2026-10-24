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

Agents report what they did with the `ingest_event` tool: `{project_id, session_id?, source, source_event_id, source_sequence, type, payload, observed_at}`. `type` is one of `session_started`, `session_ended`, `turn_started`, `turn_completed`, `turn_failed`, `plan_updated`, `step_completed`, `git_commit`, `tool_failure`, `blocker`, `user_question`, `progress`, `final_output`, `user_decision` and `agent_ack`; `source_sequence` counts from 1 for each source; `observed_at` is any date-time `Date.parse` accepts, stored as ISO 8601. The event is stored before the call returns, and the reply is `{event_id, duplicate}`. Posting the same `(source, source_event_id)` again for the same project and `source_sequence` stores nothing and answers `duplicate: true` with the stored `event_id`, even if the payload or `observed_at` differ, so a retry is always safe; the same id for another project or sequence, or a sequence number the source already used, is a 409 `event_conflict`. A payload over 16 KiB of JSON is a 413 `payload_too_large`. The payload is kept as untrusted data; only the briefing reads it, and only the named fields listed under [The briefing file](#the-briefing-file). The status never contains it.

Each source has a watermark, the highest N such that its sequences 1 through N are all stored. An event above the watermark is held until the gap below it fills. `status` (the `get_project_status` tool) reads the repository's `HEAD` and reports `freshness`, the type and `observed_at` of the newest processed event as `last_confirmed_activity`, and its `event_id` as `last_event_id`; `--why` adds `freshness_reasons`, each source's watermark and `last_event_id`. The reasons are, in this order: `no_events` (nothing ingested yet), `sequence_gap` (a source skipped a sequence number, so events are held above its watermark), `head_moved` (`HEAD` is not the newest commit a `git_commit` event recorded: a commit made with no event, a repository with commits and none recorded, or a recorded commit in a repository that now has none), `head_unreadable` (git could not read `HEAD`), `pending_refresh` (an event was stored but the briefing has not been regenerated from it, as after a crash between the two) and `turn_state_conflict` (for one session, two sources' latest processed turn events disagree among `turn_started`, `turn_completed` and `turn_failed`). Every reason that holds is listed, and `freshness` is the first that applies of `unverified` (`no_events`, `sequence_gap`, `head_moved` or `head_unreadable`), `lagging` (`pending_refresh`), `conflicted` (`turn_state_conflict`) and `current` (no reasons). A recorded short hash matches a `HEAD` it is a prefix of.

`open` (the `open_project` tool) shows the same freshness, its reasons and the last confirmed activity. When the project is `lagging` or `unverified` it answers at once with `uncertain: true`, a briefing of the last confirmed facts that it does not write to the file (`briefing_write: "deferred"`), and starts reconciliation in the background; it never waits for it and never starts an agent.

### Reconciliation

Reconciliation repairs what a missed hook or a crash left behind. For one project it reads `HEAD`, and when that differs from the newest recorded commit it stores a `git_commit` event of its own with `source: "reconcile"`, so running it again adds nothing for the same commit (and a project with no events whose repository has commits gets its first event this way); then it regenerates the briefing from every stored event, which clears `pending_refresh`, and recomputes freshness. It writes to the repository only through the briefing file. It runs for every project when the daemon starts, in the background, so the daemon answers while it runs; on an uncertain `open`; every `VOICE_BRIDGE_RECONCILE_INTERVAL_MS` milliseconds (a whole number from 1000 to 86400000, default 60000; any other value stops the daemon from starting); and on demand through the `reconcile_project` tool, which answers `{project_id, head_commit, recorded_event_id, status, briefing_write, briefing_write_error}` once the run is done. Runs for one project never overlap: an ask during a run gets the next run, which every ask made meanwhile shares. Agents should not post with `source: "reconcile"`; the bridge numbers its own sequence there.

The bridge runs git, and nothing else, by the realpath of the first `git` in an absolute `PATH` entry; a relative entry, which would resolve against the repository, is skipped.

## The briefing file

The bridge writes each project's briefing to `<repo>/VOICE.md`, or to the file `briefing_file` in `.voice/config.json` names: a plain file name in the repository root (letters, digits, `.`, `_` and `-`, not starting with a dot), otherwise registration fails with `invalid_briefing_file`. It regenerates the file after every `ingest_event` call, duplicates included, on every reconciliation, and on every `open` of a project that is not uncertain, which prints the same text the file holds. The file is generated from the store and overwritten; edits to it are lost. It is written to a temp file beside it and renamed into place, so a reader never sees half a file, and it is not rewritten when the rendered content's hash matches the stored one and the file still holds the stored text. `open` also returns `briefing_write`, which is `written`, `unchanged`, `failed` or `deferred`; on `failed`, `briefing_write_error` says why (an unreadable config or a read-only repository, say), the CLI prints `VOICE.md not written: <reason>` to stderr, and the briefing is still returned.

The file has seven sections, in this order: Project, Current objective, Agent and last confirmed status, Latest progress and current task, Blockers and pending questions, Next steps, and Provenance. Only processed events count (at or below their source's watermark), at most the newest 200 of each type, and only these payload fields are read; any other field, a payload that is not a JSON object, or a field of the wrong type is ignored:

| Section | Event type | Payload field |
|---|---|---|
| Current objective | `plan_updated` | `objective` (string), from the newest event that has one |
| Next steps | `plan_updated` | `next_steps` (array of strings), from the newest event that has one |
| Latest progress and current task | `progress` | `summary` and `current_task` (strings), each from the newest event that has one |
| Blockers | `blocker` | `summary` (string); each is shown as "reported at" its time, never as still active |
| Pending questions | `user_question` | `summary` (string), optional `question_id` (string) and `withdrawn: true` |
| (answers) | `user_decision` | `question_id`: the bridge's `q-N` id of the question it answers |
| Provenance commit | `git_commit` | `commit` (7 to 64 lowercase hex digits) |

A question is identified by its session and its `question_id`, or by its event alone when it has none. Its id is `q-<event_id>` of its earliest event, which never changes; its newest event supplies the summary or withdraws it. With more than 200 `user_question` events, a question whose earliest event falls outside that window gets a newer id. The agent line shows only the provider (`codex` or `claude-code`) of the newest session or turn event's `session_id`, or `not identified`. Status says when the bridge last confirmed activity; it never says an agent is working now.

Every field is cleaned in this order: secrets matching `sk-…`, `ghp_…`, `AKIA…`, `xox[abp]-…` and whole private-key blocks become `[REDACTED]`; every known session id of 8 or more characters becomes `[session]`; runs of whitespace and control characters become one space, so a field cannot add a line or a heading; and the field is cut to its length limit. Redaction and session scrubbing run again on the whole text. The briefing stays within `max_briefing_tokens` (an integer from 300 to 8000, default 800; otherwise registration fails with `invalid_max_briefing_tokens`), counted as the text's length divided by 4, rounded up. When it would not fit, the objective is cut first, then the latest progress, then fields and lists shrink, with pending questions kept longest; every section heading always stays.

## Schema versions

Opening an older `bridge.sqlite` adds the tables it lacks (`sessions` for version 1, then `primary_pins` and `pin_audit`, then `events` and `source_watermarks`, then `briefings`, then `refresh_marks`) and makes it version 6, which older builds refuse to open. A store upgraded from version 5 reports its projects with events as `lagging` until startup reconciliation has regenerated their briefings. To go back to version 5, run `sqlite3 bridge.sqlite "DROP TABLE refresh_marks; PRAGMA user_version = 5;"` with the daemon stopped; to version 4, also drop `briefings` and set `user_version = 4`; to version 3, also drop `events` and `source_watermarks` and set `user_version = 3`; to go back to version 2, also drop `primary_pins` and `pin_audit` and set `user_version = 2`; to version 1, also drop `sessions` and set `user_version = 1`.

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
