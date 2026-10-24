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
```

State lives in `VOICE_BRIDGE_DATA_DIR` when that is set, otherwise in the OS application-data folder (`~/Library/Application Support/voice-bridge` on macOS). The folder holds `bridge.sqlite`, the `client-token` (mode 0600) that every `/tools/*` call presents as `Authorization: Bearer <token>`, and `daemon.json`, which tells the CLI which port the running daemon chose and its pid; the CLI ignores the file once that process is gone.

## Saved sessions

`register` and `sessions` read the saved Codex and Claude Code sessions on this machine, from `VOICE_BRIDGE_CODEX_HOME` (default `~/.codex`) and `VOICE_BRIDGE_CLAUDE_HOME` (default `~/.claude`), and keep those whose working directory is, after `realpath`, exactly the project's root or one of its linked Git worktrees; a folder with a similar name never matches. They only read those files. Which providers count comes from `allowed_providers` in `.voice/config.json` (`["codex", "claude-code"]` when absent). Every session found is `saved`, with every capability `false`: a saved record says nothing about whether an agent is running. Records that cannot be read or parsed are counted as `skipped_records` rather than failing the call.

Opening a version 1 `bridge.sqlite` adds its `sessions` table and makes it version 2, which older builds refuse to open. To go back, run `sqlite3 bridge.sqlite "DROP TABLE sessions; PRAGMA user_version = 1;"` with the daemon stopped.

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
