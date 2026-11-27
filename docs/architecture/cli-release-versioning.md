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

**The installation is the stable unit; a release is replaceable (#4592).**
`NESSION_HOME`, both TOML configs, the Agent identity/credentials and the
compatible durable state belong to the *installation*, not to one release.
Upgrading Current retains them in place; an archive receives independent
copies. The installation's **client connection context** (#4682) —
`client-config.toml`, its mutation lock and the private credential fallback —
is likewise installation-owned: it is retained in place and **never** copied
into an archive (see [Installation client context](#installation-client-context)).
The superseded rule "the new Current starts with built-in defaults"
(#3173/#3232) no longer holds — single-active, archive isolation and
transaction recovery do.

## Layout

```text
<NESSION_HOME>/
  (managed install dir, e.g. ~/.local/bin)   # Current binaries
  agent-config.toml                           # installation configuration (retained)
  server-config.toml
  client-config.toml                          # installation client context (#4682,
  client-config.lock                          #  retained, never archived)
  client-credentials/                         # private credential fallback (0700)
  agent/                                      # installation durable state (retained)
  server/
  versions/
    <semver>/
      bin/nession  bin/nession-agent  bin/nession-server
      manifest.json                           # snapshot coverage record
      agent-config.toml  server-config.toml   # independent copies
      agent/  server/                         # bounded snapshot subset
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
`scripts/install.sh --version <version>` converge on one rule. The script
delegates to the installed CLI **only when it advertises the versioned upgrade
contract** (`nession --upgrade-contract` prints `nession-upgrade-v1 <release>`);
`install --help` alone is not proof, because an old CLI can support `install`
and still run the superseded move-based transaction:

- **target == Current**: idempotent no-op; no network access is needed and no
  user data is touched.
- **target < Current**: install only into `versions/<target>/`. Current, its
  configuration/state and every other archive are unchanged. Reinstalling a
  complete archive is a no-op; an existing archive's configuration and data are
  never overwritten.
- **target > Current**: download and SHA256-verify the release, then run the
  retention transaction below. Current keeps both configs, the Agent identity
  and the compatible durable state at their existing paths; the archive gets
  independent copies. New config fields resolve through the **target** binary's
  defaults; a config the target cannot losslessly parse and validate refuses
  the upgrade before any mutation. No identity is ever auto-minted by an
  upgrade.

Versions are strict SemVer; a leading `v` is accepted and normalized. Invalid
or unavailable releases are rejected before mutation.

### Retention transaction and recovery

A release archive is assembled in a private `versions/.stage-*` directory and
published by **one atomic rename**. A final `versions/<semver>` directory is
therefore always complete; `versions::is_complete_archive` requires all three
binaries before any archive is listed or reused (#3232 F4).

Preflight (before any mutation) inventories the durable state and fails closed
on: active mount points under the home, symlinks escaping the home,
insufficient space for the independent snapshot, a target that does not
advertise the upgrade contract, or a target that cannot parse/validate the
retained configs. The config proof is the **target binary's own** hidden probe
`nession --upgrade-config-check <agent|server> <path>` run on staged copies —
pure (no writes, no identity minting) and sanitized (parse failures report a
location, never config values).

The snapshot is a bounded subset, never a rename of Current: both configs are
byte-copied; the Agent identity, sessions, Claude/ENV bindings and Server ENV
records are copied; the Server DB is captured through the SQLite backup API
(WAL accounted for); content-addressed stores (image blobs, EROFS) are
**referenced, not copied**; caches, logs and runtime files are omitted; the
installation client context (#4682) is recognized, retained in place and never
archived; unknown top-level entries are preserved in place and recorded as
coverage gaps. Every
archive carries `manifest.json` recording binary digests, config coverage,
per-entry state digests, references, gaps, external dependencies and whether
the snapshot is state-complete. A failed DB backup is a recorded gap, never a
fake complete snapshot.

Every mutating phase is recorded in `<NESSION_HOME>/.install-transaction.json`
(schema 2, mode 0600) before it starts. The journal names the release homes,
the exact old/new binary SHA256 digests, the config **preimage fingerprints**
and the transaction PID. Current's config/state are never moved, so recovery
verifies preimages instead of restoring anything. Phases:

```text
staging -> snapshot -> archive-committed -> binary-swap -> committed
```

Recovery runs before any command reads Current (including `version list`) and
under the lifecycle lock, so an active install is skipped rather than raced:

- `staging`: remove the staging directory; Current was untouched.
- `snapshot` / `archive-committed`: verify the config preimages, restore all
  three binaries from the archive (or staging before the rename), remove the
  uncommitted archive.
- `binary-swap`: commit forward **only** when all three installed binaries
  match the journal's new digests **and** the published archive carries its
  manifest — three binary digests alone never decide a commit. Anything mixed
  is rolled back from the archive.
- A changed config preimage is an external writer: recovery fails closed and
  never overwrites the user's writes. An unreadable journal, an unknown schema
  or a missing archive copy is **fail-stop**: the journal is retained and every
  later command reports the exact repair instead of starting a half-installed
  release. Recovery errors are never swallowed.

Schema-1 journals (the superseded move-based transaction) keep their own
compatible recovery owner: moved entries are restored to Current by the old
algorithm, or the recovery refuses with precise instructions. They are never
guessed by the schema-2 path.

### First safe upgrade and the installer bridge

`scripts/install.sh` verifies the release SHA256 before extracting and before
publishing anything. When the existing CLI does not advertise the upgrade
contract — **including CLIs that support `install` but run the move-based
transaction** — the script downloads and hash-verifies the target, checks the
target's own contract, and hands the upgrade to the verified **target**
transaction with the actual installed directory/version. The old CLI's own
install/update code never runs. A fresh machine still bootstraps the selected
binaries from staging in one publication step. Neither path stops a running
daemon. Bootstrap curl/wget calls are bounded (connect/total/idle budgets and
bounded retries).

**Limitation:** an already-released old CLI's direct `nession update` cannot be
retroactively changed by a new target artifact. Affected users must use the
updated official installer (`curl -fsSL
https://raw.githubusercontent.com/BestNathan/nession/main/scripts/install.sh |
sh -s -- --version <target>`) as the supported first hop; release notes route
them there.

### Recovery for already-affected installations

Installations whose configuration/identity was moved by the superseded
transaction recover through two bounded commands:

- `nession version inspect <version>` — read-only: binary availability,
  snapshot coverage, historical runtime eligibility, and a non-secret recovery
  plan (entry names and statuses only, never contents).
- `nession version recover <version>` — copies **only missing** config/identity
  entries from the explicitly selected, provenance-verified archive back into
  Current. It refuses while an Agent/Server is live or the lifecycle lock is
  busy; any entry that exists at Current with different bytes is a conflict
  that refuses the whole run (nothing is copied); identical entries are
  skipped, so re-running is idempotent. Business data (Server DB, sessions,
  workspaces) is never auto-restored here — use the owner's backup/restore path
  with explicit reconciliation.

In-flight transaction rollback is automatic; intentional rollback after a
commit is this explicit operator recovery. Post-commit writes are never
discarded automatically.

### Archived server paths

`config server init` persists the *generated* absolute defaults for `db_path`,
`image_blob_dir` and `image_build_dir`. Only the **archive's copy** of the
server config is rewritten, and only for paths whose data was actually
captured as an independent snapshot (#4592 coverage honesty):

- a generated default whose data was captured moves to the archived home's
  default, so an archived Server opens `versions/<old>/server/...`;
- a generated default whose data was **not** captured (a failed DB backup, a
  referenced-not-copied CAS store) stays verbatim and is recorded as an
  external dependency — the archive must not claim a copy it does not have;
- explicit absolute paths outside the Current home are the operator's external
  declaration and stay verbatim (also recorded as dependencies);
- a relative, empty, or Current-home path that is not a generated default
  cannot be proven safe, so the archive is refused with an actionable
  diagnostic instead of silently sharing Current's live data;
- an unreadable or non-string field also refuses the archive.

Current's own config is never rewritten by the upgrade.

A Current replacement is **refused while an Agent or Server is live**: a
consistent snapshot of the configuration and durable state cannot be proven
under a live writer, and install never stops or restarts a service implicitly.
Installing an older release into an archive is unaffected.

### Upgrade transport policy

All three upgrade entries share one bounded transfer policy
(`update/policy.rs`): connect 10s, metadata 30s, asset no-progress 60s, total
transfer 30min, lifecycle-lock wait 30s, initial attempt + 3 retries with
jittered exponential backoff. CLI flags override validated env overrides,
which override the defaults; out-of-range values are refused. A valid
`Retry-After` is honored only inside the remaining budget. Metadata and the
background check never inherit the long download budget.

Downloads stream into a private partial with bounded memory; a strong
validator (weak ETags are rejected) binds `Range`/`If-Range` resume to the
exact URL, and a changed validator, wrong `Content-Range` or 416 restarts
safely from zero. Truncation, tampering or a SHA256 mismatch discards the
artifact — Current stays complete. SIGINT/SIGTERM cancel cooperatively at safe
boundaries; SIGKILL leaves the journal for the next invocation's recovery.
Progress reports phase, bytes (monotonic, resume-aware, no fake percentages
for unknown lengths) and elapsed time; failures report phase, category,
retryability, Current state and the next action, with credentials and signed
URLs redacted. The executable contract lives in
`update/{policy,progress,download,github}.rs` and `lifecycle/lock.rs`.

## Selection

```text
nession +0.35.0 sessions list              # highest priority
NESSION_VERSION=0.35.0 nession agent status
nession version list                       # Current / Archived / Running
nession version inspect 0.35.0             # read-only archive diagnostics
nession version recover 0.35.0             # explicit missing-entry recovery
nession --version                          # Current CLI release
```

Precedence is `+<version>` > `NESSION_VERSION` > Current. The dispatcher runs
before command parsing, resolves the selected version and `exec`s
`versions/<version>/bin/nession` with `NESSION_HOME=<version home>`. It marks
the child so an archived CLI cannot re-dispatch, and disables the background
update check for that child. `version` and `install`/`update` always run on
Current; `install`/`update` reject a non-Current selector instead of silently
writing into an archived home.

### Historical state-coverage gate

Binary availability, snapshot coverage and safe historical runtime eligibility
are three different facts (#4592 §5). Before `exec`, the Current dispatcher
refuses **data-touching** commands (agent/server start/restart/stop and service
registration, sessions create/attach/kill, config init/set) on an archive
whose independent state ownership is unproven: a binary-only or legacy archive
without `manifest.json`, or a manifest recording gaps/external dependencies.
Read-only inspection (`status`, `logs`, `list`, `show`, `agents list`) stays
available on every complete archive. The gate applies to legacy versions too;
the supported entrypoint is the Current dispatcher — arbitrary direct
invocation of old binaries is not sandboxed. Existing archives remain
untouched and inspectable; there is no automatic DB downgrade and no implicit
promotion of a historical release.

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

### Read-only log selection

`nession +<version> agent|server logs` follows the same selection rule but is
read-only. A selected release reads its own `<version home>/…/logs`; a release
that predates the logs command is read directly by the Current CLI, which
exits with a diagnostic and never substitutes Current's history. Logs reads
skip install-transaction recovery and the background update check, and report
a pending recovery journal instead of mutating anything. See
[cli-logs.md](cli-logs.md).

### Installation client context

The client connection store (#4682) is installation-owned live state, distinct
from both the daemon configs and the archive's snapshotted state. Upgrade,
failed/interrupt-recovered upgrade and archive-only install preserve the
selection, metadata bytes and credential references; the transaction never
moves or copies them, and `version recover` never restores them (they are not
archive entries). The full profile contract lives in
[cli-connection-profiles.md](cli-connection-profiles.md).

Archived dispatch rebinds `NESSION_HOME` to the version home, so an archive
does not see the installation's client store by default. The dispatcher
bridges that gap without mixing the two ownerships:

- It probes `<archive>/bin/nession --client-profile-contract`. A profile-aware
  release prints `nession-client-profile-v1 <release>` and receives
  `NESSION_CLIENT_HOME=<installation home>` (captured before the rebind). The
  archive consumes the client context **read-only** after schema validation:
  remote commands resolve the live selection/credential, while every client
  mutation and the first-use bootstrap are refused on the dispatched archive.
- A release without the contract keeps legacy explicit URL/env behavior. The
  dispatcher refuses — with actionable version/explicit-target guidance — any
  `profile` command, a `--profile` flag, `NESSION_PROFILE`, or an implicit
  remote invocation while a live client store exists, so a selected profile is
  never silently reinterpreted as localhost. An explicit `--server-url`
  flag/env invocation still dispatches normally.
- An unknown client-store schema is refused read-only; credentials are never
  duplicated into archives, and the lifecycle/state-coverage gates above are
  unchanged.

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

The installation retains its configuration, identity and compatible durable
state across upgrades; the archive holds independent copies, never the moved
originals. The Server DB schema evolves through the Server's own migrations at
startup — there is no implicit database downgrade. An archived release
selected later uses its own snapshotted configuration/state through its version
home (only when the coverage gate proves it safe), while process discovery
still uses the shared runtime directory.

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
  run read-only commands, but cross-release lifecycle commands are refused
  (see **Shared lifecycle contract**) and data-touching commands additionally
  require proven state coverage (see **Historical state-coverage gate**). This
  is the supported compatibility boundary, not an assumption that old binaries
  behave like new ones.
- Selecting the same version as the running entry binary executes the entry
  binary (the equivalence is by release, not by archive path). `version list`
  still shows an otherwise-identical archive.
- tmux Sessions live on the Agent's tmux socket under the stable home and
  survive an upgrade; their instance metadata is retained at Current and
  snapshotted into the archive. A Session is reattached only when instance and
  execution ownership are compatible; an incompatible owner blocks recovery
  explicitly rather than recreating or silently taking over the Session.
  Stopping the Agent (the upgrade preflight) is the operator's explicit
  boundary; the upgrade never restarts a process implicitly.
- No `lifecycle.lock`-based multi-instance or grouped Agent/Server switching is
  defined here.

Implementation owners: `crates/nession-cli/src/versions/mod.rs`,
`crates/nession-cli/src/update/{install,transaction,release_config,snapshot,policy,progress,download,github,config_check}.rs`,
`crates/nession-cli/src/lifecycle/{lock,release,pid_file,terminate}.rs`,
`crates/nession-cli/src/commands/install.rs`,
`crates/nession-cli/src/commands/version/`,
`crates/nession-cli/src/commands/{agent,server}/`,
`crates/nession-cli/src/service/mod.rs`, and `scripts/install.sh`. The
installation client context (#4682) is owned by
`crates/nession-cli/src/profile/`, `crates/nession-cli/src/connection/mod.rs`
and `crates/nession-common/src/paths.rs`; see
[cli-connection-profiles.md](cli-connection-profiles.md).
