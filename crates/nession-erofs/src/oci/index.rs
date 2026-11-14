//! OCI Image Index.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::descriptor::Descriptor;
use super::UnknownFields;

/// An OCI Image Index selecting among platform-specific Manifests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default)]
    pub manifests: Vec<Descriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<BTreeMap<String, String>>,
    #[serde(flatten)]
    pub extra: UnknownFields,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_descriptors_retain_platform_and_annotations() {
        let raw = r#"{
          "schemaVersion": 2,
          "mediaType": "application/vnd.oci.image.index.v1+json",
          "manifests": [
            {
              "mediaType": "application/vnd.oci.image.manifest.v1+json",
              "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "size": 10,
              "platform": {
                "architecture": "amd64",
                "os": "linux",
                "os.features": ["erofs"]
              },
              "annotations": {"x": "y"}
            }
          ]
        }"#;
        let index: Index = serde_json::from_str(raw).unwrap();
        assert_eq!(index.manifests.len(), 1);
        let descriptor = index.manifests.first().unwrap();
        let platform = descriptor.platform.as_ref().unwrap();
        assert_eq!(platform.architecture, "amd64");
        assert!(platform.supports_erofs());
        assert_eq!(
            descriptor.annotations.as_ref().and_then(|map| map.get("x")),
            Some(&"y".to_string())
        );
    }
}
