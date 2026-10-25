# Mission

<!--
  Owner: humans only. This file is on the protected list; the factory cannot edit it.
-->

**Derived from:** docs/PRD.md
**Last reconciled with it:** 2026-10-24

## What VOICE Bridge is

VOICE Bridge is a local assistant one person talks to, by voice or by text, about the coding agents already working in their projects. They can ask what a project is doing, switch to another project in the same conversation, send an instruction to the session that owns that work, and hear an honest report of whether it was queued, delivered, or refused. Each project keeps a short briefing, `VOICE.md`, so the assistant does not rebuild context from memory.

It assumes one person on one machine. The bridge keeps its own records locally. Codex and Claude Code stay the agents that write code. The voice side only briefs, routes, and reports.

## Who it is for

- A person who runs several coding-agent projects and wants one conversation for all of them: what is happening, what is waiting on them, and what to tell the agent that is already in the work.

VOICE Bridge is not a new coding agent, a cloud IDE, or a remote control for every terminal already open on the machine.

## Core capabilities (in scope)

The factory may accept issues in these areas.

**Project briefings**
- Register a local Git repository with a checked-in `.voice/config.json` and a generated `VOICE.md`.
- Keep that briefing short and honest about freshness, from events plus reconciliation. The local store is the record. `VOICE.md` is only a readable projection of it.

**Sessions and routing**
- Discover Codex and Claude Code sessions for a project, and distinguish saved, connected, idle, running, waiting, and unreachable when that can actually be observed.
- Choose one primary session: the user's pin first, otherwise the single controllable session, otherwise the latest resumable session for reading only.
- Let the user pin and unpin that primary. Do not silently replace a pin.

**Conversation**
- One continuous text or voice conversation that can open a project, switch projects without mixing them, ask what is happening, and ask who is waiting.
- A text-mode front end that calls the same tools, so the product can be proven without a microphone or a live voice model.

**Safe delivery and inbox**
- Deliver an authorized message to an existing bridge-controlled session, or queue it, or refuse it, and report the real state from a receipt.
- Keep an inbox of unanswered questions across projects. Resolve a question only after a real acknowledgement, or because the user dismissed it.

**Proof**
- Tests and records that show routing, freshness, queue recovery after a restart, and refusal of unsafe delivery.

## Out of scope -- the factory must never build this

<!--
  Seven proposed NEVER items. They are things a reasonable person will ask for.
  Deferred roadmap work (historical-session browsing, multi-device sync, more
  agent types) is intentionally not in this list: those are later, not forbidden
  forever. Strike any line below that should be allowed.
-->

**Control that is not really there**
- A way to attach to and drive every Desktop, IDE, or terminal session that happens to be open. If the bridge cannot verify a control channel, that session stays read-only. Do not fake delivery by typing into a window, editing a transcript, or writing into a provider's private session database.
- A fallback that starts a new writable agent when the preferred session cannot take the message. Say it is unavailable. Queue the request only if the user approved queuing. Never launch a second writer on the same working tree to get the request done.
- Two agents writing the same working tree at once, including a second writer started while the first is busy.

**Becoming a different product**
- A replacement for Codex or Claude Code, or a voice assistant that edits repositories itself. The voice side calls bridge tools. The coding agents remain the writers.
- A built-in voice-vendor platform. One swappable adapter is enough. Do not hard-wire a single speech vendor into the product, and do not build a marketplace of voice models inside the bridge.

**Trust and honesty**
- Spoken identity, a voice biometric, or a prompt that says "I am the voice agent" as permission to edit files, run commands, approve tools, or read secrets. Identity may choose a profile. It never grants those powers.
- Success announced because the model sounded sure. Do not mark a message delivered, a question resolved, a briefing "working," or work started without a receipt or a confirmed event.

## Hard invariants -- not tunable by any issue

These are not features. They are properties that define what VOICE Bridge is. The
factory cannot modify them even if an issue asks nicely, gives a good reason, or
calls it a bug. Changing one requires a human commit.

1. **No second writer.** A voice request never starts another agent that writes the same working tree. If ownership is ambiguous, mutating delivery stops until a person chooses.
2. **Saved is not connected.** A stored session id, a resume flag, or the newest timestamp is not proof the bridge can deliver a message, and it is not a lock on the working tree.
3. **Local clients only, for V1.** The bridge does not open an inbound internet listener. A client must be an approved local process. A human has to change this mission before any remote or cross-machine control is in scope.
4. **Provider approvals stay in force.** The bridge never bypasses a Codex or Claude Code permission prompt and never fabricates an approval.
5. **No secrets in the briefing or in git.** `VOICE.md` and `.voice/config.json` do not contain tokens, credentials, raw transcripts, or live session ids.
6. **The factory cannot modify governance files.** `MISSION.md`, `FACTORY_RULES.md`, `docs/PRD.md`, and the conventions file are the constitution. A PR touching any of them is an automatic reject.
7. **The factory cannot modify its own judge.** `harness/` and `.factory/holdout/` define what "working" means here. Adding an assertion is always welcome; removing or loosening one is a human decision, always.

