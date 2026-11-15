//! Storage and helper probing for a shared writable Overlay (#3582).
//!
//! `fuse-overlayfs` keeps its metadata in `user.*` xattrs and assumes it is the
//! only writer of the upper/work pair. Nession therefore validates the backing
//! filesystem before any mount:
//!
//! - the upper and work directories must be on the same local filesystem;
//! - the filesystem must support user xattrs;
//! - network or userspace-forwarded filesystems (NFS/CIFS/9p/virtiofs/FUSE)
//!   are refused, because another node/mount namespace could mount the same
//!   durable upper without Nession observing it. Cross-node RW use over a
//!   shared PVC is not enabled by this requirement.
//!
//! The probe is measured, never assumed. An unsupported result fails closed;
//! there is no "try it and see" fallback.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::mount;

/// How one backing filesystem may be used for an Overlay upper/work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageSupport {
    /// A local filesystem with the capability Nession validated.
    Local,
    /// Network or forwarded storage; another node may write it.
    Shared,
    /// Not a validated filesystem kind.
    Unsupported,
}

/// The measured facts one upper/work pair exposes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageFacts {
    pub upper_fs: String,
    pub work_fs: String,
    pub upper_device: u64,
    pub work_device: u64,
    /// `user.*` xattrs are accepted by both directories.
    pub xattrs: bool,
}

impl StorageFacts {
    /// A local ext4-shaped fact set, for deterministic state-machine tests.
    pub fn local_for_test() -> Self {
        Self {
            upper_fs: "ext4".to_string(),
            work_fs: "ext4".to_string(),
            upper_device: 1,
            work_device: 1,
            xattrs: true,
        }
    }

    pub fn support(&self) -> StorageSupport {
        classify(&self.upper_fs)
    }

    /// Fail closed unless both directories are on one validated local
    /// filesystem that accepts user xattrs.
    pub fn validate(&self) -> Result<()> {
        self.validate_paths(Path::new("<upper>"), Path::new("<work>"))
    }

    pub fn validate_paths(&self, upper: &Path, work: &Path) -> Result<()> {
        for (path, fs_type) in [(upper, &self.upper_fs), (work, &self.work_fs)] {
            match classify(fs_type) {
                StorageSupport::Local => {}
                StorageSupport::Shared => anyhow::bail!(
                    "Overlay storage {} is on shared filesystem `{fs_type}`; Nession does not \
                     enable cross-node writable upper/work use",
                    path.display()
                ),
                StorageSupport::Unsupported => anyhow::bail!(
                    "Overlay storage {} is on unvalidated filesystem `{fs_type}`",
                    path.display()
                ),
            }
        }
        if self.upper_fs != self.work_fs || self.upper_device != self.work_device {
            anyhow::bail!(
                "Overlay upper {} ({}, device {}) and work {} ({}, device {}) must share one \
                 filesystem",
                upper.display(),
                self.upper_fs,
                self.upper_device,
                work.display(),
                self.work_fs,
                self.work_device
            );
        }
        if !self.xattrs {
            anyhow::bail!(
                "Overlay storage {}/{} does not accept user xattrs; fuse-overlayfs cannot store \
                 its metadata",
                upper.display(),
                work.display()
            );
        }
        Ok(())
    }
}

fn classify(fs_type: &str) -> StorageSupport {
    let normalized = fs_type.to_ascii_lowercase();
    if normalized.starts_with("fuse") {
        return StorageSupport::Shared;
    }
    match normalized.as_str() {
        "ext2" | "ext3" | "ext4" | "xfs" | "btrfs" | "f2fs" | "tmpfs" | "zfs" | "overlay" => {
            StorageSupport::Local
        }
        "nfs" | "nfs4" | "cifs" | "smb3" | "smbfs" | "9p" | "virtiofs" | "ceph" | "glusterfs"
        | "afs" | "lustre" | "gpfs" => StorageSupport::Shared,
        _ => StorageSupport::Unsupported,
    }
}

