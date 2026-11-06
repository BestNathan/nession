//! Read-only, bounded worktree file preview for an untracked or unmerged row.
//!
//! `git.diff` deliberately stops at paths Git tracks. An untracked file still
//! exists in the Session's worktree, and an unmerged file's current bytes are
//! exactly what the reader needs before resolving it. This module answers that
//! question without turning the capability into a filesystem browser:
//!
//! - the repository root comes from the already-resolved Session workdir;
//! - the client may name only a repository-relative path;
//! - the path is rechecked against Git status before and after the read;
//! - every path component is opened relative to the previous directory with
//!   `O_NOFOLLOW`, so a symlink (including one swapped in during the read) is
//!   refused rather than followed;
//! - the read is byte- and time-bounded, and the file handle's identity is
//!   checked again before any bytes are returned.
//!
//! This file owns the filesystem read. `GitCmd` still owns every Git process;
//! no Git write is introduced here.

use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use tokio::io::AsyncReadExt;
use tokio::time::timeout;

use crate::protocol::preview::v1::{FilePreview, FilePreviewStateV1, PreviewExpectedV1};
use crate::runtime::cmd::GitCmd;
use crate::runtime::security::{self, MAX_STATUS_BYTES};
use crate::runtime::status;

/// Bytes one preview may carry. A preview is read by a person, not parsed;
/// reaching this limit is reported exactly like a truncated diff.
pub const MAX_PREVIEW_BYTES: usize = 1024 * 1024;

