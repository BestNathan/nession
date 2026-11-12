//! Deterministic EROFS build from a controlled snapshot (#3022).
//!
//! The builder runs only Git plumbing and `mkfs.erofs`. It never executes
//! repository code, hooks or package scripts. Packaging parameters are fixed by
//! the V1 contract and are recorded beside the digest, so a rebuilt source tree
//! with the same inputs produces the same immutable bytes.

use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use crate::git::{self, GitCommandRunner, GitTarget};
use crate::store::{BlobDigest, BlobStore};

/// The fixed filesystem UUID V1 passes to `mkfs.erofs`.
///
/// The wire contract (`nession-protocol`) owns the accepted V1 value; this is
/// the builder's mechanical constant for the same bytes.
pub const FIXED_UUID: &str = "11111111-1111-4111-8111-111111111111";
/// The only block size V1 accepts.
pub const BLOCK_SIZE: u32 = 4096;
/// The fixed timestamp V1 passes to `mkfs.erofs`.
pub const FIXED_TIMESTAMP: i64 = 0;
/// The only compression mode V1 accepts.
pub const COMPRESSION: &str = "none";

/// Mechanical packaging inputs for one deterministic build.
///
/// This is the builder's own type; `nession-protocol`'s versioned
/// `ImagePackaging` DTO is translated by the runtime adapter after wire
/// validation. Keeping the builder free of wire types is what lets a non-
/// Nession consumer build the same bytes without the Protocol Kernel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packaging {
    pub block_size: u32,
    pub compression: String,
    pub fixed_timestamp: i64,
    pub fixed_uuid: String,
}

impl Default for Packaging {
    fn default() -> Self {
        Self {
            block_size: BLOCK_SIZE,
            compression: COMPRESSION.to_string(),
            fixed_timestamp: FIXED_TIMESTAMP,
            fixed_uuid: FIXED_UUID.to_string(),
        }
    }
}

impl Packaging {
    /// The invariants `mkfs.erofs` itself needs. Wire-specific rejection stays
    /// in the Protocol Kernel's `validate_packaging`.
    pub fn validate(&self) -> Result<()> {
        if self.block_size == 0 {
            anyhow::bail!("EROFS packaging block size must be positive");
        }
        if self.compression.trim().is_empty() {
            anyhow::bail!("EROFS packaging compression must not be empty");
        }
        if self.fixed_uuid.trim().is_empty() {
            anyhow::bail!("EROFS packaging UUID must not be empty");
        }
        Ok(())
    }
}

/// The maximum bytes one snapshot may contain before `mkfs.erofs` runs.
pub const MAX_SNAPSHOT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// The maximum entries one snapshot may contain.
pub const MAX_SNAPSHOT_ENTRIES: usize = 200_000;

/// One produced image and the inputs that determine its digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltImage {
    pub blob: BlobDigest,
    pub source_sha: Option<String>,
    pub packaging: Packaging,
}

/// Runs `mkfs.erofs`. Tests substitute a deterministic fake; production uses
/// the host binary.
pub trait MkfsRunner: Send + Sync {
    fn run(&self, args: &[String]) -> Result<()>;
}

/// The host `mkfs.erofs`.
#[derive(Debug, Clone)]
pub struct ProcessMkfsRunner {
    pub binary: PathBuf,
}

impl Default for ProcessMkfsRunner {
    fn default() -> Self {
        Self {
            binary: PathBuf::from("mkfs.erofs"),
        }
    }
}

impl MkfsRunner for ProcessMkfsRunner {
    fn run(&self, args: &[String]) -> Result<()> {
        let output = Command::new(&self.binary)
            .args(args)
            .env("SOURCE_DATE_EPOCH", "0")
            .env("TZ", "UTC")
            .env("LC_ALL", "C")
            .output()
            .with_context(|| format!("failed to execute {}", self.binary.display()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!(
                "mkfs.erofs failed: {}",
                stderr.trim().lines().next().unwrap_or("unknown error")
            );
        }
        Ok(())
    }
}

/// The complete build composition.
#[derive(Clone)]
pub struct ErofsBuilder {
    pub git: Arc<dyn GitCommandRunner>,
    pub mkfs: Arc<dyn MkfsRunner>,
    pub blobs: BlobStore,
    pub work_root: PathBuf,
}

impl ErofsBuilder {
    pub fn new(
        git: Arc<dyn GitCommandRunner>,
        mkfs: Arc<dyn MkfsRunner>,
        blobs: BlobStore,
        work_root: impl Into<PathBuf>,
    ) -> Result<Self> {
        let work_root = work_root.into();
        fs::create_dir_all(&work_root).with_context(|| {
            format!(
                "failed to create image build directory {}",
                work_root.display()
            )
        })?;
        Ok(Self {
            git,
            mkfs,
            blobs,
            work_root,
        })
    }

