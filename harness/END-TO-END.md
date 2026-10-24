# Runtime scenarios

Journeys for VOICE Bridge, taken from docs/PRD.md. The product is not built yet.
These describe the behavior the PRD requires a user to be able to see. Shared
runtime verification owns execution and evidence. Replace nothing here with the
task-service examples the installer shipped.

## Switch projects and hear the right briefing

The value is a briefing the user can trust, for the project they just named, without knowing any session id.

1. Point the bridge at two different local Git repositories.
2. Open the first and ask what is being worked on.
3. Hear a short briefing for that project only: current work, anything blocking, and whether the briefing is current, lagging, or unverified.
4. Say switch to the second project and ask the same question.
5. The answer is about the second project. Nothing from the first project's briefing is mixed in.

**What would make this fail:** the second answer still talks about the first project, the briefing says "working" from a stale file, or the user had to supply a session id to get the briefing.

## Tell the working agent to do something, and hear what really happened

The value is an instruction that reaches the session already doing the work, with an honest queued, delivered, or completed state.

1. With one live bridge-controlled session as the primary, ask the assistant to send a change request to it.
2. Hear that the request was accepted and then delivered to that same session. No new agent process appears.
3. While that session is still busy, send a second instruction.
4. Hear that the second instruction is queued behind the current turn. The project still has one writer.
5. The assistant does not say the queued work has started until a receipt says so.

**What would make this fail:** a second agent is launched, the busy request is reported as delivered immediately, or completion is announced with no receipt.

## A pinned session stays pinned, and an uncontrollable one is refused

The value is that the user, not a recent timestamp, decides the primary session, and a session the bridge cannot safely control does not gain a competing writer.

1. Pin a specific session as primary for a project.
2. Use a different session in that same project.
3. Ask which session is primary. The pin has not moved. If the pinned session is currently unavailable, the answer says so and still names the pin.
4. Ask the assistant to send an instruction to a saved session that has no verified way to receive messages.
5. Hear a clear refusal. No new process starts writing in that project. The request is queued only if the user agreed to queue it.

**What would make this fail:** the pin changes because another session was used more recently, a refusal is followed by a new writable agent, or the assistant says the message was sent.

## Who needs me, across two projects

The value is one answer that lists every project waiting on the user, and a reply that goes back to the right session only.

1. Two projects each have a different open question for the user.
2. Ask which projects need you.
3. Hear both questions, once each, with enough to tell them apart.
4. Answer the first project's question.
5. That answer is routed to the first project's session. The question stays open until that session acknowledges it. The second question is unchanged.

**What would make this fail:** a question is missing, the same question appears twice, the answer goes to the other project, or a question is marked resolved before acknowledgement.
