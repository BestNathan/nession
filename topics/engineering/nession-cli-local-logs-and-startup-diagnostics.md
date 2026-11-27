---
title: "Nession CLI local logs and startup diagnostics"
description: "Read-only `agent|server logs` discovery across rolling runtime files, bounded startup diagnostics and managed-service captures, with filter-before-tail, identity/offset follow, sanitized bounded startup records and archive-safe read-only dispatch"
topic: engineering
categories: ["architecture", "cli", "observability", "logging", "lifecycle", "security"]
status: verified
created_at: 2026-11-27T07:10:08Z
updated_at: 2026-11-27T07:10:08Z
sources: ["https://github.com/BestNathan/nession/issues/4600", "https://github.com/BestNathan/nession/pull/4612", "https://github.com/BestNathan/nession/pull/4616", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/docs/architecture/cli-logs.md", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-cli/src/local_logs/mod.rs", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-cli/src/local_logs/query.rs", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-cli/src/local_logs/follow.rs", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-cli/src/local_logs/tail.rs", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-cli/src/local_logs/service.rs", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-common/src/startup_log.rs", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-common/src/logging.rs", "https://github.com/BestNathan/nession/blob/972a5877f43be225a526e71711a3368576e89d2a/crates/nession-cli/src/lifecycle/pid_file.rs"]
---

# Nession CLI local logs and startup diagnostics

## Decision

