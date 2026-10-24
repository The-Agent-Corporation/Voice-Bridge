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
node dist/cli.js inbox [--project <project_id>] [--status <status>]
```

State lives in `VOICE_BRIDGE_DATA_DIR` when that is set, otherwise in the OS application-data folder (`~/Library/Application Support/voice-bridge` on macOS). The folder holds `bridge.sqlite`, the `client-token` (mode 0600) that every `/tools/*` call presents as `Authorization: Bearer <token>`, and `daemon.json`, which tells the CLI which port the running daemon chose and its pid; the CLI ignores the file once that process is gone.

## Saved sessions

`register` and `sessions` read the saved Codex and Claude Code sessions on this machine, from `VOICE_BRIDGE_CODEX_HOME` (default `~/.codex`) and `VOICE_BRIDGE_CLAUDE_HOME` (default `~/.claude`), and keep those whose working directory is, after `realpath`, exactly the project's root or, for a project at the repository's main checkout, one of its linked Git worktrees that is not registered as a project of its own; a folder with a similar name never matches. A project registered at a linked worktree owns only that worktree, so no session is listed under two projects. They only read those files. Which providers count comes from `allowed_providers` in `.voice/config.json` (`["codex", "claude-code"]` when absent). Every session found is `saved`, with every capability `false`: a saved record says nothing about whether an agent is running. Records that cannot be read or parsed are counted as `skipped_records` rather than failing the call. A provider folder that cannot be listed, or a home set by one of those variables that does not exist, fails the call with `session_discovery_failed` and leaves the stored sessions as they were.

## Primary session

`primary` (the `get_primary_session` tool) rediscovers the project's sessions and reports which one its instructions go to, as a `route`: `pinned` when you have pinned a session, which stays primary even when a newer session appears or the pinned one is `unreachable` (then `available: false`); otherwise, in the project's own worktree, `sole_connected` for its one connected session, `recent_saved_read_only` for its most recently active saved session, `ambiguous` when two or more sessions are connected or one's state is `unknown`, and `none`. `mutating_allowed` is true only for an available primary with no other connected or `unknown` session in its worktree. A pin whose session is no longer discovered is reported as `ambiguous` and kept until you unpin it. `--pin <session_id>` (`pin_primary`) takes the `<provider>:<native_session_id>` id of one of the project's sessions and refuses any other with `session_not_in_project`; `--unpin` (`unpin_primary`) removes the pin. Each also reports `skipped_records`, the records discovery could not read, so a nonzero count means the route was chosen without them. The pin lives in `bridge.sqlite`, so it survives a restart, and every pin and unpin adds a row to its `pin_audit` table.

## Events and freshness

Agents report what they did with the `ingest_event` tool: `{project_id, session_id?, source, source_event_id, source_sequence, type, payload, observed_at}`. `type` is one of `session_started`, `session_ended`, `turn_started`, `turn_completed`, `turn_failed`, `plan_updated`, `step_completed`, `git_commit`, `tool_failure`, `blocker`, `user_question`, `progress`, `final_output`, `user_decision` and `agent_ack`; `source_sequence` counts from 1 for each source; `observed_at` is any date-time `Date.parse` accepts, stored as ISO 8601. The event is stored before the call returns, and the reply is `{event_id, duplicate}`. Posting the same `(source, source_event_id)` again for the same project and `source_sequence` stores nothing and answers `duplicate: true` with the stored `event_id`, even if the payload or `observed_at` differ, so a retry is always safe; the same id for another project or sequence, or a sequence number the source already used, is a 409 `event_conflict`. A payload over 16 KiB of JSON is a 413 `payload_too_large`. The payload is kept as untrusted data; only the briefing and the inbox read it, and only the named fields listed under [The briefing file](#the-briefing-file) and [The inbox](#the-inbox). The status never contains it.

Each source has a watermark, the highest N such that its sequences 1 through N are all stored. An event above the watermark is held until the gap below it fills. `status` (the `get_project_status` tool) reports `freshness`, the type and `observed_at` of the newest processed event as `last_confirmed_activity`, and its `event_id` as `last_event_id`; `--why` adds `freshness_reasons`, each source's watermark and `last_event_id`. The reasons are, in this order: `no_events` (nothing ingested yet), `sequence_gap` (a source skipped a sequence number, so events are held above its watermark) and `turn_state_conflict` (for one session, two sources' latest processed turn events disagree among `turn_started`, `turn_completed` and `turn_failed`). Every reason that holds is listed, and `freshness` is the first that applies of `unverified` (`no_events` or `sequence_gap`), `conflicted` (`turn_state_conflict`) and `current` (no reasons). Only a gap holds events back today, so `lagging` is not reported yet. `open` shows the same freshness and last confirmed activity.

## The briefing file

The bridge writes each project's briefing to `<repo>/VOICE.md`, or to the file `briefing_file` in `.voice/config.json` names: a plain file name in the repository root (letters, digits, `.`, `_` and `-`, not starting with a dot), otherwise registration fails with `invalid_briefing_file`. It regenerates the file after every `ingest_event` call, duplicates included, and on every `open`, which prints the same text the file holds. The file is generated from the store and overwritten; edits to it are lost. It is written to a temp file beside it and renamed into place, so a reader never sees half a file, and it is not rewritten when the rendered content's hash matches the stored one and the file still holds the stored text. `open` also returns `briefing_write`, which is `written`, `unchanged` or `failed`; on `failed`, `briefing_write_error` says why (an unreadable config or a read-only repository, say), the CLI prints `VOICE.md not written: <reason>` to stderr, and the briefing is still returned.

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

## The inbox

Every `user_question` event also lands in one inbox across all projects, written in the same transaction as the event. The payload fields read are `question_id` (string, the asking agent's own id), `summary`, `type` and `priority` (strings) and `withdrawn: true`; a missing or mistyped field counts as absent and never refuses the event. A question is identified, as in the briefing, by project, session and `question_id`; each event without a `question_id` is its own question. Its id is `q-<event_id>` of the question's earliest stored `user_question` event, even one stored before the inbox existed, so it is the id VOICE.md shows; the two differ only while that event is held above its source's watermark, or once it falls outside the briefing's 200-event window. A repeat or an update keeps that id and adds no notification record; only creating an item writes one to `inbox_notifications`, which nothing reads yet. An update replaces the fields it supplies and keeps the rest; one observed before the item's newest event changes no field, but its `withdrawn: true` still counts. Items apply when the event is ingested, even while it is held above its source's watermark, so the inbox can show a question the briefing does not yet; it also keeps a question the briefing hides as answered, because nothing resolves an item yet. A question whose `user_question` events were all stored before the inbox existed is not in it until its agent posts again.

This build writes three statuses: `open`, `cancelled` and `obsolete`. `withdrawn: true` makes an open item `obsolete`; for a question the inbox has not seen it creates an `obsolete` item with no notification, so a late original cannot open it. `dismiss_inbox_question({question_id})` makes an open item `cancelled` and records `dismissed_at`; any other status is returned unchanged with `dismissed: false`, and an unknown id is a 404 `inbox_question_not_found`. A later event for a dismissed question updates its fields but does not reopen it. `list_inbox({project_id?, status?})` (`inbox` in the CLI) returns `{items}`, newest first, reading only the store; each summary comes back on one line with secrets redacted as in the briefing. `resolution_message_id` stays null until answering exists.

## Messages

`send_to_primary({project_id, text, mode, idempotency_key, approve_queue?})` sends an instruction to the project's primary session, routed as `get_primary_session` would report it after rediscovering; `mode` is `next_turn` or `steer`. Only the bearer token authenticates a send: any other field, such as `origin`, and anything the text says confer nothing and are not stored. The reply is the stored receipt: `message_id`, `project_id`, the routed `session_id` (null when the route names none), `mode`, `sequence` (1, 2, 3, … per project, in send order), `idempotency_key`, `state`, a machine `reason`, a human `detail`, `provider_ref`, `created_at`, `updated_at`, `expires_at`, every `transitions` entry (`{state, reason, at}`, oldest first, starting with `accepted`), and `duplicate`. The text itself is not echoed back. The first rule that applies decides the outcome:

1. `mode: "steer"` fails with `unsupported_capability`, even with `approve_queue`: no session can steer an active turn yet, and a steer is never sent as a next turn instead; resend with `next_turn` for that.
2. An `ambiguous` route fails with `ambiguous_owner`.
3. A route with `mutating_allowed: false` (a saved, read-only, missing or blocked primary) fails with `not_controllable`.
4. A primary that cannot take a next turn fails with `unsupported_capability`.
5. Otherwise the message is stored as `queued` and handed to the session's adapter: `delivered` with `adapter_receipt` when the adapter takes it, `failed` with `delivery_failed` when it refuses. A message behind an earlier queued one in its project stays `queued` with `awaiting_earlier_messages`.

With `approve_queue: true`, rules 2 to 4 store the message as `queued` with `awaiting_controllable_session` instead of failing it. No adapter can take a next turn in this build, so every send ends `failed` or `queued`, and nothing yet delivers a queued message; no process is ever started to deliver one. A message is stored before the call returns, so a queued message survives a crash or kill of the daemon. Sending again with a stored `idempotency_key` returns that message with `duplicate: true` and stores nothing; the same key with a different `project_id`, `text`, `mode` or `approve_queue` is a 409 `idempotency_conflict`. A queued message expires 24 hours after it was sent and then reads as `expired` with `expired_unsent`. `get_message({message_id})` returns the receipt; `cancel_message({message_id})` makes a queued message `cancelled` (`cancelled_by_user`) and returns the receipt with `cancelled: true`; any other state comes back unchanged with `cancelled: false`. An unknown id is a 404 `message_not_found`.

## Schema versions

Opening an older `bridge.sqlite` adds the tables it lacks (`sessions` for version 1, then `primary_pins` and `pin_audit`, then `events` and `source_watermarks`, then `briefings`, then `inbox_items` and `inbox_notifications`, then `messages` and `message_transitions`) and makes it version 7, which older builds refuse to open. To go back to version 6, run `sqlite3 bridge.sqlite "DROP TABLE message_transitions; DROP TABLE messages; PRAGMA user_version = 6;"` with the daemon stopped; to version 5, also drop `inbox_notifications` and `inbox_items` and set `user_version = 5`; to version 4, also drop `briefings` and set `user_version = 4`; to version 3, also drop `events` and `source_watermarks` and set `user_version = 3`; to go back to version 2, also drop `primary_pins` and `pin_audit` and set `user_version = 2`; to version 1, also drop `sessions` and set `user_version = 1`.

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
