---
title: "Nession CLI release versioning and single-active daemons"
description: "Current/Selected/Running release semantics, archived release homes with their own config and durable state, the install/archive transaction, per-command version dispatch, and idempotent start with restart-only replacement"
topic: engineering
categories: ["architecture", "cli", "lifecycle", "process", "release", "storage"]
status: verified
created_at: 2026-11-10T15:06:36Z
updated_at: 2026-11-10T15:06:36Z
sources: ["https://github.com/BestNathan/nession/issues/3173", "https://github.com/BestNathan/nession/pull/3214", "https://github.com/BestNathan/nession/blob/3226bd58839daedfa9090eb44bad4cc5c76b56ab/docs/architecture/cli-release-versioning.md", "https://github.com/BestNathan/nession/blob/3226bd58839daedfa9090eb44bad4cc5c76b56ab/crates/nession-cli/src/versions/mod.rs", "https://github.com/BestNathan/nession/blob/3226bd58839daedfa9090eb44bad4cc5c76b56ab/crates/nession-cli/src/update/install.rs"]
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

## Per-command selection

The dispatcher runs before command parsing: `+<version>` beats
`NESSION_VERSION`, which beats Current. It `exec`s
`versions/<version>/bin/nession` with `NESSION_HOME=<version home>`, marks the
child to prevent recursion, and disables the child's background update check.
`version list` runs on Current and reports Current/Archived/Running;
`install`/`update` reject a non-Current selector instead of writing into an
archived home. The update-check cache is ignored when it was written by a
different release.

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

## State and limits

Configuration and durable state move with the archived release; the new
Current starts from defaults, with no implicit database downgrade or migration.
An archived release selected later uses its own archived config/state. tmux
Sessions remain on the shared socket, but their per-instance metadata belongs to
the archived release and is not adopted silently by a new Current.

Protocol compatibility between releases remains owned by the Protocol Unit /
Contract Version / Manifest Resolver; a matching release number is not protocol
negotiation. A native boot-time service-manager proof is not provided by the
generated unit/plist tests. Archived releases older than the shared-runtime
change (#3155) cannot observe a process through the OS runtime directory.

Related knowledge:

- [Nession runtime directories and daemon process state ownership](nession-runtime-directories-and-daemon-process-state-ownership.md) — the shared runtime location and legacy PID migration this versioning relies on.
- [Nession Sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md) — Sandbox confinement is a separate process boundary from daemon release lifecycle.
