# Provider compatibility

What the Codex and Claude Code installed on the build machine could prove. The source is one `node dist/cli.js probe` run, copied cell for cell from its JSON. Rerun the probe whenever either provider is upgraded. The matrix holds only for these versions.

- **Probed:** 2026-10-24 12:45 EDT, on `darwin-arm64`
- **codex:** `/opt/homebrew/bin/codex` → `/opt/homebrew/Caskroom/codex/0.145.0/codex-aarch64-apple-darwin`, `codex-cli 0.145.0`
- **claude-code:** `/Users/aaronwhaley/.local/bin/claude` → `/Users/aaronwhaley/.local/share/claude/versions/2.1.289`, `2.1.289 (Claude Code)`

## Matrix

A cell is `supported` only when the probe ran a check that proved it. It is `unsupported` only when the provider answered that request with JSON-RPC `-32601` (method not found). Every other cell is `unverified`, with its reason code in brackets.

| Provider | Surface | discover | inspect | live_attach | next_turn | steer | events | answer_question |
|---|---|---|---|---|---|---|---|---|
| codex | cli | unverified (no_check) | unverified (no_check) | unverified (resume_is_not_attach) | unverified (needs_credentials) | unverified (needs_credentials) | unverified (no_check) | unverified (needs_credentials) |
| codex | app_server | supported | supported | unverified (needs_foreign_session) | supported | unverified (check_failed) | supported | unverified (needs_pending_question) |
| codex | desktop | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) |
| codex | ide | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) |
| claude-code | cli | unverified (no_check) | unverified (no_check) | unverified (resume_is_not_attach) | unverified (needs_credentials) | unverified (needs_credentials) | unverified (needs_credentials) | unverified (needs_credentials) |
| claude-code | sdk | unverified (needs_credentials) | unverified (needs_credentials) | unverified (needs_credentials) | unverified (needs_credentials) | unverified (needs_credentials) | unverified (needs_credentials) | unverified (needs_credentials) |
| claude-code | desktop | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) |
| claude-code | ide | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) | unverified (no_check) |

## What each check ran

The probe runs every provider by its resolved realpath and never by a bare name. A relative `PATH` entry is skipped. Every provider process gets an environment built from nothing: `PATH`, plus `HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, all inside a fresh temp directory, and `LANG=C`. No API key and no real provider home reaches it, and the temp directory is deleted afterwards.

- **Both providers:** `<binary> --version`, which gives the version.
- **codex app_server:** one session of `<binary> -c cli_auth_credentials_store="file" app-server --listen stdio://`, spoken to as line-delimited JSON-RPC:
  1. `initialize`. Before anything else is sent, the `codexHome` it reports must be the probe's own temp `CODEX_HOME`. If it is not, the session is closed and every cell becomes `check_failed`. That check is how the probe proves it never writes to a real session store.
  2. `thread/list {}` proves **discover**: a `data` array came back, empty because the home is new.
  3. `thread/start {cwd, ephemeral: true}`, then `thread/read`, proves **inspect**: the same thread id came back.
  4. A `thread/started` notification for that thread proves **events**.
  5. `turn/start` proves **next_turn**: it returned a turn id and a `turn/started` notification followed. No credentials are present, so the upstream model call fails with 401, no model runs and nothing is billed.
  6. `turn/steer {expectedTurnId}` is sent at once. On this machine it returned `-32600: no active turn to steer`, in each of the six runs on 2026-10-24: the credential-less turn had already ended. The cell stays `check_failed`, not `unsupported`.
  7. `turn/interrupt`, which is cleanup and not evidence. Then stdin closes.
- Requests the server sends to the client, such as approvals or `item/tool/requestUserInput`, are recorded and never answered.
- Every child leads its own process group. The group is SIGKILLed and polled until it is empty, even after a clean exit, because the Codex app-server leaves a grandchild behind. `probe` exits 1 if any group survives. On SIGINT (Ctrl-C), SIGTERM or SIGHUP it SIGKILLs every group it started, deletes the temp directory and exits with 128 + the signal number.

The app-server is labelled `[experimental]` in `codex app-server --help` for this version. It opens outbound connections without credentials: the model websocket (refused with 401) and a plugin sync.

## Failures by category, with fallbacks

| Reason | Meaning | Fallback |
|---|---|---|
| `needs_credentials` | Proving the cell needs a credentialed model turn or the user's own session store. The probe never uses either. | The session stays read-only; nothing is delivered to it. |
| `no_check` | The probe has no check for this surface that leaves provider state untouched. | The surface is treated as `unreachable` for messages (PRD §8). |
| `needs_foreign_session` | Attaching needs a session the probe did not start. | Never attach to a session the bridge did not start. Deliver only to threads of an app-server the bridge started. |
| `needs_pending_question` | Answering needs a provider question waiting for an answer, which a credential-less turn never raises. | Inbox answers are not routed until a later spike proves `item/tool/requestUserInput` round-trips on a thread the bridge owns. |
| `resume_is_not_attach` | `codex resume` and `claude --resume` reopen a saved session. They do not attach to a live one. | Resumed sessions are `saved`, never `connected` (MISSION invariant 2). |
| `check_failed` | The check ran and did not prove the cell (for steer: the turn had already ended). | Treated as unverified: no steering. A second instruction to a busy session is queued instead. |

## Installed but not probed

These exist on the build machine. The probe has no check for them, so they are listed as facts only:

- `/Applications/ChatGPT.app`, which bundles its own Codex CLI and runs its own app-server
- `/Applications/Claude.app`
- VS Code extensions `anthropic.claude-code-2.1.173` and `anthropic.claude-code-2.1.220`
