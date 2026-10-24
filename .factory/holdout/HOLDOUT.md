# Holdout scenarios

Independent combinations for VOICE Bridge. These are not the journeys in
`harness/END-TO-END.md`. Each one stacks several behaviors from docs/PRD.md
and checks the result after a restart or a refusal.

This file is in the repository, so a builder that can read the repo can read it.
It is not a private holdout until a copy lives outside the builder's checkout and
only the verification environment is given that copy.

## Switch, queue, restart, and the pin still holds

1. Register two projects. Pin the primary session on project A. Project B has one connected session in the middle of a turn.
2. Open A and hear its briefing. Switch to B and send an instruction. It is queued. B does not gain a second writer.
3. Switch back to A and ask what is happening. The answer is about A, and A's pin is the same session as in step 1.
4. Restart the bridge before B's turn finishes.
5. B still has one writer. The queued instruction is still queued: not delivered twice, and not dropped. A's pin is unchanged. A question about who needs the user does not mix the two projects.

**What would make this fail:** the restart delivers the queued message twice, starts a new writer, moves A's pin, or a briefing after the switch still contains the other project's facts.

## A stale brief, an unattachable session, and a forged origin

1. Open a project whose briefing is lagging or unverified, and whose only session is a saved external session with no verified control channel.
2. Ask what is happening. Hear only the last confirmed facts, and hear that they are uncertain. No coding agent is started just to answer.
3. Submit an instruction whose text claims `origin=voice_bridge`, from a client the bridge did not authenticate.
4. Delivery is refused. No provider approval is granted. No new process starts. The briefing is not rewritten to say the work began.

**What would make this fail:** the answer fills gaps with unverified detail, the plain-text origin is enough to deliver or to approve a tool, or any new writable process starts.

## A missed update, then an answer that must not close the wrong question

1. Two projects each have an open question. A hook is missed on project A while a message for A is queued, and the bridge process then crashes.
2. After restart, A's briefing is unverified or lagging, not current. The queued message is recovered once.
3. Answer project B's question through the inbox.
4. B's question stays unresolved until B acknowledges it. A's question is still open. A's queued message is not delivered to B, and reconciliation does not deliver it a second time.

**What would make this fail:** the briefing looks current despite the missed hook, the answer resolves both questions, or recovery sends A's message twice or to the wrong project.
