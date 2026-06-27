# Centralize temp/data files under ~/.nession/

Date: 2026-06-27

## Problem

Nession currently scatters runtime files across the user's filesystem:

- **Server DB** defaults to `./nession-server.db` in whatever the current working directory happens to be
- **PID files** default to `/tmp/nession-agent.pid` and `/tmp/nession-server.pid`
- Test files create various `./test_*.db` and `/tmp/nession_test_*.db` files

This makes it hard to find, audit, or clean up nession's state. A single dotdir is the conventional solution.

## Decision

All persistent runtime files live under `~/.nession/`, organized by component:

```
~/.nession/
├── server/
│   ├── server.db
│   └── server.pid
└── agent/
    └── agent.pid
```

## Scope

### In scope
- Server DB default path
- Server PID file default path
- Agent PID file default path
- Auto-creation of component directories on startup
- Inline fallback defaults in `run_server_once()` and `nession-server` binary

### Out of scope
- **Test files** — tests continue to use `tempfile` / `tempdir` / cwd temp files. They're transient and don't need a permanent home.
- Log files — nession currently writes to stderr via `tracing`/`env_filter`. No log files exist today.
- Any other future runtime files — handled by extending the `paths` module later.

## Design

### New module: `nession-common/src/paths.rs`

Single source of truth for all nession file paths. Exposes:

- `nession_home() -> PathBuf` — `~/.nession`
- `server_dir() -> PathBuf`
- `agent_dir() -> PathBuf`
- `server_db_path() -> PathBuf`
- `server_pid_path() -> PathBuf`
- `agent_pid_path() -> PathBuf`
- `ensure_component_dirs() -> io::Result<()>` — `mkdir -p` both subdirs

Uses the `dirs` crate (v5) for home directory resolution.

### Callers updated

1. **`nession-common/src/config.rs`** — `default_db_path()` returns `paths::server_db_path().to_string_lossy().into_owned()`
2. **`nession-cli/src/main.rs`** — `--pid-file` arg defaults:
   - `server start/stop/status` → `paths::server_pid_path().to_string_lossy()`
   - `agent start/stop/status` → `paths::agent_pid_path().to_string_lossy()`
3. **`nession-cli/src/commands/server.rs`** — `run_server()` calls `paths::ensure_component_dirs()?` before DB init; remove inline `"./nession-server.db"` fallback in `run_server_once()`
4. **`nession-server/src/main.rs`** — same: call `ensure_component_dirs()?` before DB init; remove inline fallback

### Dependency

Add `dirs = "5"` to `nession-common/Cargo.toml`.

### Error handling

`nession_home()` panics with `expect("could not determine home directory")` if the home dir can't be resolved. This is acceptable for now — a server without a home directory is an unusual environment. Can be made into a graceful error later if needed.

## Behavior

- On first run, `~/.nession/server/` and `~/.nession/agent/` are created automatically
- Existing `./nession-server.db` files in user's cwd are NOT migrated — user starts fresh
- Tests continue to write to temp locations, unaffected

## Verification

- Unit test for `paths` module: assert paths resolve to `~/.nession/{server,agent}/...`
- Manual: `cargo run -- server start`, verify `~/.nession/server/server.db` and `~/.nession/server/server.pid` are created
- Manual: `cargo run -- agent start`, verify `~/.nession/agent/agent.pid` is created
- Existing test suite passes unchanged
