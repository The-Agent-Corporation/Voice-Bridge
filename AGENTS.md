# Agent instructions

Read MISSION.md, FACTORY_RULES.md and engineering.md before working here. This file adds Aaron's stop-point rule on top of them.

## Stop points (Aaron, 2026-11-06)

Aaron tests the work at fixed stop points so it reaches a finish instead of growing forever. A stop point is an open issue titled "STOP …" and labelled `stop-point` and `needs-human`. These rules apply to every agent and tool that plans, files or does work in this repo.

- Before you start, file or expand any work, list the open `stop-point` issues and read them.
- Do not start or file work that comes after an open stop point. Work that comes after a stop lists it under `Depends on:`.
- If you find something that would come after a stop, add it as one line to that stop's **Later** list. Do not open a new issue for it and do not start it.
- Only Aaron closes a stop point. Never close, relabel or reword one. The only edit you may make is adding a line to its Later list.
- When the last open issue before a stop is done, stop and say the stop point is ready for Aaron to test.
