//! Standard media types and the small set of advisory Nession annotations.

use anyhow::Result;
use std::collections::BTreeMap;
use std::fmt;

/// OCI Image Index media type.
pub const MEDIA_TYPE_INDEX: &str = "application/vnd.oci.image.index.v1+json";
/// OCI Image Manifest media type.
pub const MEDIA_TYPE_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";
/// OCI Image Config media type.
pub const MEDIA_TYPE_CONFIG: &str = "application/vnd.oci.image.config.v1+json";
/// The raw EROFS layer media type from the EROFS Image Spec.
pub const MEDIA_TYPE_EROFS: &str = "application/vnd.erofs";

/// Advisory image kind. It never classifies format validity or authorization.
pub const ANNOTATION_KIND: &str = "io.nession.kind";
/// Advisory default mount target suggestion.
pub const ANNOTATION_MOUNT_DEFAULT: &str = "io.nession.mount.default";
/// Advisory executable directory below the actual mountpoint.
pub const ANNOTATION_PATH_PREPEND: &str = "io.nession.path.prepend";

/// The three advisory Nession image kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    BaseRuntime,
    Tool,
    Directory,
}

impl ImageKind {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "base_runtime" => Ok(Self::BaseRuntime),
            "tool" => Ok(Self::Tool),
            "directory" => Ok(Self::Directory),
            other => anyhow::bail!(
                "unsupported {ANNOTATION_KIND} value {other:?}: expected base_runtime, tool or directory"
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::BaseRuntime => "base_runtime",
            Self::Tool => "tool",
            Self::Directory => "directory",
        }
    }
}

impl fmt::Display for ImageKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The typed, advisory usage hints read from a Manifest's annotations.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NessionUsage {
    pub kind: Option<ImageKind>,
    pub mount_default: Option<String>,
    pub path_prepend: Option<String>,
}

impl NessionUsage {
    /// Read the Nession annotations from a Manifest.
    ///
    /// Only `io.nession.kind`, `io.nession.mount.default` and
    /// `io.nession.path.prepend` are interpreted. Other `io.nession.*` keys
    /// and every `org.erofs.*` annotation are retained by the caller but never
    /// reinterpreted here.
    pub fn from_annotations(annotations: Option<&BTreeMap<String, String>>) -> Result<Self> {
        let Some(annotations) = annotations else {
            return Ok(Self::default());
        };
        if let Some(key) = annotations
            .keys()
            .find(|key| key.starts_with("io.nession.env."))
        {
            anyhow::bail!(
                "{key} is not a runtime environment owner: use the standard OCI Config Env"
            );
        }
        let kind = annotations
            .get(ANNOTATION_KIND)
            .map(|value| ImageKind::parse(value))
            .transpose()?;
        let mount_default = annotations
            .get(ANNOTATION_MOUNT_DEFAULT)
            .map(|value| validate_mount_target(value))
            .transpose()?;
        let path_prepend = annotations
            .get(ANNOTATION_PATH_PREPEND)
            .map(|value| validate_relative_prepend(value))
            .transpose()?;
        Ok(Self {
            kind,
            mount_default,
            path_prepend,
        })
    }

    /// Whether no Nession annotation was supplied.
    pub fn is_empty(&self) -> bool {
        self.kind.is_none() && self.mount_default.is_none() && self.path_prepend.is_none()
    }
}

/// An advisory mount target must be a normalized absolute path.
///
/// `/` is refused: the root is owned by the RootFS mapping, never a proposed
/// additional mount target. Empty segments, `.`, `..`, a trailing slash and
/// control characters are refused so the suggestion is already normalized.
pub fn validate_mount_target(value: &str) -> Result<String> {
    if !value.starts_with('/') {
        anyhow::bail!("{ANNOTATION_MOUNT_DEFAULT} must be an absolute path, got {value:?}");
    }
    if value == "/" {
        anyhow::bail!("{ANNOTATION_MOUNT_DEFAULT} must not name the root path '/'");
    }
    if value.ends_with('/') {
        anyhow::bail!("{ANNOTATION_MOUNT_DEFAULT} must not end with '/', got {value:?}");
    }
    if value[1..]
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        anyhow::bail!(
            "{ANNOTATION_MOUNT_DEFAULT} must be normalized (no empty, `.` or `..` segment), got {value:?}"
        );
    }
    if value.chars().any(char::is_control) {
        anyhow::bail!("{ANNOTATION_MOUNT_DEFAULT} must not contain control characters");
    }
    Ok(value.to_string())
}

/// An advisory PATH prepend is a safe relative subdirectory.
pub fn validate_relative_prepend(value: &str) -> Result<String> {
    if value.is_empty() {
        anyhow::bail!("{ANNOTATION_PATH_PREPEND} must not be empty");
    }
    if value.starts_with('/') {
        anyhow::bail!("{ANNOTATION_PATH_PREPEND} must be relative, got {value:?}");
    }
    if value.ends_with('/') {
        anyhow::bail!("{ANNOTATION_PATH_PREPEND} must not end with '/', got {value:?}");
    }
    if value
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        anyhow::bail!(
            "{ANNOTATION_PATH_PREPEND} must be a normalized relative path without `.` or `..`, got {value:?}"
        );
    }
    if value.chars().any(char::is_control) {
        anyhow::bail!("{ANNOTATION_PATH_PREPEND} must not contain control characters");
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn annotations(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn the_three_advisory_annotations_parse() {
        let usage = NessionUsage::from_annotations(Some(&annotations(&[
            (ANNOTATION_KIND, "tool"),
            (ANNOTATION_MOUNT_DEFAULT, "/opt/go"),
            (ANNOTATION_PATH_PREPEND, "bin"),
        ])))
        .unwrap();
        assert_eq!(usage.kind, Some(ImageKind::Tool));
        assert_eq!(usage.mount_default.as_deref(), Some("/opt/go"));
        assert_eq!(usage.path_prepend.as_deref(), Some("bin"));
    }

    #[test]
    fn an_unknown_kind_fails_closed() {
        let error = NessionUsage::from_annotations(Some(&annotations(&[(
            ANNOTATION_KIND,
            "package-manager",
        )])))
        .unwrap_err();
        assert!(error.to_string().contains("unsupported io.nession.kind"));
    }

    #[test]
    fn environment_annotations_are_refused() {
        let error = NessionUsage::from_annotations(Some(&annotations(&[(
            "io.nession.env.PATH",
            "/opt/go/bin",
        )])))
        .unwrap_err();
        assert!(error.to_string().contains("standard OCI Config Env"));
    }

    #[test]
    fn erofs_annotations_are_never_reinterpreted_as_nession_kinds() {
        let usage = NessionUsage::from_annotations(Some(&annotations(&[
            ("org.erofs.kind", "base_runtime"),
            ("org.erofs.mount.default", "/opt/erofs"),
        ])))
        .unwrap();
        assert!(usage.is_empty());
    }

    #[test]
    fn unsafe_targets_and_prepends_are_refused() {
        assert!(validate_mount_target("opt/go").is_err());
        assert!(validate_mount_target("/opt/../etc").is_err());
        assert!(validate_mount_target("/opt/go/").is_err());
        assert!(validate_relative_prepend("/bin").is_err());
        assert!(validate_relative_prepend("../bin").is_err());
        assert!(validate_relative_prepend("").is_err());
        assert!(validate_mount_target("/opt/go").is_ok());
        assert!(validate_relative_prepend("bin").is_ok());
    }
}
