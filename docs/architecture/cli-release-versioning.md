# CLI release versioning and single-active daemons

Nession keeps multiple installed releases but runs at most one Agent and one
Server. There is deliberately **no `version use`**, no working-directory
override and no per-project version file. Version selection is a property of
one command; the installation's **Current** release changes only through
`install`/`update` (#3173).

## Three version concepts

| Concept | Meaning |
| --- | --- |
| **Current** | The release in the managed install directory. It runs a command when no selector is given. |
| **Selected** | The release named by `nession +<version> …` or `NESSION_VERSION=<version>` for this command only. Selecting never changes Current. |
| **Running** | The release recorded by the live Agent/Server process in the shared OS runtime identity. It may differ from Current. |

A release is a coherent unit: `nession`, `nession-agent` and `nession-server`
plus that release's configuration and durable state. Binaries are never mixed
from different releases.

## Layout

```text
<NESSION_HOME>/
  (managed install dir, e.g. ~/.local/bin)   # Current binaries
  agent-config.toml                           # Current durable configuration
  server-config.toml
  agent/                                      # Current durable state
  server/
  versions/
    <semver>/
      bin/nession  bin/nession-agent  bin/nession-server
      agent-config.toml  server-config.toml
      agent/  server/
```

The managed install directory is the directory of the running CLI unless
`NESSION_INSTALL_DIR` overrides it (used by `scripts/install.sh` and isolated
tests). Archived releases live under `<NESSION_HOME>/versions/<semver>/` and run
with `NESSION_HOME=<that version home>`. Process state is **not** versioned: PID
files and readiness markers stay in the shared OS runtime directory from
`docs/architecture/runtime-directories.md` (#3155), so every release observes
the same live process.

## Install and archive

`nession install <version>`, `nession update [--version <version>]` and
`scripts/install.sh --version <version>` converge on one rule (the script
delegates to the installed CLI once it supports `install`):

- **target == Current**: idempotent no-op; no network access is needed and no
  user data is touched.
- **target < Current**: install only into `versions/<target>/`. Current, its
  configuration/state and every other archive are unchanged. Reinstalling a
  complete archive is a no-op; an existing archive's configuration and data are
  never overwritten.
- **target > Current**: download and SHA256-verify the release, then archive
  Current's three binaries plus `agent-config.toml`, `server-config.toml`,
  `agent/` and `server/` into `versions/<current>/`, and atomically replace the
  managed binaries with the target. The new Current starts with built-in
  defaults (no inherited config/database). On failure the archived files and
  binaries are restored; a partial release is never installed.

Versions are strict SemVer; a leading `v` is accepted and normalized. Invalid
or unavailable releases are rejected before mutation.

A Current replacement is **refused while an Agent or Server is live**. Moving
the configuration and database directories that a running process is using is
not safe, and install never stops or restarts a service implicitly. Installing
an older release into an archive is unaffected.

## Selection

```text
nession +0.35.0 sessions list              # highest priority
NESSION_VERSION=0.35.0 nession agent status
nession version list                       # Current / Archived / Running
nession --version                          # Current CLI release
```

Precedence is `+<version>` > `NESSION_VERSION` > Current. The dispatcher runs
before command parsing, resolves the selected version and `exec`s
`versions/<version>/bin/nession` with `NESSION_HOME=<version home>`. It marks
the child so an archived CLI cannot re-dispatch, and disables the background
update check for that child. `version` and `install`/`update` always run on
Current; `install`/`update` reject a non-Current selector instead of silently
writing into an archived home.

The update-check cache is keyed by the writing release; a cache produced by a
different installed version is ignored. Nothing in selection changes Current.

## Lifecycle: start is idempotent, restart replaces

- `start` on an already-running component reports the live PID and release and
  returns success, regardless of the selected/release version. It never stops,
  restarts or replaces the process.
- `restart` is the only command that replaces a running process: it stops the
  verified process, waits for exit, starts the selected release and waits for
  READY.
- If the **other** component is running a different release (or one that did not
  record a release), start/restart refuses to create a mixed-release
  environment and names the conflict. It never restarts the other component
  implicitly.
- An advisory `lifecycle.lock` in the shared runtime directory serialises
  start/stop/restart and Current-replacing installs across releases. Concurrent
  starts therefore produce one process, while stop/restart still use the
  `pid + started_at + kind` ownership identity (#1016) and never signal a
  reused PID.
- The process identity records the writing release (`version=`), which is what
  `version list` reports as Running, and what the mixed-release check compares
  against.

## State and protocol compatibility

The archive moves configuration and durable state with the release that owns
them; the new Current starts from defaults. There is no implicit database
downgrade or migration. An archived release selected later uses its own archived
configuration/state through its version home, while process discovery still
uses the shared runtime directory.

Protocol compatibility between different releases remains owned by the Protocol
Unit / Contract Version / Manifest Resolver (#678/#963). A matching release
number is not a substitute for protocol negotiation.

## Service managers

Generated systemd user units and launchd LaunchAgents still run the Current
install path with the resolved `--pid-file` and `NESSION_RUNTIME_DIR` from
#3155. An archived release is selectable for CLI commands, not installed as the
service; the service manager is never pointed at an unmanaged second process.

## Limits / when to revisit

- A native boot-time service-manager proof is not provided by the source
  contract tests; a Case that claims it needs a real systemd/launchd runtime.
- Archived releases older than the shared-runtime change (#3155) cannot observe
  a process through the OS runtime directory. Their archive remains usable for
  rollback on a host where their own state is compatible, but cross-release
  process discovery assumes #3155-or-newer releases.
- Selecting the same version as the running entry binary executes the entry
  binary (the equivalence is by release, not by archive path). `version list`
  still shows an otherwise-identical archive.
- tmux Sessions themselves live on the Agent's shared tmux socket and still
  exist after an upgrade; their per-instance metadata is archived with the
  release that owned it. The new Current does not adopt the old Session
  metadata automatically, and a Session whose owning Agent release is archived
  is not silently reattached under a different release. Stopping the Agent (and
  therefore the upgrade's preflight) is the operator's explicit boundary.
- No `lifecycle.lock`-based multi-instance or grouped Agent/Server switching is
  defined here.

Implementation owners: `crates/nession-cli/src/versions/mod.rs`,
`crates/nession-cli/src/update/install.rs`,
`crates/nession-cli/src/lifecycle/{lock,release,pid_file}.rs`,
`crates/nession-cli/src/commands/{install,version}.rs`,
`crates/nession-cli/src/commands/{agent,server}/`, and `scripts/install.sh`.
