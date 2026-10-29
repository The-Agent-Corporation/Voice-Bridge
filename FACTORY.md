# Factory operations

This application runs on a pinned Archon SDLC source. See
[factory/MIGRATION.md](factory/MIGRATION.md) for installing and upgrading it.

Shared workflow gates own every decision. Inspect a run's identity and status
before responding to a declared gate.

Project runtime scenarios: `harness/END-TO-END.md`.
Holdout scenarios: `.factory/holdout/HOLDOUT.md`.
Ordinary checks: `python harness/ci.py`.

Record this application's tested source SHA, candidate, run IDs, coverage,
fresh-environment evidence and open integration limits here after testing.

## Runtime qualification

The merge policy requires the actual GitHub check `ci`. Shared runtime regressions
run before the ordinary product checks. The owned-process harness requires
`os.waitid` with `WNOWAIT`: Linux Python 3.12 and macOS Python 3.13 or later
provide this interface. Unsupported hosts refuse before spawning. Windows
fixture qualification is not included in this rollout.

Run `python3 -m unittest discover -s harness -p 'test_*.py' -v` for runtime
regressions and `python3 harness/ci.py` for the ordinary project gates.

Runtime snapshot identity hashes the configured include paths after setup.
Dependency directories outside those includes may be prepared in the snapshot;
setup cannot change included source files without invalidating the candidate.
