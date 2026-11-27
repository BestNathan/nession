---
title: "Nession CLI release versioning and single-active daemons"
description: "Current/Selected/Running release semantics, the installation as the stable unit retained across upgrades, independent archive snapshots with coverage manifests, the bounded resumable upgrade transport, per-command version dispatch with a state-coverage gate, read-only local log dispatch, and idempotent start with restart-only replacement"
topic: engineering
categories: ["architecture", "cli", "lifecycle", "process", "release", "storage"]
status: verified
created_at: 2026-11-10T15:06:36Z
updated_at: 2026-11-28T01:40:00Z
sources: ["https://github.com/BestNathan/nession/issues/3173", "https://github.com/BestNathan/nession/pull/3214", "https://github.com/BestNathan/nession/blob/3226bd58839daedfa9090eb44bad4cc5c76b56ab/docs/architecture/cli-release-versioning.md", "https://github.com/BestNathan/nession/blob/3226bd58839daedfa9090eb44bad4cc5c76b56ab/crates/nession-cli/src/versions/mod.rs", "https://github.com/BestNathan/nession/blob/3226bd58839daedfa9090eb44bad4cc5c76b56ab/crates/nession-cli/src/update/install.rs", "https://github.com/BestNathan/nession/issues/3232", "https://github.com/BestNathan/nession/pull/3261", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/crates/nession-cli/src/update/transaction.rs", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/crates/nession-cli/src/update/release_config.rs", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/crates/nession-cli/src/versions/mod.rs", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/crates/nession-cli/src/lifecycle/terminate.rs", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/crates/nession-cli/src/service/mod.rs", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/scripts/install.sh", "https://github.com/BestNathan/nession/issues/4592", "https://github.com/BestNathan/nession/blob/d77c57ba32b987d22f674e21dc3353024fccf215/docs/architecture/cli-release-versioning.md", "https://github.com/BestNathan/nession/blob/d77c57ba32b987d22f674e21dc3353024fccf215/crates/nession-cli/src/update/transaction.rs", "https://github.com/BestNathan/nession/blob/d77c57ba32b987d22f674e21dc3353024fccf215/crates/nession-cli/src/update/snapshot.rs", "https://github.com/BestNathan/nession/blob/d77c57ba32b987d22f674e21dc3353024fccf215/crates/nession-cli/src/update/policy.rs", "https://github.com/BestNathan/nession/blob/d77c57ba32b987d22f674e21dc3353024fccf215/crates/nession-cli/src/versions/mod.rs", "https://github.com/BestNathan/nession/blob/d77c57ba32b987d22f674e21dc3353024fccf215/crates/nession-cli/src/commands/version/recover.rs", "https://github.com/BestNathan/nession/blob/d77c57ba32b987d22f674e21dc3353024fccf215/scripts/install.sh", "https://github.com/BestNathan/nession/issues/4600", "https://github.com/BestNathan/nession/pull/4612", "https://github.com/BestNathan/nession/pull/4616", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/docs/architecture/cli-logs.md", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-cli/src/local_logs/mod.rs", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-cli/src/versions/mod.rs", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-cli/src/lifecycle/pid_file.rs", "https://github.com/BestNathan/nession/issues/4660", "https://github.com/BestNathan/nession/blob/9dd5f38bcc224367e6af513d96ce8b042cf0652d/docs/architecture/cli-release-versioning.md", "https://github.com/BestNathan/nession/blob/9dd5f38bcc224367e6af513d96ce8b042cf0652d/crates/nession-cli/src/update/snapshot.rs", "https://github.com/BestNathan/nession/blob/9dd5f38bcc224367e6af513d96ce8b042cf0652d/crates/nession-cli/src/update/install.rs", "https://github.com/BestNathan/nession/blob/9dd5f38bcc224367e6af513d96ce8b042cf0652d/crates/nession-cli/src/versions/mod.rs", "https://github.com/BestNathan/nession/blob/9dd5f38bcc224367e6af513d96ce8b042cf0652d/scripts/install.sh"]
---

