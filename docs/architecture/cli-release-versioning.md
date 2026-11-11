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
- **target > Current**: download and SHA256-verify the release, then run the
  archive transaction below. The new Current starts with built-in defaults (no
  inherited config/database).

Versions are strict SemVer; a leading `v` is accepted and normalized. Invalid
or unavailable releases are rejected before mutation.

### Archive transaction and recovery

A release archive is assembled in a private `versions/.stage-*` directory and
published by **one atomic rename**. A final `versions/<semver>` directory is
therefore always complete; `versions::is_complete_archive` requires all three
binaries before any archive is listed or reused (#3232 F4).

Every mutating phase is recorded in `<NESSION_HOME>/.install-transaction.json`
before it starts. The journal names the release homes, the exact old/new binary
SHA256 digests, each configuration/state entry that may move, the original
`server-config.toml` text and the transaction PID. Phases:

```text
staging -> state-move -> archive-committed -> binary-swap -> committed
```

Recovery runs before any command reads Current (including `version list`) and
under the lifecycle lock, so an active install is skipped rather than raced:

- `staging`: remove the staging directory; Current was untouched.
- `state-move` / `archive-committed`: restore all three binaries from the
  archive (or staging before the rename), move configuration/state back, write
  the original config text, remove the uncommitted archive.
- `binary-swap`: if all three installed binaries match the journal's new
  digests, the swap had finished — commit forward and keep the archive.
  Anything mixed is rolled back from the archive.
- An unreadable journal, a missing archive copy, or an entry present at both
  locations is **fail-stop**: the journal is retained and every later command
  reports the exact repair instead of starting a half-installed release.
  Recovery errors are never swallowed.

`scripts/install.sh` verifies the release SHA256 before extracting and before
publishing anything. On a machine whose existing CLI predates `install`, it
hands the first upgrade to the **new** binary's transaction, so the old three
binaries, configuration and durable state are archived instead of overwritten.
A fresh machine still bootstraps the selected binaries from staging in one
publication step. Neither path stops a running daemon.

### Archived server paths

`config server init` persists the *generated* absolute defaults for `db_path`,
`image_blob_dir` and `image_build_dir`. Archiving rewrites exactly those values
to the archived home's defaults so an archived Server opens
`versions/<old>/server/...`, never Current's state (#3232 F1):

- explicit absolute paths outside the Current home are the operator's external
  declaration and stay verbatim;
- a relative, empty, or Current-home path that is not a generated default
  cannot be relocated safely, so the archive is refused with an actionable
  diagnostic instead of silently reading Current data;
- an unreadable or non-string field also refuses the archive.

The transaction restores the exact original config text on rollback.

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

### Shared lifecycle contract

Before dispatching `agent|server start|restart|status|stop` to an archived
release, the dispatcher probes
`<archive>/bin/nession --lifecycle-contract`. A contract-aware release prints
`nession-lifecycle-v1 <its compiled release>`; the probe must report both the
token and the release named by the archive directory. A release that predates
the shared lock, PID identity and single-active gate — or a mislabeled archive —
is refused with a migration hint rather than executed blindly (#3232 F2). The
probe is a normal child process, so a refusal leaves the caller free to print
the diagnostic. Other archived commands are unaffected.

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
- The identity is re-read immediately before a timeout escalates to SIGKILL. A
  process that exited during the grace period, a reused PID, an unreadable
  record, or a record that now names another live PID is never signalled. A
  process that ignored SIGTERM and still owns the record is force-killed as
  before (#3232 F6, `lifecycle/terminate.rs`).
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
service.

**The manager is the lifecycle owner of a registered Agent (#3232 F5).** When
the unit/plist targets the state file this invocation resolved, the CLI
consults the manager before acting:

- `start` reports an already-running managed Agent as an idempotent success; it
  refuses to create an unmanaged process when only the registration exists;
- `restart` and `stop` are refused with the manager command, because
  `Restart=on-failure` / `KeepAlive` would otherwise race the CLI and could
  revive the manager's snapshotted (possibly older) binary;
- commands aimed at a different explicit state file — an isolated runtime — are
  unaffected, as is `status`.

The generated unit/plist marks its **direct child** with
`NESION_MANAGED_AGENT=1`. The guard honors that marker only when the process's
parent is the service manager (systemd/launchd), because tmux Sessions started
by the Agent inherit the variable. Without that distinction the manager's own
foreground start would be refused, or an interactive shell inside a Session
could bypass the ownership guard.

`nession agent uninstall-service` returns the Agent to CLI-managed operation
for future starts and names the manager stop command when a job is still
running. Cross-release switching is done by installing the target as Current
and re-running `install-service` from it.

## Limits / when to revisit

- A native boot-time service-manager proof needs a real, isolated systemd or
  launchd runtime. SC-05 stays Pending when the approved runner cannot provide
  an isolated user/manager lane; a generated unit/plist fixture is not
  evidence.
- Releases older than the shared lifecycle contract can still be archived and
  run non-lifecycle commands, but cross-release lifecycle commands are refused
  (see **Shared lifecycle contract**). This is the supported compatibility
  boundary, not an assumption that old binaries behave like new ones.
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
`crates/nession-cli/src/update/{install,transaction,release_config}.rs`,
`crates/nession-cli/src/lifecycle/{lock,release,pid_file,terminate}.rs`,
`crates/nession-cli/src/commands/{install,version}.rs`,
`crates/nession-cli/src/commands/{agent,server}/`,
`crates/nession-cli/src/service/mod.rs`, and `scripts/install.sh`.
