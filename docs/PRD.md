# VOICE Bridge — Product Requirements Document

**Version:** 1.0  
**Date:** October 21, 2026  
**Status:** Ready for implementation planning  
**Target:** Local-first desktop agent bridge; initial Codex and Claude Code integration  
**Implementation audience:** Codex / Claude Code / software engineering team

## 1. Executive Summary

VOICE Bridge provides one continuous real-time conversational interface for interacting with multiple agent-driven projects. Each repository exposes a concise, automatically maintained `VOICE.md` briefing. A local bridge discovers projects and their coding-agent sessions, resolves the primary session for each project, routes authorized voice-originated messages to the correct session, and maintains an inbox of unanswered questions and status events. The user can switch projects mid-conversation without opening different terminals or manually reconstructing context.

The V1 product must **not** assume that a saved session identifier is sufficient to control an independently launched terminal or desktop agent. It must discover actual capabilities at runtime and refuse unsafe delivery rather than start a competing writer. V1 must be useful in read-only mode even when a live session cannot be controlled.

## 2. Problem and Desired Experience

Users run numerous projects, sometimes with both Codex and Claude Code and multiple historical sessions per repository. They want to speak naturally with one assistant: “What is happening in Project A?”, “Tell the current agent to implement X,” “Who is waiting on me?”, and “Switch to Project B.” Today, project context gets stale, an agent may distrust injected messages, and blindly resuming or spawning sessions risks simultaneous writes to the same working tree.

**Desired outcome:** a voice assistant can accurately brief the user, deliver authenticated instructions to the correct existing working session when possible, report true delivery/execution state, and preserve project separation and workspace safety.

## 3. Goals and Non-goals

### V1 goals

- Register a local Git repository using a `VOICE.md` convention and a small `.voice/config.json` file.
- Maintain an accurate, concise project briefing using events plus reconciliation rather than relying on agent recollection.
- Discover known Codex and Claude Code sessions associated with a project, and distinguish *saved*, *connected*, *idle*, *running*, *waiting*, and *unreachable* states where observable.
- Select one primary session through a deterministic policy, with optional user pinning.
- Allow a voice/text front end to load a project's briefing and switch projects within one conversational session.
- Deliver authorized messages to an existing session through a supported provider-specific mechanism; queue, reject, or ask for clarification when delivery is not safe.
- Capture pending user questions, progress, completion, and errors in a central inbox.
- Provide enough observability and automated tests to prove correctness of routing and freshness.

### V1 non-goals

- Universal attachment/control of *every* pre-existing Desktop, IDE, or terminal session.
- Browsing/asking questions of arbitrary historical sessions (V3).
- Multi-device cloud sync, voice biometric authentication, or remote network deployment.
- Automatically creating a new writable agent when delivery to the preferred session fails.
- Concurrent writable control of the same working tree by multiple agents.
- Replacing Codex or Claude Code agent runtimes.
- Full voice-stack selection; use an adapter so one low-latency voice model/provider can be swapped out.

## 4. User Stories

**US-01:** As a user, I can point the harness to a repository and see its current project briefing without needing to know its session IDs.

**US-02:** As a user, I can say “Switch to the golf app,” then ask what is being worked on and what decisions are pending.

**US-03:** As a user, I can tell the voice assistant to send a change request to the primary Codex/Claude Code session and hear whether it was queued, delivered, acknowledged, started, or completed.

**US-04:** As a user, I can ask “Which projects need me?” and receive a deduplicated list of open questions across repositories.

**US-05:** As a user, I can designate a particular session as primary; the system does not change my pin merely because another session was used recently.

**US-06:** As a user, if my preferred session cannot be controlled safely, I receive a clear explanation and the request remains queued only if I approved queuing.

**US-07:** As a developer, I can inspect why a briefing was marked current/stale and which event/revision it reflects.

## 5. System Architecture

```text
Microphone / Voice UI / Text UI
             |
       Realtime Talk Agent
       (short context, tool calls)
             |
       VOICE Bridge API
             |
  +----------+----------+-------------------+
  |          |          |                   |
Project   Session     Message           Inbox/Event
Registry  Registry    Router & Queue    Store
  |          |          |                   |
  +----------+----------+-------------------+
             |
     Provider adapters
     /             \
 Codex             Claude Code
 App Server/CLI    supported CLI/hooks/process interface
             |
   Repo files + working sessions
       VOICE.md / .voice/
```