/// One file read is a local operation. A filesystem that cannot answer within
/// this window returns an explicit error instead of holding the request open.
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Read one authorized worktree path and return a typed preview snapshot.
pub async fn file_preview(
    cmd: &GitCmd,
    root: &Path,
    relative: &str,
    expected: PreviewExpectedV1,
) -> anyhow::Result<FilePreview> {
    let path = security::validate_repo_relative_path(relative)?;
    let root = std::fs::canonicalize(root)
        .with_context(|| format!("failed to canonicalize repository root: {}", root.display()))?;
    let root_identity = std::fs::symlink_metadata(&root)
        .with_context(|| format!("failed to stat repository root: {}", root.display()))?;
    if !root_identity.is_dir() {
        anyhow::bail!("repository root is not a directory");
    }

    // Before opening anything, prove the selected row still describes this
    // path. A forged tracked path is therefore never read.
    if let Some(state) = verify_expected(cmd, &root, &path, expected).await? {
        return Ok(state);
    }

    // A direct stat before opening keeps a FIFO, socket or device from ever
    // becoming the target of a read. The open path repeats the type check on
    // the handle it actually obtained.
    match std::fs::symlink_metadata(root.join(&path)) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Ok(preview_state(
                &path,
                FilePreviewStateV1::Unsupported,
                Some("This path is a symbolic link; previews do not follow links.".to_string()),
            ));
        }
        Ok(metadata) if !metadata.is_file() => {
            return Ok(preview_state(
                &path,
                FilePreviewStateV1::Unsupported,
                Some("This path is not a regular file.".to_string()),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(preview_state(&path, FilePreviewStateV1::Missing, None));
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return Ok(preview_state(
                &path,
                FilePreviewStateV1::Denied,
                Some("Permission denied while opening this file.".to_string()),
            ));
        }
        Err(error) => return Err(anyhow::Error::from(error)),
    }

    if !same_root_still_at(&root, &root_identity) {
        return Ok(preview_state(
            &path,
            FilePreviewStateV1::Changed,
            Some(
                "The repository changed before the preview could be read. Refresh Git Changes."
                    .to_string(),
            ),
        ));
    }

    let (file, metadata) = match open_secure(&root, &path) {
        Ok(open) => open,
        Err(OpenFailure::Missing) => {
            return Ok(preview_state(&path, FilePreviewStateV1::Missing, None))
        }
        Err(OpenFailure::Denied(message)) => {
            return Ok(preview_state(
                &path,
                FilePreviewStateV1::Denied,
                Some(message),
            ))
        }
        Err(OpenFailure::Unsupported(message)) => {
            return Ok(preview_state(
                &path,
                FilePreviewStateV1::Unsupported,
                Some(message),
            ))
        }
        Err(OpenFailure::Error(error)) => return Err(error),
    };

    if !metadata.is_file() {
        return Ok(preview_state(
            &path,
            FilePreviewStateV1::Unsupported,
            Some("This path is not a regular file.".to_string()),
        ));
    }

    let size = metadata.len();
    let modified = metadata.modified().ok();
    let mut reader =
        tokio::fs::File::from_std(file).take((MAX_PREVIEW_BYTES as u64).saturating_add(1));

    let mut bytes = Vec::new();
    timeout(READ_TIMEOUT, reader.read_to_end(&mut bytes))
        .await
        .map_err(|_| anyhow::anyhow!("file preview read timed out"))?
        .context("failed to read file preview")?;

    let after = reader
        .get_ref()
        .metadata()
        .await
        .context("failed to re-read file metadata after preview")?;
    if after.len() != size || after.modified().ok() != modified {
        return Ok(preview_state(
            &path,
            FilePreviewStateV1::Changed,
            Some("The file changed while it was being read. Refresh Git Changes.".to_string()),
        ));
    }

    if !same_file_still_at(&root, &path, &after) {
        return Ok(preview_state(
            &path,
            FilePreviewStateV1::Changed,
            Some("The file changed while it was being read. Refresh Git Changes.".to_string()),
        ));
    }

    // The repository directory is part of the read identity too: replacing the
    // root at the same path must not let bytes read from the old tree satisfy a
    // status answer from the new one.
    if !same_root_still_at(&root, &root_identity) {
        return Ok(preview_state(
            &path,
            FilePreviewStateV1::Changed,
            Some(
                "The repository changed while the preview was being read. Refresh Git Changes."
                    .to_string(),
            ),
        ));
    }

    // The repository and the selected row are part of the read identity. A
    // Session that moved, or a path that became tracked, must not receive the
    // bytes fetched under the previous selection.
    let current_root = match cmd.resolve_root().await {
        Ok(Some(root)) => std::fs::canonicalize(root).ok(),
        _ => None,
    };
    if current_root.as_deref() != Some(root.as_path()) {
        return Ok(preview_state(
            &path,
            FilePreviewStateV1::Changed,
            Some(
                "The repository changed while the preview was being read. Refresh Git Changes."
                    .to_string(),
            ),
        ));
    }
    match verify_expected(cmd, &root, &path, expected).await {
        Ok(None) => {}
        Ok(Some(state)) => return Ok(state),
        Err(_) => {
            return Ok(preview_state(
                &path,
                FilePreviewStateV1::Changed,
                Some("The repository status changed while the preview was being read. Refresh Git Changes.".to_string()),
            ))
        }
    }

    Ok(classify(&path, bytes, size))
}

fn preview_state(path: &str, state: FilePreviewStateV1, message: Option<String>) -> FilePreview {
    FilePreview {
        path: path.to_string(),
        state,
        text: String::new(),
        binary: false,
        size: 0,
        truncated: false,
        truncated_bytes: 0,
        message,
    }
}

