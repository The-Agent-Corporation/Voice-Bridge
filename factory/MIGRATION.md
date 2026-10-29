# Upgrading the factory

Upgrade an installed factory by pulling the factory repository and rerunning
`python <factory>/bin/factory.py init` from the application repository.

- `init` installs the files in `template/` and the Archon source pinned in
  `factory/pack.json`, then validates that source.
- Files you write for your project are never overwritten: `MISSION.md`,
  `harness/END-TO-END.md`, `harness/harness.config.json`,
  `.factory/holdout/HOLDOUT.md`, and the other project files listed in the installer.
- An installed factory file you changed is copied to `.factory/backup/` before
  the new version replaces it. Repeated upgrades keep numbered copies.
- Run `python factory/consumer.py doctor` afterwards. It checks the pinned source
  and that every shared workflow validates.

What the factory owns, and what Archon owns:

- **Archon** owns every workflow and agent: triage, delivery, review,
  validation, runtime and holdout verification, repair, discoveries, merging,
  deployment, and admission through native triggers.
- **The factory** owns your project's context files, the installation, and the
  thin consumer that invokes Archon and shows its state. Its OS timer wrappers enforce
  STOP/PAUSE before calling the native trigger and continuation commands.
- **Runtime scenarios** are project inputs, and must exercise fresh environments
  running the actual candidate.

If you scheduled the factory, rerun `python factory/consumer.py schedule install`
after an upgrade to preview the refreshed binding and timer, then add `--apply` to install.
Preview prints the proposed binding and timer without writing either or changing loaded jobs.
Only `--apply` persists the new `.factory/trigger.json` and installs the timer.
Preserve the existing `.factory/trigger.json` and LaunchAgent files until migration finishes.

Applied installation holds the same launch lock as `schedule fire` and persists
`.factory/schedule-install-pending.json` before replacing the binding. If binding
durability, scheduler updates, or installation cleanup fail or are interrupted,
the guard blocks subsequent scheduled launches while existing runs may still wake.
The binding may already contain the new configuration; failure is not a rollback.
Inspect the error and preview the plan, then rerun `schedule install --apply` to
finish installation. Only a successful install removes the guard. Do not delete it
to bypass a failed install. STOP and PAUSE remain unchanged. This protection requires
the updated consumer: legacy native timers and direct native commands bypass it and
must follow the supervised migration procedure below.

## macOS timer migration

1. Run `python factory/consumer.py halt` before upgrading the installed consumer.
   Older native timers bypassed this marker; unload their exact LaunchAgent before doing
   a supervised migration if a tick must not start during the upgrade.
2. Run `python factory/consumer.py schedule install --interval 600` to inspect the plan.
3. Run the same command with `--apply`. It unloads and deletes the old native trigger
   matching this project's configuration path, and the native wake job matching this
   Archon home, before installing the two consumer jobs. This matching uses the old
   plist, so a renamed/transferred repository's previous hashed identity is removed too.
4. Verify the loaded jobs invoke `factory/consumer.py schedule fire` and `schedule wake`.
   With STOP set, both should leave Archon's run and receipt counts unchanged. Set
   `pause`, then `unhalt`, to allow supervised explicit laps and guarded CI wakes while
   withholding automatic new laps. After the supervised lap succeeds, `unpause` enables intake.

The fire interval is configurable; the separate wake interval remains 60 seconds. Neither
job fires at installation. Logs go to `.factory/schedule.log`. Reinstallation replaces
the same path-based labels, and `schedule remove --apply` removes both consumer jobs.

Native wake is global to an Archon home. The consumer conservatively withholds it if any
registered project's shared root has STOP, or refuses it if the local SQLite registry
cannot be verified. This also delays other projects' continuations. PostgreSQL registry
configurations require a scoped native wake implementation before enabling this scheduler.
Do not retain another unguarded native wake job or assume server/manual native commands
honor consumer STOP. Resolve project-scoped native waking before broad multi-project rollout.

The guard must inspect the same environment files as the pinned native CLI:
`<ARCHON_HOME>/.env`, then `<project>/.archon/.env`. Ordinary project `.env` files
are stripped by native CLI boot and do not select Archon's registry. Scheduled
fire and wake refuse registry/home redirect assignments in either Archon-owned
file (`DATABASE_URL`, `ARCHON_HOME`, `HOME`, `USERPROFILE`, `ARCHON_DOCKER`, or
`WORKSPACE_PATH`), including empty assignments that could clear a pinned home.
Inherited database or Docker/workspace selectors are also refused. Refusal names
only the key and file, never its value. This conservative boundary prevents the
Python guard from checking one SQLite registry while native Archon uses another.

The 2026-10-27 Voice-Bridge environment audit found none of these redirect keys
in its user-scope Archon env file, and no project-scope Archon env file. This gap
did not affect that observed pilot configuration; install the corrected consumer
before adding any project-specific registry configuration.

## Per-invocation runtime scenarios

A lifecycle schedule can opt into caller-owned bindings with a `runtime_binding`
object in `.factory/schedule.json`:

```json
{
  "runtime_binding": {
    "helper": "/absolute/operator/bindings.py",
    "invocation_root": "/absolute/private/invocations"
  }
}
```

The existing schedule must select `archon-lifecycle` with `parallel: 1`. The helper
is trusted operator code. The consumer calls it as
`python bindings.py create --project-root <project> --output <new-uuid-directory>`.
It must exclusively create that directory, return a JSON object with `runtime`,
`holdout` and `invocation` (a UUID), and place separate private scenario files
inside the new directory. Creation prepares input files only; it must not launch
fixtures or coding. Native setup later binds the delivered checkout. The helper
must reject unsafe repeated setup rather than silently selecting another fixture.

Each scheduled admission gets a new trigger copy under its invocation directory;
the installed trigger, merge policy, required checks and worktree policy are
preserved. Its native `discoveryCwd` selects the verified immutable source pin;
an old binding without that field is upgraded in the per-invocation copy, and a
foreign discovery root is refused. The helper and scenario digests, source revision and exact native receipt
are retained in `dispatch.json` there, with the latest admission journal at
`<invocation_root>/dispatch.json`. The invocation root must be private to the current
user (mode 700 on macOS/Linux); scenario and journal files use mode 600.

An interrupted dispatch or missing/ambiguous native receipt blocks further bound
admissions. Do not delete its journal or fire the same trigger again: native
`trigger fire` creates a new receipt each time and is not an idempotent retry.
Inspect native `trigger list` / `trigger inspect` output. After locating the exact
receipt, `python factory/consumer.py schedule reconcile-runtime --receipt <id>`
verifies the unchanged trigger digest, project, source revision and complete native
binding, then records its result without launching anything. Pending preparations
remain blocked and require native owner-aware recovery. Resume existing workflows
with their native IDs and existing input paths; do not generate replacement inputs
for a continuation. Explicit `factory run` remains pass-through and requires the
operator to supply its own fresh bound scenarios.
