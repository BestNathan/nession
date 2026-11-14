//! External OCI-container to raw-EROFS conversion boundary (#3497).
//!
//! Nession does not implement a container runtime or an OCI→EROFS engine. A
//! pinned upstream converter is an explicit external tool; its output is a raw
//! EROFS image plus the source OCI Config Env captured at conversion time.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

use super::import::validate_erofs_file;
use crate::digest::is_valid_digest;
use crate::oci::descriptor::Platform;

/// One conversion request.
#[derive(Debug, Clone)]
pub struct OciConversionRequest {
    /// The upstream image reference, normally `repository[:tag][@sha256:...]`.
    pub reference: String,
    pub platform: Platform,
    /// Private working directory the converter may use.
    pub work_dir: PathBuf,
    /// The raw EROFS file the converter must produce.
    pub erofs_path: PathBuf,
}

/// One successful conversion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OciConversion {
    pub erofs_path: PathBuf,
    /// Standard OCI Config environment captured from the source.
    pub env: Vec<String>,
    /// The pinned source digest when the converter reports one.
    pub source_digest: Option<String>,
}

/// The narrow converter seam. Tests and alternate hosts provide their own.
pub trait OciErofsConverter {
    fn convert(&self, request: &OciConversionRequest) -> Result<OciConversion>;
}