    /// Build a Git source into the content-addressed store.
    pub fn build_git(&self, target: &GitTarget, packaging: &Packaging) -> Result<BuiltImage> {
        packaging.validate()?;
        let work = tempfile::Builder::new()
            .prefix("nession-erofs-git-")
            .tempdir_in(&self.work_root)
            .context("failed to create image build workspace")?;
        let snapshot = work.path().join("snapshot");
        let git_snapshot = git::materialize(target, &snapshot, self.git.as_ref())?;
        assert_tree_is_safe(&snapshot)?;
        let image = work.path().join("image.erofs");
        self.build_image(&snapshot, &image, packaging)?;
        let blob = self.blobs.put_file(&image)?;
        Ok(BuiltImage {
            blob,
            source_sha: Some(git_snapshot.commit_sha),
            packaging: packaging.clone(),
        })
    }

    /// Build a validated local directory/bundle into the store.
    ///
    /// The source is copied with symlinks preserved but never followed, then
    /// scanned; the build reads the private copy, not the mutable input.
    pub fn build_local(&self, source: &Path, packaging: &Packaging) -> Result<BuiltImage> {
        packaging.validate()?;
        let metadata = fs::symlink_metadata(source)
            .with_context(|| format!("local image source is not readable: {}", source.display()))?;
        if !metadata.is_dir() {
            anyhow::bail!(
                "local image source must be a directory: {}",
                source.display()
            );
        }
        let work = tempfile::Builder::new()
            .prefix("nession-erofs-local-")
            .tempdir_in(&self.work_root)
            .context("failed to create image build workspace")?;
        let snapshot = work.path().join("snapshot");
        copy_tree(source, &snapshot)?;
        assert_tree_is_safe(&snapshot)?;
        let image = work.path().join("image.erofs");
        self.build_image(&snapshot, &image, packaging)?;
        let blob = self.blobs.put_file(&image)?;
        Ok(BuiltImage {
            blob,
            source_sha: None,
            packaging: packaging.clone(),
        })
    }

    fn build_image(&self, snapshot: &Path, image: &Path, packaging: &Packaging) -> Result<()> {
        let args = mkfs_command(image, snapshot, packaging);
        self.mkfs.run(&args)?;
        let metadata = fs::metadata(image)
            .with_context(|| format!("mkfs.erofs produced no image at {}", image.display()))?;
        if metadata.len() == 0 {
            anyhow::bail!("mkfs.erofs produced an empty image");
        }
        Ok(())
    }
}

/// The exact `mkfs.erofs` argv V1 emits, published for tests and operators.
pub fn mkfs_command(image: &Path, root: &Path, packaging: &Packaging) -> Vec<String> {
    let mut args = vec![
        "-T".to_string(),
        packaging.fixed_timestamp.to_string(),
        "-U".to_string(),
        packaging.fixed_uuid.clone(),
        "-b".to_string(),
        packaging.block_size.to_string(),
    ];
    // erofs-utils has no `-z none`; uncompressed is the default. V1 only
    // accepts "none", so this branch is intentionally unreachable today and
    // keeps the command honest if a future version adds a compressor.
    if packaging.compression != "none" {
        args.push("-z".to_string());
        args.push(packaging.compression.clone());
    }
    args.push(image.to_string_lossy().into_owned());
    args.push(root.to_string_lossy().into_owned());
    args
}

/// The fixed UUID V1 uses, published so tests do not restate it.
pub fn fixed_uuid() -> &'static str {
    FIXED_UUID
}

/// Copy a tree without following symlinks. Directories are created 0o755,
/// files 0o644, and symlinks are recreated verbatim; `assert_tree_is_safe`
/// then rejects any link that escapes the snapshot.
pub fn copy_tree(source: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    let mut entries = fs::read_dir(source)
        .with_context(|| format!("failed to read {}", source.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let metadata = fs::symlink_metadata(&from)?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&from)?;
            create_symlink(&target, &to)?;
        } else if metadata.is_dir() {
            copy_tree(&from, &to)?;
        } else if metadata.is_file() {
            fs::copy(&from, &to).with_context(|| format!("failed to copy {}", from.display()))?;
        } else {
            anyhow::bail!(
                "unsupported special file in image source: {}",
                from.display()
            );
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link)
        .with_context(|| format!("failed to recreate symlink {}", link.display()))
}

#[cfg(not(unix))]
fn create_symlink(_target: &Path, link: &Path) -> Result<()> {
    anyhow::bail!(
        "symlinks in image sources are not supported on this platform: {}",
        link.display()
    )
}

