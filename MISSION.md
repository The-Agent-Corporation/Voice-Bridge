# Mission

<!--
  Owner: humans only. This file is on the protected list; the factory cannot edit it.
  Rewritten 2026-11-04 to Fred's voice.md plug-in design.
-->

## What VOICE Bridge is

VOICE Bridge is a plug-in you install in a folder. Voice agents cannot hold as much context or as many tools as a full agent, so the folder's own agent keeps the depth and the voice agent stays light.

Installing it in a folder creates:

1. **`voice.md`**: like AGENTS.md or CLAUDE.md, but short and concise. The agent in charge of the folder writes it and keeps it current (status and so on).
2. **A manifest** (`.voice/manifest.json`): registers the folder and the agent registered on it.

When you talk to a voice agent about a registered folder (for example, calling about Roscoe), that folder's `voice.md` is loaded automatically into the voice agent's system prompt. Any voice agent with the setup can be pointed at any registered folder.

The voice agent gets two tools:

- **Ask the agent.** The voice agent messages the folder's registered agent. That agent has a reply tool to answer back to the voice agent.
- **Wake and follow along (optional).** At call start the plug-in wakes the folder's agent, which follows the conversation live, so questions are answered with low latency.

## Core capabilities (in scope)

**Install and manifest**
- `voice-bridge init` in a folder writes `.voice/manifest.json` and a starter `voice.md`, and registers the folder locally.
- Manifest sketch:
  ```json
  {
    "schema": "voice-manifest/0.1",
    "folder_id": "roscoe",
    "name": "Roscoe",
    "aliases": ["roscoe"],
    "briefing": "voice.md",
    "agent": { "id": "roscoe-main", "kind": "codex", "follow_along": false }
  }
  ```

**voice.md**
- Short: target about 400 words, hard cap 1,500 tokens.
- Sections: header (name, updated time, updated by), What this is, Status now, Waiting on you, Ask the agent about.
- Written and kept current by the folder's registered agent. A checker enforces the sections, the size cap, and no secrets.

**Auto-load**
- Naming a registered folder (by id or alias) loads its `voice.md` into the voice agent's system prompt. Switching folders swaps it.

**Ask and reply**
- `ask_agent(folder_id, question)` delivers the question to the folder's registered agent and returns at once.
- The folder's agent answers with `reply_to_voice(ask_id, text)`; the reply reaches the voice agent.
- The voice agent only says a question was delivered or answered when that actually happened.

**Wake and follow along (optional)**
- When enabled in the manifest, call start wakes the folder's agent and streams the conversation to it so it can answer asks with low latency.

**Provider**
- Text mode first. The voice provider stays open (Q1); one swappable adapter.

## Out of scope -- the factory must never build this

- Anything beyond the design above. Other use cases wait for a person to add them.
- A voice agent that edits files or runs commands itself. The folder's agent does the work.

## Hard invariants -- not tunable by any issue

Changing one requires a human commit.

1. **Registered folders only.** A voice agent can only load or ask about folders registered with the plug-in.
2. **No secrets in `voice.md` or the manifest.** No tokens, credentials, or live session ids.
3. **The factory cannot modify governance files.** `MISSION.md`, `FACTORY_RULES.md`, `docs/PRD.md`, and the conventions file are the constitution. A PR touching any of them is an automatic reject.
4. **The factory cannot modify its own judge.** `harness/` and `.factory/holdout/` define what "working" means here. Adding an assertion is always welcome; removing or loosening one is a human decision, always.

## Milestone 1

1. `voice.md` format and checker.
2. `init` and the manifest.
3. Ask the agent and reply.
4. Auto-load `voice.md` by folder.
5. Wake and follow along.

## Definition of done

**Gate 1 -- static checks and tests pass.** From the repo root: `npx --no-install tsc --noEmit` and `npm test`. `python harness/ci.py` runs both. TypeScript must be installed in the project, and `npm test` must run Node's built-in test runner and report a non-zero `# tests` count.

**Gate 2 -- the product never looks more capable than it is.** An unsupported path returns an explicit unsupported result.

**Gate 3 -- the end-to-end path passes in text mode.**

1. `init` two folders. Each has a manifest and a valid `voice.md`.
2. Talk about the first folder: its `voice.md` is in the system prompt. Switch to the second: only the second's is.
3. Ask the first folder's agent a question; its reply comes back to the voice agent.
4. An unregistered folder is refused.

## Open questions -- decisions nobody has made yet

- **Q1** Which voice provider is the first adapter? Text mode is the acceptance baseline until a person picks one.

## Decisions

- 2026-11-04 **Design.** VOICE Bridge is a folder plug-in: voice.md + manifest, auto-load into the voice agent, ask/reply tools, optional wake and follow along. Decided by Fred. Supersedes the earlier session-routing scope.
- 2026-10-21 **Packaging.** Standalone local daemon plus a CLI and a local API. Electron is optional and is not required for V1. From docs/PRD.md section 19.
- 2026-10-21 **State.** SQLite in the local application data folder. `.voice/manifest.json` is checked in and holds no secrets and no live session ids.
- 2026-10-21 **Agents.** Codex first, Claude Code second, after the capability spike. Text mode is how acceptance is proven.
- 2026-10-24 **Reference delivery path (Q2).** Codex App Server, started by the bridge over stdio (`codex app-server --listen stdio://`), delivering only to threads the bridge-owned process created or resumed. Approved by Fred. See docs/decisions/0001-reference-delivery-path.md.
- 2026-10-24 **Stack for the ordinary gate.** TypeScript on Node.js, because the PRD tells the coding agent to scaffold a modular TypeScript program for a Node environment, and a daemon plus CLI is the V1 default. Static check is `npx --no-install tsc --noEmit`. Unit tests are `npm test` running `node --test`. No Electron and no voice vendor in that gate.

## What the factory does NOT own -- permanently human

- Whether a briefing sounds right when spoken aloud, and whether it is short enough to be useful.
- Whether a refusal or a queued state is understandable to someone who is not a developer.
- Whether the conversation feels like one assistant rather than a switchboard.

The factory owns install, the manifest, the voice.md checker, auto-load, and ask/reply: the layer whose correctness can be asserted. The list above is reviewed by a human, on purpose, forever.
