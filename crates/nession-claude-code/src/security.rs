use std::path::Path;

/// File extensions allowed for exposure.
const ALLOWED_EXTENSIONS: &[&str] = &["json", "md", "jsonl"];

/// Files never exposed regardless of path.
const BLACKLIST_FILES: &[&str] = &["credentials.json"];

/// Maximum file size in bytes (1MB).
pub const MAX_FILE_SIZE: usize = 1_048_576;

/// Maximum bytes returned in a single read chunk (100KB).
pub const MAX_CHUNK_SIZE: usize = 102_400;

/// Check whether a relative file path is safe to expose.
/// Rejects: absolute paths, path traversal, blacklisted files,
/// and files with disallowed extensions.
pub fn is_path_allowed(relative_path: &str) -> bool {
    let path = Path::new(relative_path);

    // Reject absolute paths
    if path.is_absolute() {
        return false;
    }

    // Reject path traversal (any component that is "..")
    for component in path.components() {
        use std::path::Component;
        if component == Component::ParentDir {
            return false;
        }
    }

    // Check blacklist by filename
    let filename = path.file_name().and_then(|f| f.to_str()).unwrap_or("");
    if BLACKLIST_FILES.contains(&filename) {
        return false;
    }

    // Check extension whitelist
    matches!(path.extension().and_then(|e| e.to_str()), Some(ext) if ALLOWED_EXTENSIONS.contains(&ext))
}

/// Extract just the filename from a relative path.
pub fn filename(relative_path: &str) -> &str {
    Path::new(relative_path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(relative_path)
}

/// Get the home directory path for `~/.claude/`.
pub fn claude_home_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}
