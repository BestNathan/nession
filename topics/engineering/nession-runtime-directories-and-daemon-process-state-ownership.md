---
title: "Nession runtime directories and daemon process state ownership"
description: "OS-scoped runtime roots for Agent/Server PID and readiness state, private-directory safety, service-manager pinning and legacy home-relative migration"
topic: engineering
categories: ["architecture", "cli", "lifecycle", "process", "security", "storage"]
status: verified
created_at: 2026-11-10T11:18:40Z
updated_at: 2026-11-10T15:06:36Z
sources: ["https://github.com/BestNathan/nession/issues/3155", "https://github.com/BestNathan/nession/pull/3183", "https://github.com/BestNathan/nession/blob/f69b9a0f92ddc6cb28070ba4a3965b051e57a604/docs/architecture/runtime-directories.md", "https://github.com/BestNathan/nession/blob/f69b9a0f92ddc6cb28070ba4a3965b051e57a604/crates/nession-common/src/paths.rs", "https://github.com/BestNathan/nession/blob/f69b9a0f92ddc6cb28070ba4a3965b051e57a604/crates/nession-cli/src/lifecycle/pid_file.rs"]
---

# Nession runtime directories and daemon process state ownership

## Decision

Nession separates **durable data** from **ephemeral process state** the way
Docker separates `/var/lib` from `/run`.

- Durable data — configuration, database, Agent identity, Session metadata,
  logs and env bindings — lives under `$NESSION_HOME` (default `~/.nession`).
- Process state — Agent/Server PID files and background-start readiness
  markers — lives in an OS runtime directory that a reboot may delete and that
  is never archived with an installed binary version.

`nession-common::paths::runtime_dir()` is the single resolution owner. It never
consults `NESSION_HOME`; that independence is what keeps process discovery from
following durable project data or per-version archived configuration (#3155).

| Context | Default runtime directory |
| --- | --- |
| Linux ordinary user / systemd user service | `$XDG_RUNTIME_DIR/nession/` (normally `/run/user/<uid>/nession/`) |
| Linux root or system service | `/run/nession/` |
| macOS ordinary user / launchd LaunchAgent | Darwin per-user temporary directory plus `nession/` |
| Container | `NESSION_RUNTIME_DIR`, or the applicable Linux runtime directory |
| Linux non-root without a valid `XDG_RUNTIME_DIR` | error naming `NESSION_RUNTIME_DIR` |

`NESSION_RUNTIME_DIR` is an explicit absolute-path override and names the
directory itself. A relative value is rejected. `agent.pid` and `server.pid`
share the resolved root; a background start's readiness marker is
`<pid-file>.ready.<parent-pid>` in the same directory, and its staged `.tmp`
file is removed after a failed announcement.

## Safety

The runtime directory is created owner-private (`0700` on Unix) and an existing
directory is tightened when the current user owns it. A symlinked runtime
directory, a directory owned by another user, or an OS runtime root that is
group/other-writable is rejected rather than trusted with lifecycle artifacts.
Failure to resolve a default runtime location is an error: the CLI never falls
back to `./agent.pid`, `./server.pid`, or a durable home path.

An explicit `--pid-file` is the highest-priority override. It disables runtime
resolution and migration, remains authoritative across the foreground/background
child re-exec, and is written into `agent install-service` artifacts.

## Migration and diagnostics

Pre-runtime binaries wrote `$NESSION_HOME/agent/agent.pid` and
`$NESSION_HOME/server/server.pid`. Default-location commands still inspect that
legacy location with the existing `pid + started_at + kind` ownership identity
(#1016):

- A valid live legacy identity is treated as running: `status` reports it with
  the legacy path, `stop`/`restart` signal it by verified identity and remove the
  record, and `start` refuses to create a duplicate.
- The runtime location is authoritative when both record a live process.
- Stale legacy records are removed. Reused-PID or unprovable records (a bare
  pid, corrupt content) are left in place and reported; a bare pid is not
  ownership evidence, and a reader that cannot establish ownership must not
  signal or discard what it cannot prove.
- If no daemon is running, the named legacy file is removed manually. A unit or
  plist installed by a pre-runtime binary keeps passing the old path as an
  explicit `--pid-file`; re-run `nession agent install-service` to move the
  managed start onto the runtime state file.

## Autostart

The generated systemd user unit and launchd LaunchAgent carry the resolved
`--pid-file`, and for the default location also pin
`NESSION_RUNTIME_DIR`. The service manager therefore starts the same state file
that a later CLI `status`/`stop` reads. Existing supervision remains
`Restart=on-failure` / launchd `KeepAlive` (#363).

## Limits / when to revisit

- This article covers process-lifecycle state only. Session Environment
  Bindings, Agent identity, databases and logs remain durable `$NESSION_HOME`
  state.
- The cross-version lifecycle lock and the multi-version release archive are
  owned by [Nession CLI release versioning and single-active daemons](nession-cli-release-versioning-and-single-active-daemons.md); this article owns only the runtime location and process identity themselves.
- A systemd `RuntimeDirectory=nession` is deliberately not used by the user
  unit: the runtime root is shared by components, and a unit-scoped cleanup must
  not delete another component's state or a future shared lock.
- Revisit if a supported platform no longer provides a per-user runtime root, or
  if a service manager cannot be given an explicit absolute state path.

Related knowledge:

- [Nession CLI release versioning and single-active daemons](nession-cli-release-versioning-and-single-active-daemons.md) — per-command release selection, the release archive and the cross-version lifecycle lock built on this runtime directory.
- [Nession Sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md) — Sandbox isolation controls what a Session process may access; this article owns only where daemon lifecycle state lives.
