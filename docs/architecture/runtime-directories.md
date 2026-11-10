# Runtime directories and process state

Nession separates **durable data** from **ephemeral process state** the way Docker
separates `/var/lib` from `/run`:

- durable data — configuration, database, identity, Session metadata, logs, env
  bindings — lives under `$NESSION_HOME` (default `~/.nession`);
- process state — PID files and background-start readiness markers — lives in an
  OS-owned runtime directory that a reboot may delete.

The split exists so process ownership never follows durable project data, an
installed binary version, or archived per-version configuration. The runtime
location is therefore resolved by `nession-common::paths::runtime_dir()`
(`crates/nession-common/src/paths.rs`) independently of `NESSION_HOME`, and it is
not version-scoped.

## Resolution contract

| Context | Default Nession runtime directory |
| --- | --- |
| Linux ordinary user / systemd user service | `$XDG_RUNTIME_DIR/nession/` (normally `/run/user/<uid>/nession/`) |
| Linux root or system service | `/run/nession/` (a system unit may also use systemd `RuntimeDirectory=nession`) |
| macOS ordinary user / launchd LaunchAgent | Darwin per-user temporary directory (`_CS_DARWIN_USER_TEMP_DIR`, falling back to `confstr`) plus `nession/` |
| Container | explicit `NESSION_RUNTIME_DIR`, or the applicable Linux runtime directory |
| Linux non-root without a valid `XDG_RUNTIME_DIR` | **error** naming `NESSION_RUNTIME_DIR`; never a durable home or shared `/tmp` fallback |

`NESSION_RUNTIME_DIR` is an explicit override. It names the Nession runtime
directory itself and must be an absolute path; a relative value is rejected.
When set, it wins on every platform. Resolution never consults `NESSION_HOME`.

`agent.pid` and `server.pid` share the resolved root. A background start's
readiness marker is `<pid-file>.ready.<parent-pid>`, so it follows the same
directory; its staged `.tmp` file is removed when the announcement completes or
fails. A future cross-version lifecycle lock may also live there; this design
does not introduce a lock manager.

## Safety

- The runtime directory is created owner-private (`0700` on Unix). An existing
  directory is tightened to `0700` when it is owned by the current user.
- A symlinked runtime directory, a directory owned by another user, or an OS
  runtime root that is group/other-writable is rejected rather than trusted with
  PID or lifecycle artifacts.
- Failure to resolve a default runtime location is an error. The CLI never falls
  back to `./agent.pid`, `./server.pid`, or a durable home path.

## Explicit `--pid-file`

`--pid-file` remains the highest-priority override for `agent` and `server`
`start`/`stop`/`restart`/`status`, the foreground/background child re-exec, and
`agent install-service`. An explicit path disables runtime-directory resolution
and disables legacy migration; custom paths are authoritative and are not
migrated implicitly.

## Migration from home-relative PID files

Pre-runtime binaries wrote `$NESSION_HOME/agent/agent.pid` and
`$NESSION_HOME/server/server.pid`. Default-location commands still detect a
daemon there, using the same `pid + started_at + kind` ownership identity
(#1016) as every other decision:

1. A valid live legacy identity is treated as running: `status` reports it with
   the legacy location, `stop`/`restart` signal it by verified identity and
   remove the legacy file, and `start` refuses to create a duplicate.
2. The runtime location is authoritative when both record a live process; a
   `start` still refuses because a live process exists.
3. Stale legacy records are removed. Reused-PID or unprovable legacy records
   (a bare pid, corrupt content) are **left in place** and reported: a bare pid
   is not ownership evidence, and a reader that cannot establish ownership must
   not signal or discard what it cannot prove.
4. The diagnostic action is explicit: if no daemon is running, remove the named
   legacy file manually. Never delete a record merely to silence a warning.

## Autostart

`nession agent install-service` resolves the same state file and writes it into
the generated contract:

- systemd **user** unit: `ExecStart=... --pid-file <path>` plus
  `Environment=NESSION_RUNTIME_DIR=<dir>` for the default location;
- launchd **LaunchAgent**: `ProgramArguments` contains `--pid-file <path>`, and
  `EnvironmentVariables` pins `NESSION_RUNTIME_DIR` for the default location.

The immediate start performed by the installer passes the same `--pid-file`.
An explicit `--pid-file` is written to the unit/plist but does not pin a runtime
directory. Service-manager supervision (`Restart=on-failure`, launchd
`KeepAlive`) is unchanged (#363).

Implementation owners: `crates/nession-common/src/paths.rs`,
`crates/nession-cli/src/lifecycle/pid_file.rs`,
`crates/nession-cli/src/commands/agent/`,
`crates/nession-cli/src/commands/server/`,
`crates/nession-cli/src/service/mod.rs`, and
`crates/nession-common/src/readiness.rs`.
