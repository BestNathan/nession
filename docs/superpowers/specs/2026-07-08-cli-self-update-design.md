# CLI Self-Update Command — Design Spec

**Issue**: [#33](https://github.com/BestNathan/nession/issues/33)
**Date**: 2026-07-08
**Status**: Approved

## 1. Overview

Add `nession update` subcommand to nession-cli. Detects new versions via GitHub Releases API, downloads + verifies + atomically replaces the three binaries (nession, nession-agent, nession-server). Also adds a background version check on every CLI invocation (except `--help` and `--version`).

## 2. Architecture

All new code lives inside `crates/nession-cli/src/` — no new crate.

```
crates/nession-cli/src/
├── main.rs                          # MODIFIED: add background update check
├── commands/
│   ├── mod.rs                       # MODIFIED: + pub mod update;
│   └── update.rs                    # NEW: clap args + flow orchestration
└── update/                          # NEW directory
    ├── mod.rs                       # UpdateOrchestrator: main flow, error types
    ├── github.rs                    # GitHubReleaseClient: API interaction
    ├── version.rs                   # SemVer parse + compare
    ├── download.rs                  # Download + SHA256 verification
    ├── replace.rs                   # Backup + atomic replace (incl. self-replace)
    ├── cache.rs                     # Cache read/write (update-check.json)
    └── check.rs                     # Background check entry point (called by main.rs)
```

## 3. CLI Interface

```
nession update                 # Detect and upgrade to latest
nession update --check         # Only check, print whether update exists
nession update --version 0.3.5 # Upgrade/downgrade to specific version
nession update --dry-run       # Simulate without changing files
nession update --yes           # Skip confirmation prompt
```

### Background check output (stderr, when update available)

```
⚠ Update available: 0.4.2 → 0.5.0. Run `nession update` to upgrade.
```

### `--check` output

```
Current version: 0.4.2
Latest version:  0.5.0
Status: Update available
Run `nession update` to upgrade.
```

## 4. Dependencies (add to nession-cli Cargo.toml)

```toml
reqwest = { version = "0.12", features = ["rustls-tls", "stream"], default-features = false }
sha2 = "0.10"
flate2 = "1.0"
tar = "0.4"
semver = "1.0"
thiserror = "1.0"    # already in workspace, add to nession-cli deps
```

## 5. Data Flow

### 5a. Manual upgrade (`nession update`)

1. Resolve current version from `env!("CARGO_PKG_VERSION")`
2. Fetch target release from GitHub API:
   - `--version X` → `GET /repos/BestNathan/nession/releases/tags/v{X}`
   - Default → `GET /repos/BestNathan/nession/releases/latest`
3. Parse target version (strip `v` prefix → SemVer)
4. Compare versions: same → "Already up to date", dev (current > latest) → "Running dev version", else continue
5. Confirmation prompt (`--yes` skips)
6. Detect platform `{os}-{arch}` → match release asset filename
7. Download tarball + checksums.txt
8. SHA256 verification
9. If `--dry-run`: stop, report what would happen
10. For each binary (nession, nession-agent, nession-server):
    - Locate binary path (current_exe for CLI; same dir then PATH for agent/server)
    - Check write permission
    - Check if process running (lock file/pid)
    - Backup old → `.bak`
    - Extract new → tmp file
    - Set permissions 755
    - Atomic rename (nession self-replace: unlink + write since same inode)
    - Report result (✓/✗)

### 5b. Background check (every CLI start)

1. Skip if command is `--help` or `--version`
2. Skip if `NESSION_NO_UPDATE_CHECK=1`
3. Read cache `~/.nession/update-check.json`
4. If cache fresh (< 30 min), use cached result
5. If stale/missing: `tokio::spawn` a GET to `/releases/latest` (5s timeout), write cache
6. If update available → print hint to stderr

## 6. Cache Format

`~/.nession/update-check.json`:

```json
{
  "checked_at": "2026-07-08T10:30:00Z",
  "latest_version": "0.5.0",
  "current_version": "0.4.2",
  "update_available": true
}
```

TTL: 30 minutes.

## 7. Error Handling

Custom error type `UpdateError` (implements `thiserror::Error`):

| Variant | Trigger |
|---------|---------|
| `Network` | DNS / connection failure |
| `RateLimited` | GitHub API 403/429 |
| `UnsupportedPlatform` | No prebuilt binary for current OS/arch |
| `ReleaseNotFound` | Tag/release doesn't exist |
| `AssetNotFound` | No asset matching platform pattern |
| `ChecksumMismatch` | SHA256 verification failed |
| `PermissionDenied` | Can't write to install directory |
| `InsufficientSpace` | Disk full |
| `ProcessRunning` | Agent/server is running (warn only, don't block) |
| `ExtractionFailed` | Corrupt/invalid tarball |
| `Io` | General filesystem error |

All errors use `?` operator — no `unwrap()` or `expect()` anywhere.

### Edge case mapping

| # | Scenario | Behavior |
|---|----------|----------|
| 1 | Already latest | Print "Already up to date (v0.4.2)", exit 0 |
| 2 | Dev version (current > latest) | Print "Running a development version (0.5.0-dev), latest release is 0.4.2", exit 0 |
| 3 | No network | Background: silent skip. Manual: "Network error: unable to reach GitHub API" |
| 4 | API rate limited | Use cached result; if no cache, "GitHub API rate limited. Try again later." |
| 5 | Checksum mismatch | Abort, keep old version, print expected vs actual |
| 6 | Disk full | Check available space before download, fail early |
| 7 | No platform binary | "No prebuilt binary for {os}-{arch}" |
| 8 | No write permission | Print path + "use sudo or set --dir to a writable path" |
| 9 | Agent/server running | Print "nession-agent is running (PID: 1234). Restart to use new version.", don't block |
| 10 | Binaries in different dirs | Locate each independently, report status per binary |
| 11 | Partial failure | Don't rollback succeeded ones; report ✓/✗ per binary; exit 1 if any failed |
| 12 | Symlinked binary | Resolve canonical path before replacing |
| 13 | macOS quarantine | After replace, print hint: `xattr -d com.apple.quarantine /path/to/nession` |

## 8. Testing

### 8a. Unit tests (no network)

- **version.rs**: SemVer parse, compare, prerelease filtering, `v` prefix handling
- **cache.rs**: Read/write/expiry, corrupt JSON tolerance, TTL boundary
- **replace.rs**: Binary path resolution, backup naming, macOS detection
- **github.rs**: Release tag parsing, asset URL construction, platform string matching

### 8b. Integration tests (mock HTTP with `httptest`)

- Newer version → `update_available = true`
- Already latest → "Already up to date"
- Dev version → "Running a development version"
- 404 tag → `ReleaseNotFound`
- 403 rate limit → `RateLimited`
- Valid tarball + correct checksum → passes
- Checksum mismatch → `ChecksumMismatch`
- DNS failure → `Network`

### 8c. E2E tests (tempfile, `#[ignore]` on CI)

- Full upgrade flow with local tarball
- `--check` output format assertion
- `--dry-run` doesn't modify files
- `--version X` downgrade
- Self-replace (nession CLI itself)
- `--yes` skips confirmation

### 8d. dev-dependencies added

```toml
httptest = "0.16"
```

(tempfile already present; flate2, tar, sha2 are production deps)

## 9. CI Changes

### Modified jobs in `.github/workflows/release.yml`

In each native binary build job (`build-linux-amd64`, `build-linux-arm64`, `build-macos`), add to the Package step (unique filename per job to avoid artifact merge collisions):

```yaml
- name: Generate checksums
  run: sha256sum nession-*.tar.gz > checksums-${{ matrix.os }}-${{ matrix.arch }}.txt
```

In `create-release` job, merge into single `checksums.txt`:

```yaml
- name: Merge checksums
  run: |
    cat release-assets/checksums-*.txt > release-assets/checksums.txt
    rm release-assets/checksums-*.txt
```

Final release assets include a single `checksums.txt` covering all four platform tarballs.

## 10. Decisions Recap

| Dimension | Decision |
|-----------|----------|
| Code location | All in `nession-cli` crate |
| HTTP client | reqwest 0.12 + rustls-tls |
| Version parsing | semver crate 1.0 |
| Checksum format | `sha256sum` standard (`<hash>  <filename>`) |
| Cache location | `~/.nession/update-check.json`, 30 min TTL |
| Backup naming | Fixed `.bak` suffix per binary |
| Self-replace strategy | Unix unlink + write (same inode semantics) |
| Release checksums | Single `checksums.txt` for all platforms |
