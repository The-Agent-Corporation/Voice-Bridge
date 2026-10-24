# 0001 — Reference path for live delivery in V1

**Status: Proposed — held for a human (MISSION Q2).** This is not a decision until a person moves Q2 into MISSION's Decisions.

## Question

MISSION Q2: after the Milestone 0 spike, which single bridge-controlled provider path is the reference for live delivery in V1?

## Proposal

**Codex App Server, started by the bridge over stdio.** The command is `codex app-server --listen stdio://`, and the bridge delivers only to threads that this bridge-owned process created or resumed.

## Evidence

From the `voice-bridge probe` run of 2026-10-24 12:45 EDT, with `codex-cli 0.145.0` at `/opt/homebrew/Caskroom/codex/0.145.0/codex-aarch64-apple-darwin` (full matrix in [docs/compatibility.md](../compatibility.md)). On the `app_server` surface:

| capability | status | check |
|---|---|---|
| discover | supported | `thread/list → result` (a `data` array) |
| inspect | supported | `thread/start`, then `thread/read → result` with the same thread id |
| events | supported | `thread/started` notification for that thread |
| next_turn | supported | `turn/start → result` with a turn id, followed by `turn/started` |
| steer | unverified (check_failed) | `turn/steer → error -32600: no active turn to steer` |
| live_attach | unverified (needs_foreign_session) | not checked |
| answer_question | unverified (needs_pending_question) | not checked |

Codex's app-server is the only surface on which anything was proved. It runs bridge-owned in an isolated home and answers thread and turn methods without credentials. It also agrees with MISSION's Decision "Codex first, Claude Code second".

## Why not Claude Code

Every Claude Code cell is `unverified`:

- `cli`: `no_check` for discover and inspect, `resume_is_not_attach` for live_attach, and `needs_credentials` for the rest
- `sdk`: `needs_credentials` throughout
- `desktop` and `ide`: `no_check`

Every Claude Code path that does anything (`claude -p`, the SDK's stream-json transport, `--bg`/`attach`) writes to `~/.claude`, needs credentials, or leaves a process running, so the probe does not run any of them. Nothing here argues against Claude Code; nothing proves it either.

## Limits of this evidence

- The app-server is labelled `[experimental]` in this Codex version, so its protocol may change. Rerun the probe on every upgrade.
- Steering is not proven. On this machine the credential-less turn ended before `turn/steer` arrived. Until steering is proven, a second instruction to a busy session is queued, as Gate 3 requires anyway.
- No model round-trip was proven. Every turn ran without credentials and failed upstream with 401.
- `live_attach` to Desktop, IDE or CLI sessions the bridge did not start is not claimed.
- Answering provider questions (`item/tool/requestUserInput`) is not proven.

## Next proof needed for the Milestone 0 exit gate

A credentialed thread, owned by the bridge, that receives `turn/start` and returns a receipt. Steering should be proven on that same running turn. That proof belongs to the delivery issue (US-03), not to this spike.