/// An external converter process with a pinned program path.
///
/// The tool contract is fixed by this adapter:
///
/// ```text
/// <program> --reference <ref> --platform <os/arch[/variant]> --output <file> [extra...]
/// ```
///
/// It must write a raw EROFS image to `--output` and a JSON sidecar at
/// `<output>.config.json`:
///
/// ```json
/// {"env": ["PATH=/usr/bin"], "source_digest": "sha256:<64 hex>"}
/// ```
///
/// A missing program is an explicit capability failure, never a silent
/// fallback to a different image.
#[derive(Debug, Clone)]
pub struct ProcessOciConverter {
    pub program: PathBuf,
    pub extra_args: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ConversionSidecar {
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    source_digest: Option<String>,
}

impl OciErofsConverter for ProcessOciConverter {
    fn convert(&self, request: &OciConversionRequest) -> Result<OciConversion> {
        validate_reference(&request.reference)?;
        if !self.program.is_file() {
            anyhow::bail!(
                "OCI→EROFS converter {} is not available; a supported external converter is required",
                self.program.display()
            );
        }
        std::fs::create_dir_all(&request.work_dir).with_context(|| {
            format!(
                "failed to create OCI conversion workspace {}",
                request.work_dir.display()
            )
        })?;
        if let Some(parent) = request.erofs_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let platform = match &request.platform.variant {
            Some(variant) => format!(
                "{}/{}/{}",
                request.platform.os, request.platform.architecture, variant
            ),
            None => format!("{}/{}", request.platform.os, request.platform.architecture),
        };
        let output = Command::new(&self.program)
            .args(&self.extra_args)
            .arg("--reference")
            .arg(&request.reference)
            .arg("--platform")
            .arg(&platform)
            .arg("--output")
            .arg(&request.erofs_path)
            .output()
            .with_context(|| {
                format!(
                    "failed to start OCI→EROFS converter {}",
                    self.program.display()
                )
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!(
                "OCI→EROFS converter failed for {} (status {}): {}",
                request.reference,
                output.status,
                stderr.trim().chars().take(800).collect::<String>()
            );
        }
        validate_erofs_file(&request.erofs_path)
            .context("converter output is not a valid raw EROFS image")?;
        let sidecar_path = sidecar_path(&request.erofs_path);
        let sidecar: ConversionSidecar = serde_json::from_slice(
            &std::fs::read(&sidecar_path)
                .with_context(|| format!("converter did not write {}", sidecar_path.display()))?,
        )
        .context("converter sidecar is not valid JSON")?;
        validate_env(&sidecar.env)?;
        if let Some(digest) = &sidecar.source_digest {
            if !is_valid_digest(digest) {
                anyhow::bail!("converter source digest {digest:?} is not a sha256 digest");
            }
        }
        if let Some(pinned) = pinned_digest(&request.reference) {
            let reported = sidecar.source_digest.as_deref().context(
                "reference pins a digest but the converter did not report its source digest",
            )?;
            if reported != pinned {
                anyhow::bail!("converter imported {reported} but the reference pins {pinned}");
            }
        }
        Ok(OciConversion {
            erofs_path: request.erofs_path.clone(),
            env: sidecar.env,
            source_digest: sidecar.source_digest,
        })
    }
}

fn sidecar_path(erofs_path: &Path) -> PathBuf {
    let mut name = erofs_path.as_os_str().to_owned();
    name.push(".config.json");
    PathBuf::from(name)
}

fn validate_reference(reference: &str) -> Result<()> {
    if reference.is_empty() || reference.len() > 512 {
        anyhow::bail!("OCI source reference must be 1..=512 bytes");
    }
    if reference.chars().any(char::is_control) {
        anyhow::bail!("OCI source reference must not contain control characters");
    }
    Ok(())
}

fn validate_env(env: &[String]) -> Result<()> {
    for variable in env {
        let Some((name, _)) = variable.split_once('=') else {
            anyhow::bail!("OCI source Env entry {variable:?} is not KEY=VALUE");
        };
        if name.is_empty() {
            anyhow::bail!("OCI source Env entry {variable:?} has an empty name");
        }
    }
    Ok(())
}

/// The digest pinned by `repository@sha256:...`, if any.
pub fn pinned_digest(reference: &str) -> Option<&str> {
    let (_, digest) = reference.rsplit_once('@')?;
    is_valid_digest(digest).then_some(digest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::publication::host_platform;
    use tempfile::tempdir;

    #[cfg(unix)]
    fn fake_converter(dir: &Path, sidecar: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-oci-to-erofs");
        let magic = format!(
            "dd if=/dev/zero of=\"$out\" bs=1 count=1028 2>/dev/null\n\
             printf '\\340\\365\\341\\342' | dd of=\"$out\" bs=1 seek=1024 conv=notrunc 2>/dev/null\n\
             printf '%s' '{}' > \"$out.config.json\"\n",
            sidecar.replace('\'', "'\\''")
        );
        let script = format!(
            "#!/bin/sh\nout=\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = \"--output\" ]; then out=$2; fi\n  shift\ndone\n{magic}"
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn a_process_converter_produces_erofs_and_retains_source_env() {
        let dir = tempdir().unwrap();
        let program = fake_converter(
            dir.path(),
            r#"{"env":["PATH=/usr/bin"],"source_digest":null}"#,
        );
        let request = OciConversionRequest {
            reference: "docker.io/library/ubuntu:24.04".to_string(),
            platform: host_platform(),
            work_dir: dir.path().join("work"),
            erofs_path: dir.path().join("out.erofs"),
        };
        let conversion = ProcessOciConverter {
            program,
            extra_args: Vec::new(),
        }
        .convert(&request)
        .unwrap();
        assert_eq!(conversion.env, vec!["PATH=/usr/bin".to_string()]);
        assert!(conversion.erofs_path.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_converter_fails_explicitly() {
        let dir = tempdir().unwrap();
        let request = OciConversionRequest {
            reference: "docker.io/library/ubuntu:24.04".to_string(),
            platform: host_platform(),
            work_dir: dir.path().join("work"),
            erofs_path: dir.path().join("out.erofs"),
        };
        let error = ProcessOciConverter {
            program: dir.path().join("absent-converter"),
            extra_args: Vec::new(),
        }
        .convert(&request)
        .unwrap_err()
        .to_string();
        assert!(error.contains("not available"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_converted_source_publishes_a_fresh_erofs_identity_and_env() {
        let dir = tempdir().unwrap();
        let program = fake_converter(
            dir.path(),
            r#"{"env":["PATH=/opt/go/bin"],"source_digest":null}"#,
        );
        let erofs_path = dir.path().join("converted.erofs");
        let request = OciConversionRequest {
            reference: "docker.io/library/golang:1.24".to_string(),
            platform: host_platform(),
            work_dir: dir.path().join("work"),
            erofs_path: erofs_path.clone(),
        };
        let conversion = ProcessOciConverter {
            program,
            extra_args: Vec::new(),
        }
        .convert(&request)
        .unwrap();
        let store = crate::blob::store::BlobStore::new(dir.path().join("store")).unwrap();
        let conn = crate::catalog::sqlite::tests::memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let imported = crate::build::import::import_raw_erofs(
            &conn,
            &store,
            &conversion.erofs_path,
            &crate::build::import::RawErofsImport {
                repository: "converted".to_string(),
                tag: "go".to_string(),
                expectation: crate::catalog::tag::TagExpectation::Absent,
                platform: request.platform.clone(),
                env: conversion.env.clone(),
                annotations: std::collections::BTreeMap::new(),
            },
        )
        .await
        .unwrap();
        let inspection =
            crate::image::inspect::inspect_manifest(&store, &imported.publication.manifest_digest)
                .unwrap();
        assert_eq!(inspection.layer_digest, imported.layer_digest);
        assert_eq!(
            inspection.config.rootfs.diff_ids,
            vec![imported.layer_digest.clone()],
            "the Config must reference the new EROFS bytes, not an upstream tar layer"
        );
        assert_eq!(inspection.config.env(), &["PATH=/opt/go/bin".to_string()]);
        assert_eq!(
            std::fs::read(&conversion.erofs_path).unwrap(),
            store.read(&imported.layer_digest).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_pinned_reference_must_match_the_reported_source_digest() {
        let dir = tempdir().unwrap();
        let pinned = format!("sha256:{}", "b".repeat(64));
        let reported = format!("sha256:{}", "a".repeat(64));
        let program = fake_converter(
            dir.path(),
            &format!(r#"{{"env":[],"source_digest":"{reported}"}}"#),
        );
        let request = OciConversionRequest {
            reference: format!("docker.io/library/ubuntu@{pinned}"),
            platform: host_platform(),
            work_dir: dir.path().join("work"),
            erofs_path: dir.path().join("out.erofs"),
        };
        let error = ProcessOciConverter {
            program,
            extra_args: Vec::new(),
        }
        .convert(&request)
        .unwrap_err()
        .to_string();
        assert!(error.contains("pins"));
    }

    #[test]
    fn pinned_digest_is_read_only_from_a_valid_reference() {
        let digest = format!("sha256:{}", "c".repeat(64));
        assert_eq!(
            pinned_digest(&format!("repo/image@{digest}")),
            Some(digest.as_str())
        );
        assert_eq!(pinned_digest("repo/image:tag"), None);
        assert_eq!(pinned_digest("repo/image@sha256:short"), None);
    }
}