/// Reject snapshot content that could make a build read outside its input or
/// embed a special device: absolute/escaping symlinks, special files, and
/// oversized trees.
pub fn assert_tree_is_safe(root: &Path) -> Result<()> {
    let mut state = ScanState::default();
    scan_tree(root, root, &mut state)?;
    Ok(())
}

#[derive(Default)]
struct ScanState {
    entries: usize,
    bytes: u64,
}

fn scan_tree(root: &Path, current: &Path, state: &mut ScanState) -> Result<()> {
    let mut entries = fs::read_dir(current)
        .with_context(|| format!("failed to read {}", current.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        state.entries += 1;
        if state.entries > MAX_SNAPSHOT_ENTRIES {
            anyhow::bail!("image source exceeds the entry bound");
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&path)?;
            if target.is_absolute() {
                anyhow::bail!("absolute symlink is not allowed in an image source");
            }
            let parent = path.parent().unwrap_or(root);
            let resolved = parent.join(&target);
            let normalized = normalize_without_fs(&resolved);
            if !normalized.starts_with(root) {
                anyhow::bail!("symlink escapes the image snapshot");
            }
        } else if metadata.is_dir() {
            scan_tree(root, &path, state)?;
        } else if metadata.is_file() {
            state.bytes = state.bytes.saturating_add(metadata.len());
            if state.bytes > MAX_SNAPSHOT_BYTES {
                anyhow::bail!("image source exceeds the byte bound");
            }
        } else {
            anyhow::bail!(
                "special file is not allowed in an image source: {}",
                path.display()
            );
        }
    }
    Ok(())
}

