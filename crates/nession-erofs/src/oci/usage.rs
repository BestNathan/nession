//! Read-only runtime usage suggestions from a stored Manifest and Config
//! (#3500).
//!
//! This module answers "what does this image suggest about how it could be
//! used at runtime?" — the standard Config `Env`, `Entrypoint`, `Cmd` and
//! `WorkingDir`, plus the advisory `io.nession.kind`,
//! `io.nession.mount.default` and `io.nession.path.prepend` annotations.
//!
//! It is deliberately a *resolver*, not a runtime:
//!
//! - it never executes `Entrypoint`/`Cmd`, evaluates a command template or
//!   performs a PATH search;
//! - it does not own Sandbox policy, mount authorization or environment
//!   precedence — those belong to the Sandbox/Agent adapters that consume the
//!   typed values;
//! - an annotation is never an authorization, and a `kind` never changes the
//!   validity of the EROFS object.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};

use crate::oci::annotation::{
    validate_mount_target, validate_relative_prepend, ImageKind, NessionUsage,
};
use crate::oci::config::ImageConfig;
use crate::oci::manifest::Manifest;

/// Maximum number of standard Config Env entries accepted as a bounded image
/// default.
pub const MAX_IMAGE_ENV_ENTRIES: usize = 128;
/// Maximum length of one Config Env variable name.
pub const MAX_IMAGE_ENV_KEY_BYTES: usize = 255;
/// Maximum length of one Config Env value.
pub const MAX_IMAGE_ENV_VALUE_BYTES: usize = 16 * 1024;
/// Maximum total bytes of all Config Env names and values.
pub const MAX_IMAGE_ENV_TOTAL_BYTES: usize = 64 * 1024;

/// One parsed standard Config `Env` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageEnvDefault {
    pub name: String,
    pub value: String,
}

/// Typed, read-only runtime suggestions read from one image.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImageRuntimeUsage {
    /// Advisory `io.nession.kind`; UI defaults/filter hints only.
    pub kind: Option<ImageKind>,
    /// Advisory `io.nession.mount.default` target suggestion.
    pub mount_default: Option<String>,
    /// Advisory `io.nession.path.prepend` subdirectory, relative to the actual
    /// mount target.
    pub path_prepend: Option<String>,
    /// Standard Config `Env`, parsed and bounded. Duplicate names are
    /// resolved last-wins within one Config, deterministically.
    pub environment: Vec<ImageEnvDefault>,
    /// Standard Config `Entrypoint`. Never executed by this crate.
    pub entrypoint: Option<Vec<String>>,
    /// Standard Config `Cmd`. Never executed by this crate.
    pub cmd: Option<Vec<String>>,
    /// Standard Config `WorkingDir`. A suggestion only; the Sandbox owns the
    /// Session working directory.
    pub working_dir: Option<String>,
}

impl ImageRuntimeUsage {
    /// Read the suggestions from one Manifest and its validated Config.
    pub fn from_manifest_and_config(manifest: &Manifest, config: &ImageConfig) -> Result<Self> {
        let annotations = NessionUsage::from_annotations(manifest.annotations.as_ref())?;
        Ok(Self {
            kind: annotations.kind,
            mount_default: annotations.mount_default,
            path_prepend: annotations.path_prepend,
            environment: parse_config_env(config)?,
            entrypoint: config.config.entrypoint.clone(),
            cmd: config.config.cmd.clone(),
            working_dir: config.config.working_dir.clone(),
        })
    }
}

/// Parse the standard Config `Env` into bounded `NAME=VALUE` pairs.
///
/// OCI Config Env is an ordered list of `NAME=VALUE` strings. A later entry
/// for the same name replaces the earlier value (standard container
/// semantics), so the result is deterministic without depending on map
/// iteration order. Malformed entries, invalid names, NUL bytes and an
/// over-budget list fail closed: an image is never partially interpreted.
pub fn parse_config_env(config: &ImageConfig) -> Result<Vec<ImageEnvDefault>> {
    let entries = config.env();
    if entries.len() > MAX_IMAGE_ENV_ENTRIES {
        anyhow::bail!(
            "the image Config Env has {} entries, above the bounded maximum {MAX_IMAGE_ENV_ENTRIES}",
            entries.len()
        );
    }
    let mut positions: BTreeMap<String, usize> = BTreeMap::new();
    let mut parsed: Vec<ImageEnvDefault> = Vec::with_capacity(entries.len());
    let mut total_bytes = 0usize;
    for (index, entry) in entries.iter().enumerate() {
        let Some((name, value)) = entry.split_once('=') else {
            anyhow::bail!("the image Config Env entry {index} is not NAME=VALUE: {entry:?}");
        };
        validate_env_name(name).with_context(|| {
            format!("the image Config Env entry {index} has an invalid variable name")
        })?;
        if value.contains('\0') {
            anyhow::bail!("the image Config Env entry for {name} contains NUL");
        }
        if name.len() > MAX_IMAGE_ENV_KEY_BYTES {
            anyhow::bail!(
                "the image Config Env variable {name} is longer than {MAX_IMAGE_ENV_KEY_BYTES} bytes"
            );
        }
        if value.len() > MAX_IMAGE_ENV_VALUE_BYTES {
            anyhow::bail!(
                "the image Config Env variable {name} has a value longer than \
                 {MAX_IMAGE_ENV_VALUE_BYTES} bytes"
            );
        }
        total_bytes = total_bytes
            .saturating_add(name.len())
            .saturating_add(value.len());
        if total_bytes > MAX_IMAGE_ENV_TOTAL_BYTES {
            anyhow::bail!(
                "the image Config Env exceeds the bounded total of {MAX_IMAGE_ENV_TOTAL_BYTES} bytes"
            );
        }
        let value = value.to_string();
        match positions.get(name) {
            Some(&position) => {
                if let Some(slot) = parsed.get_mut(position) {
                    slot.value = value;
                }
            }
            None => {
                positions.insert(name.to_string(), parsed.len());
                parsed.push(ImageEnvDefault {
                    name: name.to_string(),
                    value,
                });
            }
        }
    }
    Ok(parsed)
}