**Major components:**

1. **Voice frontend:** a low-latency speaking agent. It owns the interaction and calls bridge tools. Never edits repositories directly.
2. **Bridge daemon:** local process exposing authenticated APIs/tool interfaces and event streams.
3. **Project registry:** maps canonical repository roots/worktree IDs to stable project IDs and configuration.
4. **Session registry:** tracks provider, native session ID, root/worktree, last meaningful activity, live-connection evidence, turn state, and explicit pin.
5. **Provider adapters:** capabilities and controls for each agent ecosystem.
6. **Context synchronizer:** converts lifecycle events and periodic reconciliation into authoritative state and a short `VOICE.md` projection.
7. **Inbox:** durable actionable questions and status notifications.
8. **Message queue:** durable, authenticated, ordered, idempotent delivery to the chosen session.

**Source of truth:** SQLite or another durable local store for registry, event log, queue, inbox, and leases. `VOICE.md` is a *generated human-readable projection*, not the authoritative mutable database.

## 6. Repository Convention and File Contract

```text
repository/
├── AGENTS.md                  # Optional Codex instructions
├── CLAUDE.md                  # Optional Claude Code instructions
├── VOICE.md                   # Generated conversational briefing
└── .voice/
    └── config.json           # Checked-in, provider-neutral configuration
```

Runtime session state must **not** be committed to the repository. Prefer bridge-owned SQLite. If a local `.voice/runtime.json` compatibility file is emitted, add it to `.gitignore`, avoid secrets, and consider it a disposable cache.

### 6.1 `VOICE.md` required sections

- Project name and ID
- Brief current objective
- Working agent and **last confirmed** status (never assert “working” from a stale file)
- Latest meaningful progress and current task
- Blocking issues and pending user questions (with stable question IDs)
- Next steps
- Provenance: last generated timestamp, highest reconciled event/commit, freshness status

**Constraints:** target 250–600 words, configurable maximum token budget (default 800 tokens). Exclude source dumps, giant plans, personal secrets, tokens, and raw transcripts. On overflow, prioritize pending decisions, current work, blockers, and near-term steps. Keep rich references in the state store.

### 6.2 `.voice/config.json` sample

```json
{
  "schema_version": 1,
  "project_id": "desktop-agent",
  "display_name": "Desktop Agent",
  "briefing_file": "VOICE.md",
  "primary_selection": "pin_then_connected_then_recent",
  "allowed_providers": ["codex", "claude-code"],
  "auto_deliver": false,
  "bridge_profile": "local"
}
```

Do not store secrets, trusted identity assertions, or machine-specific live session IDs in this file. Per-device connection state belongs in the local bridge registry.

### 6.3 Instruction-file integration

The installer may add a clearly delimited, idempotent block to `AGENTS.md` and/or `CLAUDE.md` **with permission and backup**. It explains that messages delivered by the authenticated bridge are legitimate user-originated input **when delivered using the provider's supported user-input channel**. It does not make claims in arbitrary prompt text authoritative; normal permission controls remain in place. It also requests that the agent report meaningful progress, blockers, and open questions via supported hooks/events.

Do not overwrite existing instruction files. Detect duplicate blocks, provide `install`, `verify`, and `uninstall` commands, and preserve user edits outside the block.

## 7. Session Discovery and Primary Selection

### 7.1 Discovery inputs

- Configured repository paths and Git worktree identity.
- Provider-native session listings / records where supported.
- Provider API event streams for sessions controlled by the bridge.
- Process and connection observations for live sessions where permission and platform support allow.
- Last user activity / session resume events.

Associate sessions to canonical repository/worktree paths, not just similar project folder names. Historical session metadata is indexed in V1 even though historical-session conversation browsing is deferred.

### 7.2 Session state model