/// `None` means the row is still the expected kind. `Some` is a truthful
/// refusal for a path that disappeared or changed status before the read.
async fn verify_expected(
    cmd: &GitCmd,
    root: &Path,
    path: &str,
    expected: PreviewExpectedV1,
) -> anyhow::Result<Option<FilePreview>> {
    let out = cmd
        .run(
            &["status", "--porcelain=v2", "--branch", "-z"],
            MAX_STATUS_BYTES,
        )
        .await?;
    if out.truncated() {
        anyhow::bail!("repository status is too large to verify a file preview");
    }
    let parsed = status::parse(&out.stdout)?;
    let present = match expected {
        PreviewExpectedV1::Untracked => parsed.untracked.iter().any(|item| item == path),
        PreviewExpectedV1::Unmerged => parsed.unmerged.iter().any(|item| item == path),
    };
    if present {
        return Ok(None);
    }

    let exists = std::fs::symlink_metadata(root.join(path)).is_ok();
    Ok(Some(preview_state(
        path,
        if exists {
            FilePreviewStateV1::Changed
        } else {
            FilePreviewStateV1::Missing
        },
        Some(if exists {
            "This path is no longer in the status group it was selected from. Refresh Git Changes."
                .to_string()
        } else {
            "This file is no longer present in the worktree.".to_string()
        }),
    )))
}

fn classify(path: &str, bytes: Vec<u8>, size: u64) -> FilePreview {
    let is_binary = bytes.contains(&0);

    if is_binary {
        return FilePreview {
            path: path.to_string(),
            state: FilePreviewStateV1::Ready,
            text: String::new(),
            binary: true,
            size,
            truncated: false,
            truncated_bytes: 0,
            message: Some("Binary file — no text preview.".to_string()),
        };
    }

    let limited = if bytes.len() > MAX_PREVIEW_BYTES {
        bytes.get(..MAX_PREVIEW_BYTES)
    } else {
        Some(bytes.as_slice())
    };
    let Some(limited) = limited else {
        return FilePreview {
            path: path.to_string(),
            state: FilePreviewStateV1::Unsupported,
            text: String::new(),
            binary: false,
            size,
            truncated: false,
            truncated_bytes: 0,
            message: Some("The preview could not be bounded safely.".to_string()),
        };
    };

    let text = match std::str::from_utf8(limited) {
        Ok(text) => text.to_string(),
        Err(error) if error.error_len().is_none() => {
            // The byte cap can cut a multi-byte character. Drop only that
            // incomplete suffix; the omitted bytes are still counted below.
            let valid = limited.get(..error.valid_up_to()).unwrap_or_default();
            match std::str::from_utf8(valid) {
                Ok(text) => text.to_string(),
                Err(_) => return binary_preview(path, size),
            }
        }
        Err(_) => return binary_preview(path, size),
    };

    let truncated = size > u64::try_from(text.len()).unwrap_or(u64::MAX);
    let truncated_bytes = if truncated {
        usize::try_from(size.saturating_sub(u64::try_from(text.len()).unwrap_or(u64::MAX)))
            .unwrap_or(usize::MAX)
    } else {
        0
    };

    FilePreview {
        path: path.to_string(),
        state: FilePreviewStateV1::Ready,
        text,
        binary: false,
        size,
        truncated,
        truncated_bytes,
        message: None,
    }
}

fn binary_preview(path: &str, size: u64) -> FilePreview {
    FilePreview {
        path: path.to_string(),
        state: FilePreviewStateV1::Ready,
        text: String::new(),
        binary: true,
        size,
        truncated: false,
        truncated_bytes: 0,
        message: Some("File is not valid UTF-8 text — no text preview.".to_string()),
    }
}

#[cfg(unix)]
fn same_file_still_at(root: &Path, relative: &str, opened: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    let current = match std::fs::symlink_metadata(root.join(relative)) {
        Ok(current) => current,
        Err(_) => return false,
    };
    current.file_type().is_file() && current.dev() == opened.dev() && current.ino() == opened.ino()
}

