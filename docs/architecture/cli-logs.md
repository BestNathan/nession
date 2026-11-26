# CLI logs, startup diagnostics and service log discovery

`nession agent logs` and `nession server logs` read a component's local log
history. They are **read-only local commands**: no Server connection, remote
credential, running daemon, network update check or installation mutation is
involved (#4600).

## Commands

```bash
nession agent logs
nession server logs
nession agent logs -f
nession server logs -n 500
nession agent logs --since 1h --level warn
nession agent logs --target nession_agent::ws -f
nession agent logs --path
nession agent logs --source startup
nession agent logs --source service -f
```

Both leaves expose the same options:

| Option | Meaning |
| --- | --- |
| `-n, --tail <N>` | Matching records to show. Default 100; `0` prints nothing. Filtering happens before the tail. |
| `-f, --follow` | Print the tail, then appended lines. Ctrl-C stops only the reader; the daemon is untouched. |
| `--since <WHEN>` | Duration (`30m`, `1h30m`, `2d`) relative to now, or an RFC3339 timestamp with a UTC offset. |
| `--until <WHEN>` | RFC3339 upper bound. With `--follow`, the reader stops at the cutoff. |
| `--level <LEVEL>` | Minimum persisted severity: trace/debug/info/warn/error. Runtime source only. |
| `--target <TARGET>` | Exact tracing target or module-prefix boundary (`a::b` matches `a::b` and `a::b::*`, not `a::bc`). Runtime source only. |
| `--path` | Print the resolved source location(s); no content. Rejects content options. |
| `--source <SOURCE>` | `runtime` (default), `startup`, or `service` (Agent only). |
| `--pid-file <PATH>` | State file used for instance discovery, consistent with `status`. |

An invalid range (`--since` after `--until`), a raw source combined with
`--level`/`--target`, `--source service` for the Server, and `--path` combined
with content options are refused with a diagnostic instead of being ignored.

## Paths

Everything lives under the selected `$NESSION_HOME` (default `~/.nession`):

```text
<NESSION_HOME>/
  agent/logs/
    nession-agent                    # rotation = never
    nession-agent.YYYY-MM-DD         # daily
    nession-agent.YYYY-MM-DD-HH      # hourly
    startup/startup.log[.1|.2]       # bounded startup diagnostics
    service/launchd.out[.1]          # macOS managed-service capture
    service/launchd.err[.1]
  server/logs/
    nession-server…                  # same rotation shapes
    startup/startup.log[.1|.2]
```

The runtime writer owns these names (`nession_common::logging`): readers only
recognise the writer's actual shapes plus the compatible historical
`prefix.log[.date]` spellings. Unrelated files, another component's files,
rotation artefacts and symlinks are excluded; a symlinked log *directory* is
refused rather than followed outside the selected home. Dated files are read
oldest first; an undated (`never`) file sorts last because it may still be
active. `--path` prints the resolved file paths, or the directory when no file
exists yet (with the absence stated on stderr).

## Instance and home selection

The selected home is `$NESSION_HOME` or the documented default. A verified
live process records the absolute home and runtime log directory it actually
used in its PID identity; logs reads that record rather than presenting a
default as live state.

- Live process with a recorded scope: its home and log directory are used.
- Live process with an explicit `$NESSION_HOME` that conflicts with the record:
  refused, naming both paths. Unset `$NESSION_HOME` or point it at the
  recorded home.
- Legacy identity without a recorded scope: the selected home is read and
  reported as **unverified** for that process; `status` prints the selected
  home separately.
- No live process: the selected home's history is read.

`status` prints `Logs:` with the recorded directory (running, recorded),
`unknown` with the selected home (running, legacy record), or the selected
home with "no live process" (stopped).

`--pid-file` uses exactly the state file `status` would inspect. The command
never creates the runtime directory or removes stale state records just to
look for a daemon.

## Reading, filtering and follow

Runtime files are `tracing_subscriber` default text: an RFC3339 timestamp, a
severity, a target, a message, and possibly continuation lines for a
multi-line message. A record is a header plus its continuation lines and is
filtered as a whole. Raw startup/service text is never assigned a severity or
target; records that lack a field a requested filter needs are skipped and
counted on stderr.

The tail reads files newest first in fixed-size chunks from the end,
buffering only the partial line that crosses a chunk boundary plus at most
`--tail` matching records. A single line is capped at 1 MiB and a single
record at 1 MiB; truncation is reported on stderr. Follow is identity/offset
based and polls (not a busy loop): it drains the old file, switches to a new
rotation file, follows a renamed file by inode, detects truncation and reads
replacement files from their start. An unterminated final line is held until
its newline arrives, then emitted; it is flushed when the file is rotated or
the reader stops. On platforms without inode identity, replacement is not
guessed from a path.

A missing history is not an error: the command exits successfully, prints
nothing on stdout and states the absent directory on stderr. Unreadable
directories or files fail with the underlying I/O error.

## Startup diagnostics

Failures before the runtime log writer exists — malformed/unreadable
configuration, invalid effective values, an unusable log directory, and a
background readiness failure/timeout — are appended to
`<component>/logs/startup/startup.log` with the timestamp, component, phase
(`config`, `validate`, `logging`, `readiness`) and one sanitised sentence.
The same failures still reach the terminal/stderr with the capture's outcome
attached. When the capture location itself is unusable (for example the log
directory failed to build), the diagnostic says startup capture is
unavailable and the terminal/stderr error remains.

Bounds are independent of the runtime writer:

- 3 files (`startup.log`, `.1`, `.2`) × 256 KiB maximum.
- 4 KiB maximum per record; files are `0600` inside a `0700` directory on
  Unix.
- ANSI escapes and control characters are stripped; token/password/secret
  assignments and URL query strings are redacted. Callers pass diagnostic
  sentences, never config/env dumps.

## Managed-service logs

**Linux (Agent).** `--source service` runs
`journalctl --user -u nession-agent.service`. The command first verifies that
the unit is registered in the user unit directory. When the unit pins
`Environment=NESSION_HOME=…`, that scope must equal the resolved home or the
read is refused; an older unit without the pin is read with an explicit
"unverified home scope" warning. An absent registration, an absent
`journalctl`, or a failing journal is reported as such. Level/target filters
are refused because the journal is raw here.

**macOS (Agent).** `install-service` generates `StandardOutPath`/
`StandardErrorPath` under
`~/.nession/agent/logs/service/launchd.{out,err}` (owner-private directory)
instead of the historical shared `/tmp/nession-agent.launchd.*` files. Rotation
happens at registration, the only moment launchd is not writing the file: a
capture that reached 4 MiB is renamed to `.1` (one generation kept) before the
job is reloaded. An existing installed plist is left untouched; `--source
service` shows its captured path — including a legacy `/tmp` path, with a
warning — only when that plist actually references it. It never sweeps
unrelated `/tmp` files.

**Server.** There is no native managed service for the Server in this CLI;
`nession server logs --source service` reports the source as unsupported.

## Release selection and archives

The read is symmetric for Agent and Server. `nession +<version> agent logs`
runs the selected archive's CLI with that archive's home, so it reads that
release's directory. A release that predates the logs command cannot answer
`agent logs --help`; the Current CLI then reads the selected archive home
directly (read-only) and says so on stderr. It never falls back to Current's
logs and never claims an archive contains all history for a release.

Because logs is read-only, it does not run install-transaction recovery. A
pending journal is reported on stderr and recovery remains the next
mutating/Current-reading command's job. Upgrades keep Current's logs in place
(#4592); an archive only contains the files under its own home.

## Verifying

- Runtime: `cargo test -p nession-cli --lib logs::` and
  `cargo test -p nession-cli --test integration logs::`.
- Naming/paths/startup capture: `cargo test -p nession-common --lib`.
- Local platform proof covers generated plist content and rotation fixtures;
  real launchd/systemd execution and the deployed runtime Case are proven on
  the staging lane, not by these deterministic tests.