- `saved`: resumable conversation record exists; live connection unverified.
- `connected_idle`: live controllable agent process, no active turn.
- `connected_running`: live controllable agent processing a turn.
- `waiting_user`: a specific user-facing prompt/approval is pending.
- `unreachable`: no supported control path at present.
- `unknown`: discovery incomplete or conflicting.

Never equate `saved` with `connected` and never equate the newest timestamp with a writable-session lock.

### 7.3 Primary resolution

1. If a user pin exists and refers to a valid session, select it as **primary**, even if currently unavailable; report routing unavailability without silently replacing the pin.
2. Otherwise, if exactly one controllable connected session exists in the project's selected worktree, select it.
3. Otherwise, choose the most recently meaningfully active **resumable** session for *read-only context*; do not assume it can receive live messages.
4. If multiple connected writers are competing, or evidence conflicts, mark `ambiguous` and block mutating delivery until a user chooses or the conflict is resolved.
5. Allow explicit `pin_primary` and `unpin_primary` in V1 UI/API, with audit logging.

Use timestamps only as tie-breakers when the candidates are safe for the requested action. Distinguish `primary_session_id` from `connected_session_id` and `workspace_owner_session_id`.

## 8. Session Control and Provider Adapters

Expose a provider-neutral adapter contract:

```typescript
interface AgentAdapter {
  provider: 'codex' | 'claude-code';
  discoverSessions(repoRoot: string): Promise<DiscoveredSession[]>;
  inspectSession(sessionId: string): Promise<SessionState>;
  capabilities(sessionId: string): Promise<{
    liveAttach: boolean;
    nextTurn: boolean;
    steerActiveTurn: boolean;
    answerPendingQuestion: boolean;
    subscribeEvents: boolean;
  }>;
  sendNextTurn(sessionId: string, text: string, idempotencyKey: string): Promise<DeliveryReceipt>;
  steerActiveTurn?(sessionId: string, text: string): Promise<DeliveryReceipt>;
  answerPendingQuestion?(sessionId: string, questionId: string, answer: string): Promise<DeliveryReceipt>;
  subscribeEvents?(sessionId: string): AsyncIterable<AgentEvent>;
}
```

**Codex reference integration:** evaluate supported Codex App Server `thread/resume`, `turn/start`, `turn/steer`, turn status notifications, and runtime connection ownership. Ensure the bridge-controlled App Server represents the target session rather than inadvertently opening a separate competing runtime. **Claude Code reference integration:** evaluate lifecycle hooks, its saved sessions, and supported SDK/CLI continuation; `claude -p` or `--resume` in a new process does **not by itself** prove live attachment to an independently running interactive session. Record capability gaps rather than making unsafe assumptions. [R1–R3]

**V1 implementation gate:** working proof of safe message delivery is required for at least one *bridge-controlled* session, with provider-specific feature flags. A discovered independently launched session with no verified injection channel remains read-only/unreachable for messages. Do not emulate user input by modifying transcript files or writing directly to a provider's private session database.

## 9. Trusted Message Transport and Queue

All outbound instructions are authenticated by the local bridge and bound to a user permission context, stable project ID, destination session ID, message ID, and requested delivery mode. Accept requests only from approved local clients (OS-authenticated socket or loopback with strong authorization). No trust is conferred by a prompt saying “I am the voice agent.”

Message lifecycle: `draft` → `accepted` → `queued` → `delivered` → `acknowledged/started` → `completed` / `failed` / `expired` / `cancelled`.

**Routing modes:**

- `next_turn`: enqueue behind the current running turn, then deliver to the same existing session at a safe boundary.
- `steer`: append to an in-flight turn only when adapter verifies provider support; otherwise require fallback approval.
- `answer_question`: reply to a specific pending question/approval through a supported mechanism, never by fabricating an approval.
- `read_only_query`: use briefing and project status; avoid waking a writable agent merely to answer a basic question.

Message acknowledgment must be based on adapter receipts/events, not on model-generated optimism. Preserve ordering per session and support idempotency keys, retry-safe delivery, expiration, and user cancellation. A new instruction must not cause a second writable session to launch automatically.

**Authorization:** voice identity can select a profile, but never independently grant permission to mutate files, run commands, approve tools, or access secrets. Require device/account authorization and explicit user approval for high-impact operations according to product settings.