#[cfg(not(unix))]
fn same_file_still_at(_root: &Path, _relative: &str, _opened: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn same_root_still_at(root: &Path, opened: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    let current = match std::fs::symlink_metadata(root) {
        Ok(current) => current,
        Err(_) => return false,
    };
    current.is_dir() && current.dev() == opened.dev() && current.ino() == opened.ino()
}

#[cfg(not(unix))]
fn same_root_still_at(_root: &Path, _opened: &std::fs::Metadata) -> bool {
    // The read itself is refused on this platform; this preflight must not turn
    // the unsupported answer into a misleading "changed".
    true
}

#[derive(Debug)]
enum OpenFailure {
    Missing,
    Denied(String),
    Unsupported(String),
    Error(anyhow::Error),
}

#[cfg(unix)]
fn open_secure(
    root: &Path,
    relative: &str,
) -> Result<(std::fs::File, std::fs::Metadata), OpenFailure> {
    use std::os::fd::OwnedFd;
    use std::path::Component;

    use rustix::fs::{open, openat, Mode, OFlags};

    let directory_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
    let nofollow_flags = directory_flags | OFlags::NOFOLLOW;
    let mut dir: OwnedFd = open(root, nofollow_flags, Mode::empty())
        .map_err(|error| OpenFailure::Error(anyhow::Error::from(error)))?;

    let components: Vec<_> = Path::new(relative)
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_os_string()),
            _ => None,
        })
        .collect();
    let Some((name, parents)) = components.split_last() else {
        return Err(OpenFailure::Unsupported(
            "A file path is required.".to_string(),
        ));
    };
    for parent in parents {
        dir = openat(&dir, parent, nofollow_flags, Mode::empty()).map_err(map_open_error)?;
    }
    let fd = openat(
        &dir,
        name,
        // O_NONBLOCK keeps a FIFO raced into place from blocking the async
        // runtime; the type check on the opened handle then rejects it.
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(map_open_error)?;
    let file = std::fs::File::from(fd);
    let metadata = file
        .metadata()
        .map_err(|error| OpenFailure::Error(anyhow::Error::from(error)))?;
    Ok((file, metadata))
}

#[cfg(unix)]
fn map_open_error(error: rustix::io::Errno) -> OpenFailure {
    match error {
        rustix::io::Errno::NOENT => OpenFailure::Missing,
        rustix::io::Errno::ACCESS | rustix::io::Errno::PERM => {
            OpenFailure::Denied("Permission denied while opening this file.".to_string())
        }
        rustix::io::Errno::LOOP | rustix::io::Errno::MLINK => OpenFailure::Unsupported(
            "This path is a symbolic link; previews do not follow links.".to_string(),
        ),
        rustix::io::Errno::NOTDIR => {
            OpenFailure::Unsupported("A component of this path is not a directory.".to_string())
        }
        other => OpenFailure::Error(anyhow::anyhow!("failed to open file preview: {other}")),
    }
}

