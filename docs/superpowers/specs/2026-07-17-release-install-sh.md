# Release install.sh and update from release

**Date:** 2026-07-17  
**Issues:** Release workflow enhancement  
**Scope:** Add install.sh to GitHub Release assets, update nession update to download from release

---

## Overview

Currently install.sh lives in the repository but is not included in GitHub Release assets. Users who want to install or update nession need to either:
1. Clone the repo to get install.sh
2. Use the raw GitHub URL (which may have rate limits)

This design adds install.sh to release assets and updates the nession update command to download from releases.

---

## Changes

### 1. Release Workflow (.github/workflows/release.yml)

Add install.sh to release assets in the `create-release` job:

```yaml
- name: Copy install.sh to release assets
  run: cp scripts/install.sh release-assets/install.sh
```

This makes install.sh available at:
`https://github.com/BestNathan/nession/releases/download/vX.Y.Z/install.sh`

### 2. Update Download Logic (crates/nession-cli/src/update/download.rs)

Add function to download install.sh:

```rust
pub fn download_installer(
    client: &Client,
    release: &ReleaseInfo,
    dest_dir: &Path,
) -> Result<PathBuf, UpdateError> {
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == "install.sh")
        .ok_or_else(|| UpdateError::AssetNotFound("install.sh not found in release".into()))?;

    let dest = dest_dir.join("install.sh");
    download_to_file(client, &asset.browser_download_url, &dest)?;

    // Make executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o755))
            .map_err(UpdateError::Io)?;
    }

    Ok(dest)
}
```

### 3. Update Command Flow (crates/nession-cli/src/update/mod.rs)

Add optional flag `--include-installer` to also download install.sh.

### 4. CLI Argument (crates/nession-cli/src/main.rs)

Add `--include-installer` flag to the update command.

---

## Implementation Order

1. Modify release.yml to include install.sh
2. Add download_installer function
3. Add --include-installer flag
4. Add tests
5. Update documentation

---

## Success Criteria

- install.sh appears in GitHub Release assets
- nession update --include-installer downloads install.sh
- All existing tests pass
- No behavior changes to existing update flow
