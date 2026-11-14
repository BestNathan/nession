//! OCI content descriptor and platform selection model.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::UnknownFields;

/// An OCI content descriptor.
///
/// Unknown fields are retained so importing and re-exporting a document does
/// not silently discard standard extensions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub media_type: String,
    pub digest: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urls: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<Platform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(flatten)]
    pub extra: UnknownFields,
}

/// The platform fields carried by an OCI descriptor.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Platform {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub architecture: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub os: String,
    #[serde(
        rename = "os.version",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub os_version: Option<String>,
    #[serde(
        rename = "os.features",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub os_features: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// Deprecated by the OCI image spec; retained for import compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub features: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: UnknownFields,
}

impl Platform {
    /// Whether this platform is an exact match for a consumer target.
    ///
    /// OS and architecture must match. A target variant requires the exact
    /// same variant; a descriptor variant is accepted when the target omits a
    /// variant. The consumer's `erofs` OS feature is mandatory for an EROFS
    /// image selection.
    pub fn matches(&self, target: &Platform) -> bool {
        if self.os != target.os || self.architecture != target.architecture {
            return false;
        }
        match (&target.variant, &self.variant) {
            (Some(wanted), Some(actual)) if wanted != actual => return false,
            (Some(_), None) => return false,
            _ => {}
        }
        self.supports_erofs()
    }

    /// Whether `os.features` contains the `erofs` marker.
    pub fn supports_erofs(&self) -> bool {
        self.os_features
            .as_deref()
            .is_some_and(|features| features.iter().any(|feature| feature == "erofs"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform(os: &str, architecture: &str) -> Platform {
        Platform {
            architecture: architecture.to_string(),
            os: os.to_string(),
            os_features: Some(vec!["erofs".to_string()]),
            ..Platform::default()
        }
    }

    #[test]
    fn platform_matching_is_exact_on_os_and_architecture() {
        let amd64 = platform("linux", "amd64");
        assert!(amd64.matches(&platform("linux", "amd64")));
        assert!(!amd64.matches(&platform("linux", "arm64")));
        assert!(!amd64.matches(&platform("darwin", "amd64")));
    }

    #[test]
    fn erofs_feature_is_required() {
        let mut target = platform("linux", "amd64");
        assert!(target.matches(&platform("linux", "amd64")));
        target.os_features = Some(vec!["wasm".to_string()]);
        assert!(!target.matches(&platform("linux", "amd64")));
    }

    #[test]
    fn a_required_variant_must_match() {
        let mut descriptor = platform("linux", "arm64");
        descriptor.variant = Some("v8".to_string());
        let mut target = platform("linux", "arm64");
        target.variant = Some("v8".to_string());
        assert!(descriptor.matches(&target));
        target.variant = Some("v7".to_string());
        assert!(!descriptor.matches(&target));
    }

    #[test]
    fn unknown_descriptor_fields_round_trip() {
        let raw = r#"{"mediaType":"application/vnd.erofs","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":1,"x-extra":"kept"}"#;
        let descriptor: Descriptor = serde_json::from_str(raw).unwrap();
        assert_eq!(
            descriptor.extra.get("x-extra"),
            Some(&serde_json::Value::String("kept".to_string()))
        );
        let serialized = serde_json::to_value(&descriptor).unwrap();
        assert_eq!(
            serialized.get("x-extra"),
            Some(&serde_json::Value::String("kept".to_string()))
        );
    }
}
