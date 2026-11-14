//! OCI Image Manifest.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::descriptor::Descriptor;
use super::UnknownFields;

/// An OCI Image Manifest whose subject is one raw EROFS layer in v1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    pub config: Descriptor,
    pub layers: Vec<Descriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<Descriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<BTreeMap<String, String>>,
    #[serde(flatten)]
    pub extra: UnknownFields,
}

impl Manifest {
    /// Return this manifest with one annotation replaced, leaving the layer
    /// descriptors untouched.
    ///
    /// The caller serializes the result into new bytes; those bytes are a new
    /// Manifest digest, while the EROFS layer digest remains unchanged.
    pub fn with_annotation(&self, key: &str, value: &str) -> Self {
        let mut updated = self.clone();
        let annotations = updated.annotations.get_or_insert_with(BTreeMap::new);
        annotations.insert(key.to_string(), value.to_string());
        updated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            schema_version: 2,
            media_type: Some("application/vnd.oci.image.manifest.v1+json".to_string()),
            config: Descriptor {
                media_type: "application/vnd.oci.image.config.v1+json".to_string(),
                digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
                size: 1,
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: UnknownFields::new(),
            },
            layers: vec![Descriptor {
                media_type: "application/vnd.erofs".to_string(),
                digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .to_string(),
                size: 2,
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: UnknownFields::new(),
            }],
            subject: None,
            artifact_type: None,
            annotations: None,
            extra: UnknownFields::new(),
        }
    }

    #[test]
    fn changing_an_annotation_changes_the_manifest_digest_only() {
        let manifest = manifest();
        let layer_digest = manifest.layers.first().unwrap().digest.clone();
        let first = serde_json::to_vec(&manifest).unwrap();
        let second =
            serde_json::to_vec(&manifest.with_annotation("io.nession.kind", "tool")).unwrap();
        assert_ne!(
            crate::digest::digest_of_bytes(&first),
            crate::digest::digest_of_bytes(&second)
        );
        assert_eq!(
            manifest
                .with_annotation("io.nession.kind", "tool")
                .layers
                .first()
                .unwrap()
                .digest,
            layer_digest
        );
    }

    #[test]
    fn subject_and_artifact_type_are_preserved() {
        let raw = r#"{
          "schemaVersion": 2,
          "config": {"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1},
          "layers": [{"mediaType":"application/vnd.erofs","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":2}],
          "subject": {"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","size":3},
          "artifactType": "application/vnd.example",
          "annotations": {"x": "y"}
        }"#;
        let manifest: Manifest = serde_json::from_str(raw).unwrap();
        assert!(manifest.subject.is_some());
        assert_eq!(
            manifest.artifact_type.as_deref(),
            Some("application/vnd.example")
        );
        assert_eq!(
            manifest.annotations.as_ref().and_then(|map| map.get("x")),
            Some(&"y".to_string())
        );
        let serialized = serde_json::to_string(&manifest).unwrap();
        assert!(serialized.contains("\"subject\""));
        assert!(serialized.contains("\"artifactType\""));
    }
}