## 10. Workspace Ownership and Concurrency

The bridge maintains per-worktree lease state with owner, observed process, expiry, and heartbeat. A lease is only *enforceable* for processes under bridge control or in a sandbox/lock discipline that they honor. For external IDE/terminal processes, treat it as advisory and fail closed on conflicts.

- Never launch a second writer in the same working tree to service a voice request.
- If the owner is busy, queue until safe or steer through the current turn when explicitly supported.
- If the owner disconnects, retain undelivered messages and mark them not delivered; do not silently resume/fork in an additional process.
- Permit independent worktrees in later phases, with distinct ownership records.
- Use unique request IDs so duplicate delivery cannot cause duplicate tasks.

## 11. VOICE.md Freshness and Event Processing

### 11.1 Event sources

- Agent session started/resumed/ended, turn started/completed/failed
- Plan created, modified, and step completed (when reliably observable)
- Git commit and optionally dirty-tree changes (debounced)
- Tool failures, blockers, and explicit user questions
- Agent progress and final output
- Voice-provided decisions and agent acknowledgment

Use provider-native hooks/events when available. Claude Code has documented session, per-turn, and task lifecycle hooks. Codex integration should use supported event streams and verify any hook mechanism in the installed version. [R1–R3]

### 11.2 Processing

Hooks submit small events to durable local storage and return quickly. Do **not** invoke an LLM synchronously from every hook. Deduplicate, debounce, order events, maintain a source watermark, and reconcile periodically against Git state and agent session status. Use deterministic updates for structured fields and optional small-model synthesis for the readable briefing. Writes to `VOICE.md` are atomic and coordinated by a single updater per project.

### 11.3 Freshness states

- `current`: all required observed events through the source watermark reconciled; sources reachable.
- `lagging`: known unprocessed events.
- `unverified`: missing hook coverage, unavailable process, or incomplete reconciliation.
- `conflicted`: multiple sources disagree about material status.

Show freshness state and last confirmed activity separately. An old briefing can still be current if no subsequent change occurred; a newly generated one can be unverified if events are missing. If a voice request opens a lagging brief, load only safe last-known facts, disclose uncertainty, and trigger background reconciliation.

### 11.4 End-of-turn integrity check

On supported stop/completion hooks, check whether relevant work was captured. Where the provider supports a safe blocking/retry hook, request a concise status update once, with loop protection. Where hooks are nonblocking/unavailable, mark the brief unverified and reconcile asynchronously. Never deadlock or repeatedly prevent an agent from completing work.

## 12. Universal Inbox

An inbox record includes `question_id`, `project_id`, `origin_session_id`, `type`, `summary`, `created_at`, `status`, `priority`, `source_event_id`, and optional `resolution_message_id`.

Statuses: `open`, `answer_queued`, `delivered`, `acknowledged`, `resolved`, `cancelled`, `obsolete`.

The assistant can call `list_inbox` to answer “Who needs me?” without waking every coding agent. Questions are only marked resolved after reliable acknowledgement or explicit user dismissal. Prevent duplicates by stable origin IDs and correlation; updates to the same question must not generate duplicate notifications.

## 13. Voice Agent Tool Contract

V1 exposes these tools via a local API or MCP-compatible tool layer:

```typescript
list_projects(): ProjectSummary[]
open_project(project_id: string): ProjectBriefing
get_project_status(project_id: string): StatusWithFreshness
get_primary_session(project_id: string): SessionRoute
send_to_primary(project_id: string, text: string, mode: 'next_turn'|'steer'): DeliveryReceipt
list_inbox(filter?: { project_id?: string; status?: string }): InboxItem[]
answer_inbox_question(question_id: string, answer: string): DeliveryReceipt
pin_primary(project_id: string, session_id: string): RoutingResult
unpin_primary(project_id: string): RoutingResult
```

`open_project` returns a compact, token-budgeted briefing and sets conversation-level active project state. Switching projects must remove or isolate stale prior-project context; do not merely keep appending full briefs. The voice agent must state if a result is stale, queued, or unverified and should not claim work started until it receives confirmed evidence.

### Example interaction