# Nession CLI release versioning and single-active daemons

## Decision

Nession keeps multiple installed releases but runs at most one Agent and one
Server. Version selection is per command; it never changes the installation's
**Current** release. There is deliberately no `version use`, no working-directory
override and no per-project version file.

| Concept | Meaning |
| --- | --- |
| **Current** | The release in the managed install directory; runs a command when no selector is given. |
| **Selected** | `nession +<version> …` or `NESSION_VERSION=<version>` for this command only. |
| **Running** | The release recorded by the live Agent/Server process in the shared runtime identity. It may differ from Current. |

**The installation is the stable unit; a release is replaceable (#4592).**
`NESSION_HOME`, both TOML configs, the Agent identity/credentials and the
compatible durable state belong to the *installation*, not to one release.
Upgrading Current retains them in place; an archive under
`<NESSION_HOME>/versions/<semver>/` receives **independent copies** and runs
with that directory as its `NESSION_HOME`. This supersedes the earlier rule
(#3173/#3232) that an upgrade moves config/state into the archive and the new
Current starts from built-in defaults; single-active, archive isolation and
transaction recovery still hold. PID/readiness state stays in the shared OS
runtime directory owned by [Nession runtime directories and daemon process state ownership](nession-runtime-directories-and-daemon-process-state-ownership.md), so every release observes the same live process.

## Install and archive

`nession install <version>`, `nession update [--version]` and
`scripts/install.sh --version` converge:

- target == Current: offline idempotent no-op, no user data touched;
- target < Current: install only into `versions/<target>/`; Current and other
  archives unchanged. Reinstalling a complete archive is a no-op and never
  overwrites its configuration/data;
- target > Current: download and SHA256-verify first, then run the retention
  transaction below. Current keeps both configs, the Agent identity and the
  compatible durable state at their existing paths; the archive gets
  independent copies. New config fields resolve through the **target** binary's
  defaults; a config the target cannot losslessly parse and validate refuses
  the upgrade before any mutation. No identity is ever auto-minted by an
  upgrade.

Versions are strict SemVer with an accepted `v` prefix. A Current replacement is
refused while an Agent or Server is live: a consistent snapshot of the
configuration and durable state cannot be proven under a live writer, and
install never stops or restarts a service implicitly. Installing an older
release into an archive is unaffected.

### Retention transaction and recovery

The archive is assembled in `versions/.stage-*` and published by one atomic
rename; only a directory containing all three binaries is a complete release.
Preflight (before any mutation) fails closed on active mount points under the
home, symlinks escaping the home, insufficient capacity for the independent
snapshot, a target that does not advertise the upgrade contract, or a target
that cannot parse/validate the retained configs. The config proof is the
**target binary's own** hidden probe
`nession --upgrade-config-check <agent|server> <path>` run on staged copies —
pure (no writes, no identity minting) and sanitized (parse failures report a
location, never config values).

The snapshot is a bounded subset, never a rename of Current: both configs are
byte-copied; the Agent identity, sessions, Claude/ENV bindings and Server ENV
records are copied; the Agent's durable inbound credential (`agent-config.token`,
owned by `nession-agent/src/token.rs`, #3440) is captured privately; the Server
DB is captured through the SQLite backup API (WAL accounted for);
content-addressed stores are **referenced, not copied**; caches, logs and
runtime files are omitted; unknown top-level entries are preserved in place and
recorded as unproven coverage. Every archive carries `manifest.json` recording
binary digests, config coverage, per-entry state digests, references, typed
coverage, external dependencies and whether the snapshot is state-complete. A
failed DB backup is a recorded `missing` gap, never a fake complete snapshot.

**Typed coverage (manifest schema 2, #4660).** Each coverage entry has a
component (`agent`/`server`/`shared`) and a class: `captured` (independent
verified copy), `not_applicable` (component/data absent by design, e.g. no
Server DB on an Agent-only install), `excluded` (policy omission retained in
place: logs/runtime, reproducible build workspace, regenerable zsh caches
`.zcompdump*`/`*.zwc`, redundant config backups `<config>.bak*`), `referenced`
(content-addressed store; an **empty** store is safe, a **nonempty** one needs
pin/retention or verified independent ownership — never assumed safe),
`missing` (a required capture failed) or `unknown` (unproven ownership, incl.
user history/config). Ownership is classified by proven provenance, not
directory existence: the Agent token is a known non-regenerable credential
(captured privately, never exposed), a `<config>.bak*` sibling is a redundant
backup of a captured config (excluded), and `.zcompdump*`/`*.zwc` are
regenerable (excluded); user history (`.zsh_history`) and shell config are not
regenerable and stay `unknown`. Schema-1 archives are classified conservatively
from their `state_complete` flag and dependencies — never rewritten, never
silently promoted to proven; ambiguous legacy state remains blocked.

A durable journal (`<NESSION_HOME>/.install-transaction.json`, schema 2, mode
0600) records `staging -> snapshot -> archive-committed -> binary-swap ->
committed` before each mutation, naming the release homes, exact old/new binary
SHA256 digests, config **preimage fingerprints** and the transaction PID.
Current's config/state are never moved, so recovery verifies preimages instead
of restoring anything. The next CLI invocation recovers under the shared
lifecycle lock:

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
  or a missing archive copy is fail-stop: the journal stays and later commands
  report the exact repair. Recovery errors are never swallowed.

Schema-1 journals (the superseded move-based transaction) keep their own
compatible recovery owner: moved entries are restored to Current by the old
algorithm, or the recovery refuses with precise instructions. They are never
guessed by the schema-2 path.

### Archived server paths

`config server init` persists generated absolute `db_path`, `image_blob_dir`
and `image_build_dir` defaults. Only the **archive's copy** of the server
config is rewritten, and only for paths whose data was actually captured as an
independent snapshot (#4592 coverage honesty): a captured generated default
moves to the archived home's default; an **uncaptured** generated default
(failed DB backup, referenced-not-copied CAS store) stays verbatim and is
recorded as an external dependency — the archive must not claim a copy it does
not have. Explicit external absolute paths stay verbatim (also recorded as
dependencies); relative, empty or in-home non-default paths (and non-string or
unreadable fields) refuse the archive instead of silently reading Current
data. Current's own config is never rewritten by the upgrade.

### First safe upgrade and the installer bridge

`scripts/install.sh` verifies the release SHA256 before extracting and before
publishing anything. It delegates to the installed CLI **only when that CLI
advertises the versioned upgrade contract** (`nession --upgrade-contract`
prints `nession-upgrade-v1 <release>`); `install --help` alone is not proof,
because an old CLI can support `install` and still run the superseded
move-based transaction. Without the contract — including such CLIs — the
script downloads and hash-verifies the target, checks the target's own
contract, and hands the upgrade to the verified **target** transaction with
the actual installed directory/version; the old CLI's install/update code
never runs. A fresh machine still bootstraps the selected binaries from
staging in one publication step. Neither path stops a running daemon, and the
script defuses `NESION_VERSION` before probing or delegating. Bootstrap
curl/wget calls are bounded (connect/total/idle budgets and bounded retries).

**The shell is bootstrap only (#4660).** Before the large transfer it runs a
read-only live-process preflight through the existing CLI's `agent|server
status` (a proven live writer is refused with zero asset GETs; an inconclusive
probe defers to the authoritative under-lock recheck). It downloads the archive
**once** and hands the owner-private staged tarball plus its verified digest to
the canonical target installer (`install <ver> --local-artifact <path>
--artifact-sha256 <hex>`); the target never re-downloads the asset. The CLI
independently re-hashes the local artifact, extracts safely (only the three
named binaries, no path escape) and proves version/platform through the
upgrade-contract handshake before any mutation; a tampered/wrong-version/
wrong-platform artifact is refused with Current unchanged. After the
transaction the CLI prints one authoritative versioned result line
`nession-install-result-v1 outcome=<committed|unchanged|rolled-back|recovery-blocked> result=<ok|failed> [… coverage=<complete|gaps>]`.
The shell consumes that line: `result=ok` reports success (a `committed`
outcome with `coverage=gaps` is still committed and intact — only a warning);
`result=failed` reports the proven Current state truthfully. The shell never
infers archive completeness from directory existence and never asserts a
rollback merely because the subprocess exited nonzero; an older upgrade-v1
target without the result line is reported by exit status alone. Mandatory
verification belongs before commit; after commit the outcome is reported
truthfully without a destructive retry. The transaction owner preserves the
three-binary digest checks, journal recovery, retention and no implicit
stop/start.

**Limitation:** an already-released old CLI's direct `nession update` cannot be
retroactively changed by a new target artifact. Affected users must use the
updated official installer as the supported first hop; release notes route
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
URLs redacted.

## Per-command selection

The dispatcher runs before command parsing: `+<version>` beats
`NESSION_VERSION`, which beats Current. It `exec`s
`versions/<version>/bin/nession` with `NESSION_HOME=<version home>`, marks the
child to prevent recursion, and disables the child's background update check.
`version list` runs on Current and reports Current/Archived/Running;
`install`/`update` reject a non-Current selector instead of writing into an
archived home. The update-check cache is ignored when it was written by a
different release.

### Historical state-coverage gate

Binary availability, snapshot coverage and safe historical runtime eligibility
are three different facts (#4592). Before `exec`, the Current dispatcher
refuses **data-touching** commands (agent/server start/restart/stop and service
registration, sessions create/attach/kill, config init/set) on an archive whose
independent state ownership is unproven: a binary-only or legacy archive
without `manifest.json`, or a manifest recording missing/unknown state, unsafe
nonempty references or external dependencies.

**Admission is per component (#4660).** Agent and Server assess their own
required state plus shared dependencies independently: `agent`/`sessions`/
`config agent` gate on Agent coverage, `server`/`config server` on Server
coverage. A safe unrelated exclusion (Server logs/build, an empty CAS, an
absent Server DB on an Agent-only install) never blocks an otherwise proven
component; a nonempty referenced store, missing required capture, unknown root
or external dependency blocks the affected component (unknown shared state
blocks both). The historical runtime gate, peer-version check, single-active,
tmux/workspace/external-path safety and identity/auth consistency are preserved.
Read-only inspection (`status`, `logs`, `list`, `show`, `agents list`) stays
available on every complete archive. The gate applies to legacy versions too;
the supported entrypoint is the Current dispatcher — arbitrary direct
invocation of old binaries is not sandboxed. Existing archives remain
untouched and inspectable; there is no automatic DB downgrade and no implicit
promotion of a historical release.

### Read-only logs dispatch

`nession agent|server logs` is a read-only diagnostic surface (#4600). A
selected archive release runs its own CLI with the archive home; a release that
predates the logs command is read directly by the Current CLI after an explicit
diagnostic, never by falling back to Current's history. Logs skip
install-transaction recovery and the background update check, report a pending
recovery journal without mutating it, and do not require a proven archive
manifest. `server logs` is exempt from the data-touching classifier for the same
reason `agent logs` is. The command contract, source semantics, filters/follow
and bounded startup diagnostics are owned by
[Nession CLI local logs and startup diagnostics](nession-cli-local-logs-and-startup-diagnostics.md).

### Shared lifecycle contract

Before `agent|server start|restart|status|stop` is dispatched to an archived
release, the dispatcher runs `<archive>/bin/nession --lifecycle-contract`. A
contract-aware release prints `nession-lifecycle-v1 <its release>`; both the
token and the release named by the archive directory must match. Releases that
predate the shared lock, PID identity and single-active gate — or mislabeled
archives — are refused with a migration hint. Other archived commands still run.
Only a complete (three-binary) archive is dispatched at all.

## Lifecycle

- `start` is idempotent: a live component is reported with its PID and release
  and left alone, even when the selected release differs.
- `restart` is the only command that replaces a running process; it stops the
  verified identity, waits for exit, starts the selected release and waits for
  READY.
- A peer component running another release (or one that recorded no release) is
  refused as a mixed-release environment. Nession never restarts the other
  component implicitly.
- An advisory `lifecycle.lock` in the shared runtime directory serialises
  start/stop/restart and Current-replacing installs across releases. Stop and
  restart still use `pid + started_at + kind` ownership and never signal a
  reused PID.
- The process identity records the writing release; that is what Running
  reports and what the mixed-release check compares.
- Stop re-reads the recorded identity immediately before the timeout escalates
  to SIGKILL. The start field is compared exactly (a rewritten record is not the
  same instance, even if the pid matches), and the OS tolerance still applies in
  the ownership read. A changed/reused/unreadable identity is never signalled;
  the ordinary timeout still force-kills the recorded instance.

## State and limits

The installation retains its configuration, identity and compatible durable
state across upgrades; the archive holds independent copies, never the moved
originals. The Server DB schema evolves through the Server's own migrations at
startup — there is no implicit database downgrade. An archived release
selected later uses its own snapshotted configuration/state through its version
home (only when the coverage gate proves it safe), while process discovery
still uses the shared runtime directory. tmux Sessions live on the Agent's
socket under the stable home and survive an upgrade; their instance metadata is
retained at Current and snapshotted into the archive. A Session is reattached
only when instance and execution ownership are compatible; an incompatible
owner blocks recovery explicitly rather than recreating or silently taking
over the Session.

Protocol compatibility between releases remains owned by the Protocol Unit /
Contract Version / Manifest Resolver; a matching release number is not protocol
negotiation. A native boot-time service-manager proof needs a real isolated
systemd/launchd runtime; a generated unit/plist fixture is not evidence.
Releases older than the shared lifecycle contract can still be archived and run
read-only commands, but cross-release lifecycle commands are refused and
data-touching commands additionally require proven state coverage. This is the
supported compatibility boundary, not an assumption that old binaries behave
like new ones.

## Service managers

The generated systemd user unit or launchd LaunchAgent is the lifecycle owner of
the Agent it registered. When the unit/plist targets the state file a CLI
invocation resolved, `agent start` is idempotent for a running managed Agent and
refuses to create an unmanaged process beside the registration; `restart` and
`stop` are refused with the manager command, because `Restart=on-failure` /
`KeepAlive` would otherwise race the CLI and could revive the manager's
snapshotted (possibly older) binary. `status` and commands aimed at a different
explicit state file are unaffected.

The generated artifact marks its **direct child** with
`NESION_MANAGED_AGENT=1`; the guard honors the marker only with a
systemd/launchd parent, because tmux Sessions inherit the variable.
`uninstall-service` returns future starts to the CLI and names the manager stop
command for a still-loaded job. Cross-release switching installs the target as
Current and re-runs `install-service` from it.

Related knowledge:

- [Nession runtime directories and daemon process state ownership](nession-runtime-directories-and-daemon-process-state-ownership.md) — the shared runtime location and legacy PID migration this versioning relies on.
- [Nession CLI local logs and startup diagnostics](nession-cli-local-logs-and-startup-diagnostics.md) — read-only local log discovery, filters/follow and bounded startup/service diagnostics.
- [Nession Sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md) — Sandbox confinement is a separate process boundary from daemon release lifecycle.