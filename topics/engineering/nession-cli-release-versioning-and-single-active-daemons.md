---
title: "Nession CLI release versioning and single-active daemons"
description: "Current/Selected/Running release semantics, archived release homes with their own config and durable state, the install/archive transaction, per-command version dispatch, and idempotent start with restart-only replacement"
topic: engineering
categories: ["architecture", "cli", "lifecycle", "process", "release", "storage"]
status: verified
created_at: 2026-11-10T15:06:36Z
updated_at: 2026-11-11T06:08:01Z
sources: ["https://github.com/BestNathan/nession/issues/3173", "https://github.com/BestNathan/nession/pull/3214", "https://github.com/BestNathan/nession/blob/3226bd58839daedfa9090eb44bad4cc5c76b56ab/docs/architecture/cli-release-versioning.md", "https://github.com/BestNathan/nession/blob/3226bd58839daedfa9090eb44bad4cc5c76b56ab/crates/nession-cli/src/versions/mod.rs", "https://github.com/BestNathan/nession/blob/3226bd58839daedfa9090eb44bad4cc5c76b56ab/crates/nession-cli/src/update/install.rs", "https://github.com/BestNathan/nession/issues/3232", "https://github.com/BestNathan/nession/pull/3261", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/crates/nession-cli/src/update/transaction.rs", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/crates/nession-cli/src/update/release_config.rs", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/crates/nession-cli/src/versions/mod.rs", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/crates/nession-cli/src/lifecycle/terminate.rs", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/crates/nession-cli/src/service/mod.rs", "https://github.com/BestNathan/nession/blob/335485885cc0457c4640b6271ae6eedd6f45adac/scripts/install.sh"]
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

A release is a coherent unit: `nession`, `nession-agent`, `nession-server` plus
that release's configuration and durable state. Archived releases live under
`<NESSION_HOME>/versions/<semver>/` and use that directory as their
`NESSION_HOME`; their binaries and state move together. PID/readiness state stays
in the shared OS runtime directory owned by [Nession runtime directories and daemon process state ownership](nession-runtime-directories-and-daemon-process-state-ownership.md), so every release observes the same live process.

## Install and archive

`nession install <version>`, `nession update [--version]` and
`scripts/install.sh --version` converge:

- target == Current: offline idempotent no-op, no user data touched;
- target < Current: install only into `versions/<target>/`; Current and other
  archives unchanged. Reinstalling a complete archive is a no-op and never
  overwrites its configuration/data;
- target > Current: download and SHA256-verify first, then archive Current's
  three binaries, both configs and `agent/`/`server/` into
  `versions/<current>/`, then atomically replace the managed binaries. The new
  Current starts from built-in defaults. A failed move/replacement restores the
  archived files and binaries; a partial release is never installed.

Versions are strict SemVer with an accepted `v` prefix. A Current replacement is
refused while an Agent or Server is live: moving the configuration and database
directories a running process is using is unsafe, and install never stops or
restarts a service implicitly. Installing an older release into an archive is
unaffected.

### Archive transaction and recovery

The archive is assembled in `versions/.stage-*` and published by one atomic
rename; only a directory containing all three binaries is a complete release.
A durable journal (`<NESSION_HOME>/.install-transaction.json`, owner-private
because it captures the original config) records `staging -> state-move ->
archive-committed -> binary-swap -> committed` before each mutation. The next
CLI invocation recovers under the shared lifecycle lock:

- `staging`: remove the staging directory; Current was untouched.
- `state-move` / `archive-committed`: restore all three old binaries from the
  archive (or staging before the rename), move configuration/state back and
  restore the captured original server-config text.
- `binary-swap`: commit forward only when all three installed binaries match the
  journal's new SHA256 digests; a mixed set is rolled back from the archive.
- An unreadable journal, a missing archive copy or an entry present at both
  locations is fail-stop: the journal stays and later commands report the
  repair. Rollback is idempotent after its sources are removed.

### Archived server paths

`config server init` persists generated absolute `db_path`, `image_blob_dir`
and `image_build_dir` defaults. Archiving rewrites those values to the archived
home's defaults, so an archived Server opens `versions/<old>/server/...` and
never Current's state. Explicit external absolute paths stay verbatim; relative,
empty or in-home non-default paths (and non-string fields) refuse the archive
instead of silently reading Current data. Rollback restores the exact original
config text.

### First migration

`scripts/install.sh` verifies the release SHA256 before publishing anything. On
a machine whose CLI predates `install`, it hands the first upgrade to the new
binary's transaction, archiving the old three binaries plus configuration and
durable state. A fresh machine still bootstraps from staging. Neither path stops
a running daemon, and the script defuses `NESION_VERSION` before probing or
delegating so `install`/`update` cannot see a selector.

## Per-command selection

The dispatcher runs before command parsing: `+<version>` beats
`NESSION_VERSION`, which beats Current. It `exec`s
`versions/<version>/bin/nession` with `NESSION_HOME=<version home>`, marks the
child to prevent recursion, and disables the child's background update check.
`version list` runs on Current and reports Current/Archived/Running;
`install`/`update` reject a non-Current selector instead of writing into an
archived home. The update-check cache is ignored when it was written by a
different release.

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

Configuration and durable state move with the archived release; the new
Current starts from defaults, with no implicit database downgrade or migration.
An archived release selected later uses its own archived config/state. tmux
Sessions remain on the shared socket, but their per-instance metadata belongs to
the archived release and is not adopted silently by a new Current.

Protocol compatibility between releases remains owned by the Protocol Unit /
Contract Version / Manifest Resolver; a matching release number is not protocol
negotiation. A native boot-time service-manager proof needs a real isolated
systemd/launchd runtime; a generated unit/plist fixture is not evidence.
Releases older than the shared lifecycle contract can still be archived and run
non-lifecycle commands, but cross-release lifecycle commands are refused.

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
- [Nession Sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md) — Sandbox confinement is a separate process boundary from daemon release lifecycle.