#[cfg(not(unix))]
fn open_secure(
    _root: &Path,
    _relative: &str,
) -> Result<(std::fs::File, std::fs::Metadata), OpenFailure> {
    Err(OpenFailure::Unsupported(
        "File previews are not available on this platform.".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::preview::v1::FilePreviewStateV1;

    #[test]
    fn classifies_text_and_counts_exact_omitted_bytes() {
        let preview = classify("notes.txt", b"hello\n".to_vec(), 6);
        assert_eq!(preview.state, FilePreviewStateV1::Ready);
        assert!(!preview.binary);
        assert_eq!(preview.text, "hello\n");
        assert!(!preview.truncated);
        assert_eq!(preview.truncated_bytes, 0);
    }

    #[test]
    fn classifies_a_nul_byte_as_binary_without_text() {
        let preview = classify("image.bin", vec![0x89, 0, 1], 3);
        assert_eq!(preview.state, FilePreviewStateV1::Ready);
        assert!(preview.binary);
        assert!(preview.text.is_empty());
        assert_eq!(preview.size, 3);
    }

    #[test]
    fn a_nul_byte_late_in_the_file_is_still_binary() {
        let mut bytes = vec![b'a'; 32 * 1024];
        bytes.push(0);
        let size = u64::try_from(bytes.len()).unwrap();
        let preview = classify("late-nul.bin", bytes, size);
        assert!(preview.binary);
        assert!(preview.text.is_empty());
    }

    #[test]
    fn truncates_at_the_byte_cap_and_reports_the_real_remainder() {
        let bytes = vec![b'a'; MAX_PREVIEW_BYTES.saturating_add(1)];
        let size = u64::try_from(MAX_PREVIEW_BYTES).unwrap() + 5;
        let preview = classify("large.txt", bytes, size);
        assert_eq!(preview.state, FilePreviewStateV1::Ready);
        assert!(preview.truncated);
        assert_eq!(preview.text.len(), MAX_PREVIEW_BYTES);
        assert_eq!(preview.truncated_bytes, 5);
    }

    #[test]
    fn a_multibyte_character_cut_by_the_cap_is_not_replaced_with_garbage() {
        let mut bytes = vec![b'a'; MAX_PREVIEW_BYTES.saturating_sub(1)];
        bytes.extend_from_slice("€".as_bytes());
        let size = u64::try_from(bytes.len()).unwrap();
        let preview = classify("unicode.txt", bytes, size);
        assert_eq!(preview.state, FilePreviewStateV1::Ready);
        assert!(!preview.binary);
        assert!(preview.truncated);
        assert!(preview.text.chars().all(|c| c == 'a'));
        assert_eq!(preview.truncated_bytes, 3);
    }

    #[test]
    fn invalid_utf8_is_not_shown_as_text() {
        let preview = classify("latin1.txt", vec![0xE9, 0xE8], 2);
        assert_eq!(preview.state, FilePreviewStateV1::Ready);
        assert!(preview.binary);
        assert!(preview.text.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_final_symlink_instead_of_following_it() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), root.path().join("link"))
            .unwrap();

        match open_secure(root.path(), "link") {
            Err(OpenFailure::Unsupported(message)) => assert!(message.contains("symbolic link")),
            _ => panic!("a final symlink must be refused"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_parent_instead_of_following_it() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linked-dir")).unwrap();

        match open_secure(root.path(), "linked-dir/secret") {
            Err(OpenFailure::Unsupported(_)) => {}
            _ => panic!("a symlinked parent must be refused"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_cannot_block_the_open_and_is_not_a_regular_file() {
        let root = tempfile::tempdir().unwrap();
        let fifo = root.path().join("pipe");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("mkfifo is available on supported Unix hosts");
        assert!(status.success(), "fixture FIFO creation failed");

        let root_for_thread = root.path().to_path_buf();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(open_secure(&root_for_thread, "pipe"));
        });
        match receiver.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok((_, metadata))) => assert!(!metadata.is_file()),
            Ok(Err(failure)) => panic!("a FIFO must not be opened as a preview: {failure:?}"),
            Err(_) => panic!("opening a FIFO must not block the preview read"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn detects_a_path_replaced_after_the_handle_was_opened() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "original").unwrap();
        let (_, metadata) = open_secure(root.path(), "note.txt").expect("a regular file opens");
        assert!(same_file_still_at(root.path(), "note.txt", &metadata));

        let replacement = root.path().join("replacement.txt");
        std::fs::write(&replacement, "replacement").unwrap();
        std::fs::rename(&replacement, root.path().join("note.txt")).unwrap();
        assert!(
            !same_file_still_at(root.path(), "note.txt", &metadata),
            "a replaced path must not be accepted as the opened file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn detects_a_repository_root_replaced_after_the_read_started() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let metadata = std::fs::symlink_metadata(&root).unwrap();
        assert!(same_root_still_at(&root, &metadata));

        std::fs::rename(&root, parent.path().join("old-repo")).unwrap();
        std::fs::create_dir(&root).unwrap();
        assert!(
            !same_root_still_at(&root, &metadata),
            "a replaced repository root must not be accepted"
        );
    }

    #[cfg(unix)]
    #[test]
    fn reads_a_regular_file_relative_to_the_root() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "hello").unwrap();
        let (_, metadata) = open_secure(root.path(), "note.txt").expect("a regular file opens");
        assert!(metadata.is_file());
        assert_eq!(metadata.len(), 5);
    }
}