/// Validate one portable environment variable name.
pub fn validate_env_name(name: &str) -> Result<()> {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        anyhow::bail!("an environment variable name must not be empty");
    };
    if !(first.is_ascii_alphabetic() || first == b'_') {
        anyhow::bail!("environment variable name {name:?} must start with a letter or `_`");
    }
    if !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_') {
        anyhow::bail!(
            "environment variable name {name:?} may contain only ASCII letters, digits and `_`"
        );
    }
    Ok(())
}

/// Resolve an advisory (relative) `path.prepend` against the *actual* mount
/// target.
///
/// `mount_target` is the target the mount will actually use (the annotation
/// proposal or a user/Session override), never the annotation value. The
/// result is a normalized absolute sandbox path that stays strictly below the
/// target: absolute prepends, `..`, `.` segments, empty segments, trailing
/// slashes and control characters are refused.
pub fn resolve_path_prepend(mount_target: &str, prepend: &str) -> Result<String> {
    let target = validate_mount_target(mount_target)
        .with_context(|| format!("invalid mount target {mount_target:?}"))?;
    let prepend = validate_relative_prepend(prepend)
        .with_context(|| format!("invalid path.prepend {prepend:?}"))?;
    let target_path = Path::new(&target);
    let resolved = format!("{target}/{prepend}");
    let resolved_path = Path::new(&resolved);
    if resolved_path == target_path || !resolved_path.starts_with(target_path) {
        anyhow::bail!(
            "path.prepend {prepend:?} does not resolve strictly below mount target {target:?}"
        );
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oci::config::{RootFs, RuntimeConfig};
    use crate::oci::descriptor::Descriptor;
    use crate::oci::UnknownFields;

    fn descriptor(media_type: &str, digest: String, size: u64) -> Descriptor {
        Descriptor {
            media_type: media_type.to_string(),
            digest,
            size,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: UnknownFields::new(),
        }
    }

    fn manifest(annotations: Option<BTreeMap<String, String>>, layer: &str) -> Manifest {
        Manifest {
            schema_version: 2,
            media_type: Some(crate::oci::MEDIA_TYPE_MANIFEST.to_string()),
            config: descriptor(
                crate::oci::MEDIA_TYPE_CONFIG,
                format!("sha256:{}", "c".repeat(64)),
                2,
            ),
            layers: vec![descriptor(
                crate::oci::MEDIA_TYPE_EROFS,
                layer.to_string(),
                4,
            )],
            subject: None,
            artifact_type: None,
            annotations,
            extra: UnknownFields::new(),
        }
    }

    fn config(env: Option<Vec<String>>, working_dir: Option<&str>) -> ImageConfig {
        ImageConfig {
            created: None,
            author: None,
            architecture: "amd64".to_string(),
            os: "linux".to_string(),
            os_version: None,
            os_features: Some(vec!["erofs".to_string()]),
            variant: None,
            config: RuntimeConfig {
                env,
                entrypoint: Some(vec!["/entrypoint".to_string()]),
                cmd: Some(vec!["serve".to_string()]),
                working_dir: working_dir.map(str::to_string),
                ..RuntimeConfig::default()
            },
            rootfs: RootFs {
                fs_type: "layers".to_string(),
                diff_ids: vec![format!("sha256:{}", "d".repeat(64))],
                extra: UnknownFields::new(),
            },
            history: Vec::new(),
            extra: UnknownFields::new(),
        }
    }

    fn annotations(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn layer(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    #[test]
    fn a_go_tool_manifest_exposes_its_standard_config_and_advisory_annotations() {
        let annotations = annotations(&[
            (crate::oci::ANNOTATION_KIND, "tool"),
            (crate::oci::ANNOTATION_MOUNT_DEFAULT, "/opt/go"),
            (crate::oci::ANNOTATION_PATH_PREPEND, "bin"),
        ]);
        let usage = ImageRuntimeUsage::from_manifest_and_config(
            &manifest(Some(annotations), &layer('a')),
            &config(
                Some(vec!["GOTOOLCHAIN=local".to_string(), "LANG=C".to_string()]),
                Some("/src"),
            ),
        )
        .unwrap();
        assert_eq!(usage.kind, Some(ImageKind::Tool));
        assert_eq!(usage.mount_default.as_deref(), Some("/opt/go"));
        assert_eq!(usage.path_prepend.as_deref(), Some("bin"));
        assert_eq!(
            usage.environment,
            vec![
                ImageEnvDefault {
                    name: "GOTOOLCHAIN".to_string(),
                    value: "local".to_string(),
                },
                ImageEnvDefault {
                    name: "LANG".to_string(),
                    value: "C".to_string(),
                },
            ]
        );
        assert_eq!(
            usage.entrypoint.as_deref(),
            Some(&["/entrypoint".to_string()][..])
        );
        assert_eq!(usage.cmd.as_deref(), Some(&["serve".to_string()][..]));
        assert_eq!(usage.working_dir.as_deref(), Some("/src"));
    }

    #[test]
    fn changing_an_annotation_never_changes_the_erofs_layer_identity() {
        let layer = layer('a');
        let plain = ImageRuntimeUsage::from_manifest_and_config(
            &manifest(None, &layer),
            &config(None, None),
        )
        .unwrap();
        let annotated = ImageRuntimeUsage::from_manifest_and_config(
            &manifest(
                Some(annotations(&[
                    (crate::oci::ANNOTATION_MOUNT_DEFAULT, "/opt/go"),
                    (crate::oci::ANNOTATION_PATH_PREPEND, "bin"),
                ])),
                &layer,
            ),
            &config(None, None),
        )
        .unwrap();
        assert_eq!(plain.mount_default, None);
        assert_eq!(annotated.mount_default.as_deref(), Some("/opt/go"));
        // The resolver never carries or derives a layer identity; the digest
        // is supplied by the caller and is unchanged here.
        assert_eq!(layer, format!("sha256:{}", "a".repeat(64)));
    }

    #[test]
    fn the_prepend_is_relative_to_the_actual_mount_target() {
        assert_eq!(
            resolve_path_prepend("/opt/go", "bin").unwrap(),
            "/opt/go/bin"
        );
        assert_eq!(
            resolve_path_prepend("/tools/go", "bin").unwrap(),
            "/tools/go/bin",
            "a user/Session override rebases the advisory prepend"
        );
        assert_eq!(
            resolve_path_prepend("/opt/go", "libexec/bin").unwrap(),
            "/opt/go/libexec/bin"
        );
    }

    #[test]
    fn escapes_and_malformed_prepends_are_refused() {
        for prepend in [
            "/bin",
            "../bin",
            "bin/../../etc",
            "bin/",
            "./bin",
            "bin//x",
            "",
        ] {
            assert!(
                resolve_path_prepend("/opt/go", prepend).is_err(),
                "{prepend:?} must be refused"
            );
        }
        for target in ["opt/go", "/opt/../go", "/opt/go/", "/opt//go", "/"] {
            assert!(
                resolve_path_prepend(target, "bin").is_err(),
                "{target:?} must be refused"
            );
        }
    }

    #[test]
    fn config_env_is_bounded_and_last_wins_within_one_image() {
        let parsed = parse_config_env(&config(
            Some(vec![
                "PATH=/opt/go/bin".to_string(),
                "A=1".to_string(),
                "A=2".to_string(),
                "B=".to_string(),
            ]),
            None,
        ))
        .unwrap();
        assert_eq!(
            parsed,
            vec![
                ImageEnvDefault {
                    name: "PATH".to_string(),
                    value: "/opt/go/bin".to_string(),
                },
                ImageEnvDefault {
                    name: "A".to_string(),
                    value: "2".to_string(),
                },
                ImageEnvDefault {
                    name: "B".to_string(),
                    value: String::new(),
                },
            ]
        );
    }

    #[test]
    fn malformed_or_unbounded_config_env_fails_closed() {
        assert!(parse_config_env(&config(Some(vec!["NO_VALUE".to_string()]), None)).is_err());
        assert!(parse_config_env(&config(Some(vec!["1BAD=x".to_string()]), None)).is_err());
        let too_many = (0..MAX_IMAGE_ENV_ENTRIES + 1)
            .map(|index| format!("K{index}=v"))
            .collect();
        assert!(parse_config_env(&config(Some(too_many), None)).is_err());
        let long_value = vec![format!("K={}", "v".repeat(MAX_IMAGE_ENV_VALUE_BYTES + 1))];
        assert!(parse_config_env(&config(Some(long_value), None)).is_err());
    }

    #[test]
    fn entrypoint_and_cmd_are_suggestions_never_executed() {
        let usage = ImageRuntimeUsage::from_manifest_and_config(
            &manifest(None, &layer('a')),
            &config(None, None),
        )
        .unwrap();
        // Reading them creates no process and no side effect; the test simply
        // documents that they are exposed as data.
        assert_eq!(
            usage.entrypoint.as_deref(),
            Some(&["/entrypoint".to_string()][..])
        );
        assert_eq!(usage.cmd.as_deref(), Some(&["serve".to_string()][..]));
    }
}