`nession agent logs` and `nession server logs` are **read-only local
diagnostics**. They never open a Server connection, read a remote credential,
require a running daemon, perform a network update check or mutate the
installation (#4600). Both leaves expose the same option contract; only the
component differs.

| Option | Contract |
| --- | --- |
| `-n, --tail <N>` | Matching records to show. Default 100, `0` allowed. Filtering happens before the tail. |
| `-f, --follow` | Print the tail, then appended lines. Ctrl-C stops the reader only; the daemon is untouched. |
| `--since <WHEN>` | Duration (`30m`, `1h30m`, `2d`) or an RFC3339 timestamp with a UTC offset. |
| `--until <WHEN>` | RFC3339 upper bound; with `--follow` it ends the reader at the cutoff. |
| `--level <LEVEL>` | Minimum persisted severity. Runtime source only. |
| `--target <TARGET>` | Exact tracing target or module-prefix boundary. Runtime source only. |
| `--path` | Print resolved source location(s), no content. |
| `--source <runtime\|startup\|service>` | Runtime files (default), bounded startup records, or the managed service capture. |
| `--pid-file <PATH>` | State file used for instance discovery, consistent with `status`. |

Invalid ranges, `--path` with content options, raw sources combined with
`--level`/`--target`, and `--source service` for the Server are refused with an
explicit diagnostic rather than silently ignored.

## Paths and naming ownership

The runtime writer owns the tree under `$NESSION_HOME` (default `~/.nession`):

```text
agent/logs/
  nession-agent                    # rotation = never
  nession-agent.YYYY-MM-DD         # daily
  nession-agent.YYYY-MM-DD-HH      # hourly
  startup/startup.log[.1|.2]
  service/launchd.out[.1]          # macOS managed service
  service/launchd.err[.1]
server/logs/
  nession-server…                  # same runtime rotations
  startup/startup.log[.1|.2]
```

`nession-common::logging` is the single owner of component prefixes, the
writer filename shapes (including compatible historical `prefix.log[.date]`
names), log roots and managed-service capture names. File discovery accepts
only those shapes; unrelated files, another component's files, rotation
artefacts and symlinked files are excluded. A **symlinked log directory** is
refused rather than followed outside the selected home. Dated files are read
oldest first; an undated (`never`) file sorts last because it may still be
active.

## Instance and home scope

The selected home is `$NESSION_HOME` or the documented default. A live daemon's
PID identity now optionally records the absolute `home` and runtime `log_dir`
it resolved; `status` presents a recorded path only when it is the canonical
directory under the recorded home, otherwise it says `unknown`.

- A verified live identity with a recorded scope selects its home/log directory.
- An explicit `$NESSION_HOME` that conflicts with the recorded live home is
  refused, naming both paths.
- A legacy identity without a recorded scope is explicitly unverified; the
  selected home is shown separately.
- No live process reads the selected home's history.
- `--pid-file` follows the same state-file ownership rules as `status`, and the
  read never creates the runtime directory or cleans/migrates state.

## Reading, filtering and follow

Runtime files use `tracing_subscriber`'s default text shape: an RFC3339
timestamp, severity, target and message, plus continuation lines for a
multi-line message. A record is a header plus its continuations and is filtered
as a whole. Raw startup/service text is never assigned a severity or target;
records missing a field a requested filter needs are skipped and counted on
stderr.

The tail reads files newest first in fixed-size chunks from the end, buffering
only the partial line that crosses a chunk boundary and at most `--tail`
matching records. A single line and a single record are capped at 1 MiB;
truncation is diagnosed on stderr. Follow is identity/offset based and polls
without a busy loop: it drains the old file, switches to a new rotation file,
follows a rename by inode, detects truncation, and reads a replacement file from
its start. An unterminated final line waits for its newline and is flushed when
the file rotates or the reader stops. Retention deletion and record fragments
whose header is gone are diagnosed as history gaps.

## Startup diagnostics

Failures before the runtime log writer exists are appended to
`<component>/logs/startup/startup.log` with timestamp, component, phase and one
sanitized sentence. Phases are `config`, `validate`, `logging` and `readiness`.
The terminal/stderr diagnostic is preserved alongside the capture; when the
capture location itself is unusable, the error explicitly says startup
diagnostics are unavailable.

Bounds are independent of runtime retention: three files (`startup.log`,
`.1`, `.2`), each kept strictly below 256 KiB, with a 4 KiB record cap, `0600`
files inside a `0700` directory on Unix. ANSI escapes/control bytes are
stripped; token/password/secret assignments and URL query strings are redacted.
Background child stderr is drained continuously from spawn, so an oversized
child error cannot deadlock the readiness handshake. Startup capture never
duplicates the full runtime history.

## Managed-service logs

- **Linux Agent**: `journalctl --user -u nession-agent.service`. The unit must
  be registered in the user unit directory; when it pins
  `Environment=NESSION_HOME=…`, that scope must equal the resolved home or the
  read is refused. An older unit without the pin is read with an explicit
  unverified-scope warning. Missing registration, missing `journalctl`, and
  journal failures are reported distinctly.
- **macOS Agent**: new LaunchAgent registrations capture stdout/stderr under
  `<home>/agent/logs/service/launchd.{out,err}` instead of the historical
  shared `/tmp` paths. Rotation happens at registration (the only time launchd
  is not writing the file): a 4 MiB capture becomes `.1`, one generation kept.
  An installed plist is left untouched; `--source service` shows its captured
  path only when that plist references it, including a warned legacy `/tmp`
  path. Unrelated `/tmp` files are never swept.
- **Server**: there is no native managed service in this CLI; the service
  source is explicitly unsupported.

## Release selection and archives

Logs are symmetric for Agent and Server. `nession +<version> … logs` runs the
selected archive's CLI against that archive's home. A release that predates the
logs command is read directly by the Current CLI after an explicit diagnostic;
it never falls back to Current's history and never claims an archive holds all
release history. Logs skip install-transaction recovery and the background
update check, report a pending recovery journal instead of mutating anything,
and never require a proven archive manifest. Upgrades retain Current's logs in
place (#4592); archive copies are independent snapshots. See
[Nession CLI release versioning and single-active daemons](nession-cli-release-versioning-and-single-active-daemons.md)
for archive admission and the mutation gate that `logs` is exempt from.

## Limits / when to revisit

- Output is human-readable text. JSON output, a remote log API, a top-level
  `logs` command and web log viewing are explicitly future work.
- Native launchd/systemd execution is not proven by generated fixtures; the
  staging runtime Case is the platform proof. Deterministic plist/capture
  rotation fixtures cover the generated contract only.
- Timestamp filtering assumes the runtime writer's RFC3339 headers. A custom
  unrelated formatter would make those records unparseable; they are counted,
  not guessed.
- Mixed daily/hourly history from repeated rotation-config changes has no
  total order; only recognised shapes are read and gaps are diagnosed.

Related knowledge:

- [Nession CLI release versioning and single-active daemons](nession-cli-release-versioning-and-single-active-daemons.md) — Current/Selected/Running selection, archive coverage and the read-only logs dispatch boundary.
- [Nession runtime directories and daemon process state ownership](nession-runtime-directories-and-daemon-process-state-ownership.md) — where PID/readiness state lives and the identity record this read scope extends.