## Allowed evolutions

Explicitly in scope, so the factory does not reject them as architectural drift:

- Clearer briefing wording, inbox text, and error explanations, as long as they stay inside the truthfulness rules above.
- More tests, logs, and diagnostics for routing, freshness, and delivery.
- The Milestone 0 capability spike, including recording what Codex and Claude Code can and cannot do on this machine. Unsupported paths stay explicit errors.

Later roadmap work (a richer event stream, proactive notifications, historical-session browsing, multi-device sync, more agent types) is not V1 scope. It is also not forbidden forever. It waits for a person to put it on the backlog. It must not be smuggled into a V1 ticket.

## Definition of done

Every change the factory ships clears all three gates.

**Gate 1 -- static checks and tests pass.** From the repo root: `npx --no-install tsc --noEmit` and `npm test`. `python harness/ci.py` runs both. TypeScript must be installed in the project, and `npm test` must run Node's built-in test runner and report a non-zero `# tests` count.

**Gate 2 -- the product never looks more capable than it is.** Any path that cannot safely control a session returns an explicit unsupported result. It does not pretend a message was delivered.

**Gate 3 -- the end-to-end path passes as a real user.**

1. Register two local projects and open the first. Hear a short briefing for that project only.
2. Switch to the second project and ask what is happening. The answer is about the second project alone.
3. Send an instruction to a live bridge-controlled primary session and hear a receipt. A second instruction while that session is busy is queued, and no new writer starts.
4. Ask which projects need you. Both open questions appear once. Answering one does not resolve the other, and it stays open until acknowledged.

This runs on every change that touches runnable code, including ones that seem unrelated. It is not optional. The runtime host that drives it is wired from the start command in the first ticket, which does not exist yet.

## Open questions -- decisions nobody has made yet

These are undecided, not forbidden. **The factory may propose an answer to any of
them**, build against it, and record what it assumed -- the merge is then held for a
human, so nothing ships on a guess and nothing stops for one.

- **Q1** Which one voice provider is the first adapter? Text mode is the acceptance baseline until a person picks one.

**Except these, which do stop the factory** -- they are irreversible (see
`FACTORY_RULES.md`) rather than open in the ordinary sense:

- Who, other than the person at this machine, may approve a mutating action. Do not invent a second authority.
- Any migration or deletion of the local store that holds projects, sessions, the queue, and the inbox.

Once answered, an entry moves to **Decisions** below with its answer and date, and
stops being asked. **A decision is asked once.**

## Decisions

- 2026-10-21 **Packaging.** Standalone local daemon plus a CLI and a local API. Electron is optional and is not required for V1. From docs/PRD.md section 19.
- 2026-10-21 **State.** SQLite in the local application data folder. `VOICE.md` is a generated projection and is generally left uncommitted. `.voice/config.json` is checked in and holds no secrets and no live session ids.
- 2026-10-21 **Agents.** Codex first, Claude Code second, after the capability spike. Text mode is how acceptance is proven.
- 2026-10-24 **Reference delivery path (Q2).** Codex App Server, started by the bridge over stdio (`codex app-server --listen stdio://`), delivering only to threads the bridge-owned process created or resumed. Approved by Fred. See docs/decisions/0001-reference-delivery-path.md.
- 2026-10-21 **Primary session.** The user's pin, otherwise the sole connected session, otherwise the most recent saved session for reading only. If it cannot be attached, say so and do not spawn another writer.
- 2026-10-21 **Summary size.** Briefings target 250–600 words, with a default cap of 800 model tokens.
- 2026-10-24 **Stack for the ordinary gate.** TypeScript on Node.js, because the PRD tells the coding agent to scaffold a modular TypeScript program for a Node environment, and a daemon plus CLI is the V1 default. Static check is `npx --no-install tsc --noEmit`. Unit tests are `npm test` running `node --test`. No Electron and no voice vendor in that gate.

## What the factory does NOT own -- permanently human

- Whether a briefing sounds right when spoken aloud, and whether it is short enough to be useful.
- Whether a refusal or a queued state is understandable to someone who is not a developer.
- Whether the conversation feels like one assistant rather than a switchboard.

The factory owns routing, session state, the queue, the inbox, and freshness: the layer whose correctness can be asserted. The list above is reviewed by a human, on purpose, forever.