User: “Switch to the desktop agent project.”  
Bridge: `open_project(desktop-agent)` → short briefing, freshness, primary-session metadata.  
Voice assistant: “Codex last confirmed it was implementing tool registration. It has one question about remote authentication.”  
User: “Use OAuth. Tell it to proceed.”  
Bridge: `answer_inbox_question(question-17, ...)` or `send_to_primary(...)` → authenticated queued/delivered receipt.  
Voice assistant: “I've queued your decision for the primary Codex session; it hasn't acknowledged it yet.”

## 14. UX Requirements

- Continuous conversational session independent of the underlying projects.
- Ability to say “open/switch to [project],” “what's happening?”, “tell it [instruction],” and “what's waiting on me?”
- Display active project, selected primary provider/session, connection state, briefing freshness, and message delivery state.
- Surface ambiguity only when it affects safety or correctness; for ordinary read-only briefings use the best current snapshot and label uncertainty.
- Basic settings page/CLI to register repos, select primary session, view queue/inbox, inspect sync health, and configure permissions.
- Text-mode interface exercising identical tools for testing when no microphone or real-time model is available.

## 15. Security, Privacy, and Reliability

- Local-first storage and loopback/OS-local authenticated transport by default; no inbound Internet listener.
- Restrict bridge clients to allowed projects and actions; paths canonicalized to avoid traversal and symlink confusion.
- Treat file contents, transcripts, and tool output as untrusted context rather than privileged instructions.
- Never accept bridge origin claims from plain-text prompts; never bypass provider approvals.
- Minimize transcript retention; redact credentials from briefings and logs; document retention and delete controls.
- Crash-safe queue, atomic file writes, durable event offsets, and startup recovery.
- Structured telemetry: delivery latency, event-to-brief lag, missing events, ambiguous sessions, rejected unsafe sends.
- No false-positive success announcements. All actions have traceable receipts.

## 16. V1 Acceptance Criteria

1. **Discovery:** Register two local test repositories; discover at least two saved sessions for one project where supported; associate each with correct canonical repository/worktree.
2. **Primary selection:** Correctly select a pinned primary. Without pin, prefer sole verified connected session; with conflicting live writers, prevent mutating delivery.
3. **Voice/context switch:** In a single text-mode or real-time conversation, open Project A, receive a short brief, switch to Project B, and answer without mixing project state.
4. **Freshness:** Plan/task/commit/stop events update durable state and eventually regenerate `VOICE.md`; no unnecessary rewrite on unchanged events.
5. **Event integrity:** Simulate missed hooks or process crash and verify state is `unverified/lagging`, then reconciliation repairs it.
6. **Safe delivery:** For an adapter-supported bridge-controlled live session, deliver a message to the same session ID; observe accepted, delivered, and completed states accurately.
7. **Busy session:** Queue a message during an active turn; do not create a new agent or introduce concurrent writes.
8. **Unattachable session:** When a saved external session cannot be controlled safely, voice UI says so and does not start a competing writable process.
9. **Inbox:** Two projects publish distinct user questions; `list_inbox` shows both; answer routes to correct session and stays unresolved until acknowledged.
10. **Security:** Spoofed `origin=voice_bridge` text cannot bypass routing authentication or provider permissions.
11. **Operational:** Restart bridge mid-queue and demonstrate deduplicated recovery with clear delivery status.
12. **Documentation:** Installation, compatibility matrix, safety limitations, CLI/test-mode usage, troubleshooting, and uninstallation are documented.

## 17. Implementation Plan

### Milestone 0 — Feasibility spike (mandatory before final adapter architecture)

- Inventory actual installed Codex and Claude Code versions and surfaces (CLI, Desktop, IDE).
- Test session discovery, live attachment, message delivery, busy-turn queueing/steering, and lifecycle events against each surface.
- Produce a capability matrix: `discover`, `inspect`, `live_attach`, `next_turn`, `steer`, `events`, `answer_question`.
- Record unsupported routes and select initial **bridge-controlled** reference path. Do not pretend historical session resume equals live attachment.

**Exit gate:** at least one demonstrably safe provider path to an existing bridge-controlled working session; failures categorized with fallbacks.