/// Measure the backing filesystem of one Overlay upper/work pair.
pub fn probe_storage(upper: &Path, work: &Path) -> Result<StorageFacts> {
    for path in [upper, work] {
        let metadata = std::fs::symlink_metadata(path)
            .with_context(|| format!("inspect Overlay storage {}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            anyhow::bail!(
                "Overlay storage {} must be a real directory",
                path.display()
            );
        }
    }
    let upper_fs = filesystem_type(upper)?;
    let work_fs = filesystem_type(work)?;
    #[cfg(unix)]
    let (upper_device, work_device) = {
        use std::os::unix::fs::MetadataExt;
        let upper_metadata = std::fs::symlink_metadata(upper)?;
        let work_metadata = std::fs::symlink_metadata(work)?;
        (upper_metadata.dev(), work_metadata.dev())
    };
    #[cfg(not(unix))]
    let (upper_device, work_device) = (0, 0);
    Ok(StorageFacts {
        upper_fs,
        work_fs,
        upper_device,
        work_device,
        xattrs: xattrs_supported(upper) && xattrs_supported(work),
    })
}

/// The filesystem type containing `path`, derived from the longest mountpoint
/// prefix in this process's mount table.
pub fn filesystem_type(path: &Path) -> Result<String> {
    let canonical = std::fs::canonicalize(path)
        .with_context(|| format!("resolve Overlay storage {}", path.display()))?;
    let mut best: Option<(PathBuf, String)> = None;
    for entry in mount::mount_entries() {
        if canonical.starts_with(&entry.mountpoint)
            && best.as_ref().is_none_or(|(known, _)| {
                entry.mountpoint.components().count() > known.components().count()
            })
        {
            best = Some((entry.mountpoint, entry.fs_type));
        }
    }
    match best {
        Some((_, fs_type)) => Ok(fs_type),
        None => anyhow::bail!(
            "no mount table entry contains Overlay storage {}",
            canonical.display()
        ),
    }
}

fn xattrs_supported(directory: &Path) -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;

        let probe = directory.join(format!(".nession-overlay-probe-{}", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            std::fs::write(&probe, b"probe")?;
            let path = std::ffi::CString::new(probe.as_os_str().as_bytes())
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
            let name = std::ffi::CString::new("user.nession.overlay")
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
            let value = b"1";
            let status = unsafe {
                libc::setxattr(
                    path.as_ptr(),
                    name.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                )
            };
            if status != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        })();
        let _ = std::fs::remove_file(&probe);
        result.is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = directory;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_facts_validate() {
        StorageFacts::local_for_test().validate().unwrap();
    }

    #[test]
    fn a_network_filesystem_is_refused() {
        let mut facts = StorageFacts::local_for_test();
        facts.upper_fs = "nfs".to_string();
        facts.work_fs = "nfs".to_string();
        let error = facts.validate().unwrap_err();
        assert!(
            format!("{error:#}").contains("shared filesystem"),
            "{error:#}"
        );
    }

    #[test]
    fn split_filesystems_are_refused() {
        let mut facts = StorageFacts::local_for_test();
        facts.work_fs = "xfs".to_string();
        let error = facts.validate().unwrap_err();
        assert!(
            format!("{error:#}").contains("must share one filesystem"),
            "{error:#}"
        );
        let mut facts = StorageFacts::local_for_test();
        facts.work_device = 2;
        assert!(facts.validate().is_err());
    }

    #[test]
    fn missing_xattr_support_is_refused() {
        let mut facts = StorageFacts::local_for_test();
        facts.xattrs = false;
        let error = facts.validate().unwrap_err();
        assert!(format!("{error:#}").contains("user xattrs"), "{error:#}");
    }

    #[test]
    fn an_unvalidated_filesystem_is_refused() {
        let mut facts = StorageFacts::local_for_test();
        facts.upper_fs = "mysteryfs".to_string();
        facts.work_fs = "mysteryfs".to_string();
        let error = facts.validate().unwrap_err();
        assert!(
            format!("{error:#}").contains("unvalidated filesystem"),
            "{error:#}"
        );
    }

    #[test]
    fn a_fuse_backed_directory_is_shared_not_local() {
        assert_eq!(classify("fuse.erofsfuse"), StorageSupport::Shared);
        assert_eq!(classify("fuse-overlayfs"), StorageSupport::Shared);
        assert_eq!(classify("ext4"), StorageSupport::Local);
    }
}