/// Lexically normalize `.` and `..` without touching the filesystem, so a
/// symlink target is judged as the checkout would resolve it.
fn normalize_without_fs(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;

    /// A deterministic fake `mkfs.erofs`: the image bytes are a hash of the
    /// snapshot's relative paths and file bytes. Real EROFS bytes are produced
    /// by the integration test/Case when erofs-utils is present.
    #[derive(Default)]
    struct FakeMkfs {
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl MkfsRunner for FakeMkfs {
        fn run(&self, args: &[String]) -> Result<()> {
            self.calls.lock().unwrap().push(args.to_vec());
            let image = Path::new(args.get(args.len() - 2).unwrap());
            let root = Path::new(args.last().unwrap());
            let mut bytes = Vec::new();
            collect_bytes(root, &mut bytes)?;
            fs::write(image, bytes)?;
            Ok(())
        }
    }

    fn collect_bytes(current: &Path, out: &mut Vec<u8>) -> Result<()> {
        let mut entries = fs::read_dir(current)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let path = entry.path();
            out.extend_from_slice(entry.file_name().to_string_lossy().as_bytes());
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() {
                collect_bytes(&path, out)?;
            } else if metadata.is_file() {
                out.extend_from_slice(&fs::read(&path)?);
            }
        }
        Ok(())
    }

    fn test_builder(root: &Path, mkfs: Arc<dyn MkfsRunner>) -> ErofsBuilder {
        ErofsBuilder::new(
            Arc::new(crate::git::ProcessGitRunner::default()),
            mkfs,
            BlobStore::new(root.join("blobs")).unwrap(),
            root.join("work"),
        )
        .unwrap()
    }

    fn local_source(root: &Path) -> PathBuf {
        let source = root.join("source");
        fs::create_dir_all(source.join("sub")).unwrap();
        fs::write(source.join("a.txt"), b"alpha").unwrap();
        fs::write(source.join("sub/b.txt"), b"beta").unwrap();
        source
    }

    #[test]
    fn repeated_local_builds_have_one_digest_and_reuse_one_blob() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let mkfs = Arc::new(FakeMkfs::default());
        let builder = test_builder(root.path(), mkfs);
        let first = builder.build_local(&source, &Packaging::default()).unwrap();
        let second = builder.build_local(&source, &Packaging::default()).unwrap();
        assert_eq!(first.blob.digest, second.blob.digest);
        assert_eq!(first.blob.path, second.blob.path);
        assert_eq!(first.source_sha, None);
    }

    #[test]
    fn a_changed_source_revision_has_a_different_digest() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let builder = test_builder(root.path(), Arc::new(FakeMkfs::default()));
        let first = builder.build_local(&source, &Packaging::default()).unwrap();
        fs::write(source.join("a.txt"), b"changed").unwrap();
        let second = builder.build_local(&source, &Packaging::default()).unwrap();
        assert_ne!(first.blob.digest, second.blob.digest);
        assert!(first.blob.path.exists());
        assert!(second.blob.path.exists());
    }

    #[test]
    fn the_mkfs_argv_is_fixed_and_deterministic() {
        let args = mkfs_command(
            Path::new("/tmp/image.erofs"),
            Path::new("/tmp/snapshot"),
            &Packaging::default(),
        );
        assert_eq!(
            args,
            vec![
                "-T",
                "0",
                "-U",
                fixed_uuid(),
                "-b",
                "4096",
                "/tmp/image.erofs",
                "/tmp/snapshot",
            ]
        );
    }

    #[test]
    fn a_missing_mkfs_helper_fails_explicitly() {
        // A packaging regression must surface as a failed build, never as a
        // healthy image manager with a silently absent tool (#3178).
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let builder = ErofsBuilder::new(
            Arc::new(crate::git::ProcessGitRunner::default()),
            Arc::new(ProcessMkfsRunner {
                binary: root.path().join("missing-mkfs.erofs"),
            }),
            BlobStore::new(root.path().join("blobs")).unwrap(),
            root.path().join("work"),
        )
        .unwrap();
        let error = builder
            .build_local(&source, &Packaging::default())
            .unwrap_err();
        let text = format!("{error:#}");
        assert!(
            text.contains("failed to execute") && text.contains("missing-mkfs.erofs"),
            "{text}"
        );
    }

    #[test]
    fn an_absolute_or_escaping_symlink_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        std::os::unix::fs::symlink("/etc/passwd", source.join("absolute")).unwrap();
        let builder = test_builder(root.path(), Arc::new(FakeMkfs::default()));
        let error = builder
            .build_local(&source, &Packaging::default())
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("absolute symlink"),
            "{error:#}"
        );

        let other = root.path().join("second");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("x"), b"x").unwrap();
        std::os::unix::fs::symlink("../outside", other.join("escaping")).unwrap();
        let builder = test_builder(
            &root.path().join("second-build"),
            Arc::new(FakeMkfs::default()),
        );
        let error = builder
            .build_local(&other, &Packaging::default())
            .unwrap_err();
        assert!(format!("{error:#}").contains("escapes"), "{error:#}");
    }

    #[test]
    fn a_git_snapshot_is_built_with_its_resolved_commit() {
        let root = tempfile::tempdir().unwrap();
        let builder = test_builder(root.path(), Arc::new(FakeMkfs::default()));
        let source = local_source(root.path());
        let git_dir = root.path().join("repo");
        fs::create_dir_all(&git_dir).unwrap();
        let git = |args: &[&str]| {
            assert!(Command::new("git")
                .args(args)
                .current_dir(&git_dir)
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .env_remove("GIT_INDEX_FILE")
                .env_remove("GIT_COMMON_DIR")
                .env_remove("GIT_OBJECT_DIRECTORY")
                .env("GIT_AUTHOR_NAME", "Fixture")
                .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
                .env("GIT_COMMITTER_NAME", "Fixture")
                .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
                .status()
                .unwrap()
                .success());
        };
        git(&["init", "-q"]);
        fs::write(git_dir.join("a.txt"), b"from git").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "first"]);
        let sha = String::from_utf8(
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&git_dir)
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .env_remove("GIT_INDEX_FILE")
                .env_remove("GIT_COMMON_DIR")
                .env_remove("GIT_OBJECT_DIRECTORY")
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        let target = GitTarget {
            repository_url: git_dir.to_string_lossy().into_owned(),
            reference: sha.clone(),
            requested_sha: Some(sha.clone()),
        };
        let built = builder.build_git(&target, &Packaging::default()).unwrap();
        assert_eq!(built.source_sha.as_deref(), Some(sha.as_str()));
        let mut file = std::fs::File::open(&built.blob.path).unwrap();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut bytes).unwrap();
        assert!(bytes.windows(8).any(|w| w == b"from git"));
        let _ = source;
    }

    #[test]
    #[ignore = "requires erofs-utils; executed by the #3022 acceptance Case"]
    fn real_erofs_build_is_deterministic() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let builder = ErofsBuilder::new(
            Arc::new(crate::git::ProcessGitRunner::default()),
            Arc::new(ProcessMkfsRunner::default()),
            BlobStore::new(root.path().join("blobs")).unwrap(),
            root.path().join("work"),
        )
        .unwrap();
        let first = builder.build_local(&source, &Packaging::default()).unwrap();
        let second = builder.build_local(&source, &Packaging::default()).unwrap();
        assert_eq!(first.blob.digest, second.blob.digest);
        let image = fs::read(&first.blob.path).unwrap();
        assert_eq!(
            image.get(1024..1028),
            Some([0xe2_u8, 0xe1, 0xf5, 0xe0].as_slice()),
            "EROFS superblock magic at byte 1024"
        );
        let mut file = std::fs::File::create(root.path().join("probe.txt")).unwrap();
        file.write_all(b"probe").unwrap();
    }
}