### Milestone 1 — Local foundation

Build SQLite schema, project discovery/configuration, session registry, primary resolver, authenticated local API, CLI status/debug views, and provider adapter interface. Add unit tests for multi-session and ambiguous routing.

### Milestone 2 — Briefing synchronization

Build event ingestion, hook installation, reconciliation, durable watermarks, atomic `VOICE.md` projection, freshness states, and stop-hook fallback. Add crash/missed-event tests.

### Milestone 3 — Messaging and inbox

Implement queue, receipts, workspace-ownership policy, provider-supported delivery, question lifecycle, and cross-project inbox. Prove no duplicate writer scenario.

### Milestone 4 — Voice interaction and end-to-end tests

Expose tools to real-time conversational agent, add active-project switching and compact context loading, test verbal cross-project workflows, document limitations, and run the full acceptance suite.

## 18. V2 and V3 Roadmap

**V2:** richer agent progress and event subscription; explicit voice command to pin/change primary; proactive notifications; background context/reasoning assistant; broader provider support; voice identity selection (not authorization); better simultaneous project coordination; optional multi-device sync design.

**V3:** browse and speak with historical/secondary sessions; inspect differences between sessions; read-only query of archived sessions; change primary by voice with richer policy; multi-user/team support; cross-machine routing; additional agent types beyond code; advanced delegation and multi-agent workflows.

## 19. Open Decisions and Defaults

These should not block implementation; the proposed defaults are acceptable for V1 unless feasibility testing forces a change.

| Decision | V1 default |
|---|---|
| Packaging | Standalone local daemon + CLI + API; optional Electron integration |
| State persistence | SQLite in local application data folder |
| Repo briefing | `VOICE.md` generated, generally uncommitted by default; configurable |
| Native agent support | Codex first; Claude Code second, subject to capability spike |
| Primary session | User pin, otherwise sole connected session, then most recent saved for read-only |
| Inability to attach | Report unavailable; never silently spawn another writer |
| Voice model | Pluggable provider adapter; text harness is acceptance-test baseline |
| Auto-send | Disabled for mutating actions unless explicit conversational user request |
| Summary size | Default maximum 800 model tokens |
| Sync | Event-driven plus periodic on-open/startup reconciliation |
| Network | Local transport only |

## 20. Implementation Instructions for the Coding Agent

Start with **Milestone 0** before selecting final native-control implementations. Inspect the actual provider versions and record capabilities, then scaffold a modular TypeScript implementation suitable for a Node/Electron environment. Keep the realtime model/provider abstracted behind an interface. Build text-mode tools and rigorous session-safety tests before voice UX. Do not create mock functionality that appears to control a live session when it cannot; return an explicit unsupported capability error instead. Preserve existing `AGENTS.md` / `CLAUDE.md` content and do not install hooks without user consent. Implement incremental milestones, run tests, and document deviations from this PRD.

## Appendix A — Proposed Data Entities

`Project(id, canonical_path, worktree_id, display_name, config, created_at)`  
`AgentSession(id, provider, native_session_id, project_id, worktree_id, observed_state, last_activity_at, connection_evidence, capabilities)`  
`PrimaryPin(project_id, session_id, pinned_at)`  
`AgentEvent(id, project_id, session_id, source, source_sequence, type, payload, observed_at)`  
`Briefing(project_id, source_watermark, generated_at, freshness, content_hash, summary)`  
`AgentMessage(id, project_id, session_id, mode, authenticated_actor, body, state, idempotency_key, created_at)`  
`InboxItem(id, project_id, session_id, source_event_id, kind, question, state, resolution_message_id)`  
`WorkspaceLease(worktree_id, owner_session_id, heartbeat_at, enforceability, expires_at)`

## Appendix B — Reference Documentation

- [R1] OpenAI Codex App Server: https://learn.chatgpt.com/docs/app-server
- [R2] Anthropic Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-usage
- [R3] Anthropic Claude Code hooks reference: https://code.claude.com/docs/en/hooks

*Provider APIs, hooks, and app integration capabilities change. Milestone 0 must verify compatibility against the deployed versions, rather than treating cited documentation as a guarantee of live control for every session surface.*
