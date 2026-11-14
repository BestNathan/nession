//! Fail-closed validation for the supported v1 OCI/EROFS forms.

use anyhow::{bail, Context, Result};

use super::annotation::{
    ImageKind, NessionUsage, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_INDEX,
    MEDIA_TYPE_MANIFEST,
};
use super::config::ImageConfig;
use super::descriptor::Platform;
use super::{Descriptor, Index, Manifest};

/// Validate one content descriptor's immutable identity shape.
pub fn validate_descriptor(descriptor: &Descriptor) -> Result<()> {
    if !crate::digest::is_valid_digest(&descriptor.digest) {
        bail!(
            "invalid OCI descriptor digest {:?}: expected sha256:<64 lowercase hex>",
            descriptor.digest
        );
    }
    if descriptor.media_type.trim().is_empty() {
        bail!("OCI descriptor mediaType must not be empty");
    }
    Ok(())
}

/// Validate a Manifest against the supported v1 raw-EROFS form.
///
/// V1 accepts exactly one raw `application/vnd.erofs` layer. Compressed,
/// multi-device, chunk-index, multi-layer and role/overlay variants fail with
/// an explicit message instead of being partially interpreted.
pub fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if manifest.schema_version != 2 {
        bail!(
            "unsupported OCI manifest schemaVersion {}: v1 requires 2",
            manifest.schema_version
        );
    }
    if let Some(media_type) = &manifest.media_type {
        if media_type != MEDIA_TYPE_MANIFEST {
            bail!("unsupported OCI manifest mediaType {media_type:?}");
        }
    }
    let layer = manifest
        .layers
        .first()
        .context("OCI manifest has no layers")?;
    if manifest.layers.len() != 1 {
        bail!(
            "v1 supports exactly one raw EROFS layer, got {}",
            manifest.layers.len()
        );
    }
    if layer.media_type != MEDIA_TYPE_EROFS {
        bail!(
            "unsupported EROFS layer mediaType {:?}: v1 supports only raw {MEDIA_TYPE_EROFS} \
             (compressed, multi-device, chunk-index, multi-layer and overlay variants are refused)",
            layer.media_type
        );
    }
    validate_descriptor(layer)?;
    if manifest.config.media_type != MEDIA_TYPE_CONFIG {
        bail!(
            "unsupported config mediaType {:?}: expected {MEDIA_TYPE_CONFIG}",
            manifest.config.media_type
        );
    }
    validate_descriptor(&manifest.config)?;
    if let Some(subject) = &manifest.subject {
        validate_descriptor(subject)?;
    }
    if let Some(artifact_type) = &manifest.artifact_type {
        if artifact_type.trim().is_empty() {
            bail!("OCI manifest artifactType must not be empty when present");
        }
    }
    // Advisory annotations are validated but never promote an object.
    NessionUsage::from_annotations(manifest.annotations.as_ref())?;
    Ok(())
}

/// Validate an Image Config against the Manifest's single EROFS layer.
pub fn validate_config(config: &ImageConfig, layer_digest: &str) -> Result<()> {
    if config.architecture.trim().is_empty() {
        bail!("OCI config architecture must not be empty");
    }
    if config.os.trim().is_empty() {
        bail!("OCI config os must not be empty");
    }
    if !config.supports_erofs() {
        bail!("OCI config os.features must include \"erofs\"");
    }
    if config.rootfs.fs_type != "layers" {
        bail!(
            "unsupported OCI config rootfs.type {:?}: v1 requires \"layers\"",
            config.rootfs.fs_type
        );
    }
    let diff_id = config
        .rootfs
        .diff_ids
        .first()
        .context("OCI config rootfs.diff_ids must contain the EROFS layer")?;
    if config.rootfs.diff_ids.len() != 1 {
        bail!(
            "v1 supports exactly one rootfs.diff_ids entry, got {}",
            config.rootfs.diff_ids.len()
        );
    }
    if !crate::digest::is_valid_digest(diff_id) {
        bail!("invalid OCI config rootfs.diff_ids entry {diff_id:?}");
    }
    if diff_id != layer_digest {
        bail!(
            "OCI config rootfs.diff_ids {diff_id} does not match the EROFS layer digest {layer_digest}"
        );
    }
    for variable in config.env() {
        let Some((name, _)) = variable.split_once('=') else {
            bail!("OCI config Env entry {variable:?} is not KEY=VALUE");
        };
        if name.is_empty() {
            bail!("OCI config Env entry {variable:?} has an empty name");
        }
    }
    if let Some(working_dir) = &config.config.working_dir {
        if !working_dir.starts_with('/') {
            bail!("OCI config WorkingDir must be absolute, got {working_dir:?}");
        }
    }
    Ok(())
}

/// Validate a Manifest and its Config as one v1 image.
pub fn validate_manifest_config(manifest: &Manifest, config: &ImageConfig) -> Result<()> {
    validate_manifest(manifest)?;
    let layer = manifest
        .layers
        .first()
        .context("OCI manifest has no layers")?;
    validate_config(config, &layer.digest)
}

/// Validate a standard multi-platform Index for v1.
pub fn validate_index(index: &Index) -> Result<()> {
    if index.schema_version != 2 {
        bail!(
            "unsupported OCI index schemaVersion {}: v1 requires 2",
            index.schema_version
        );
    }
    if let Some(media_type) = &index.media_type {
        if media_type != MEDIA_TYPE_INDEX {
            bail!("unsupported OCI index mediaType {media_type:?}");
        }
    }
    if index.manifests.is_empty() {
        bail!("OCI index has no manifests");
    }
    for descriptor in &index.manifests {
        if descriptor.media_type != MEDIA_TYPE_MANIFEST {
            bail!(
                "unsupported OCI index child mediaType {:?}: v1 selects only image manifests",
                descriptor.media_type
            );
        }
        validate_descriptor(descriptor)?;
        let platform = descriptor
            .platform
            .as_ref()
            .context("OCI index child descriptor has no platform")?;
        if platform.os.trim().is_empty() || platform.architecture.trim().is_empty() {
            bail!("OCI index child platform must name both os and architecture");
        }
        if !platform.supports_erofs() {
            bail!(
                "OCI index child platform for {}/{} does not include the erofs os feature",
                platform.os,
                platform.architecture
            );
        }
    }
    for (position, descriptor) in index.manifests.iter().enumerate() {
        let Some(platform) = descriptor.platform.as_ref() else {
            continue;
        };
        for other in index.manifests.iter().skip(position + 1) {
            let Some(other_platform) = other.platform.as_ref() else {
                continue;
            };
            if platform.os == other_platform.os
                && platform.architecture == other_platform.architecture
                && platform.variant == other_platform.variant
            {
                bail!(
                    "ambiguous OCI index: multiple manifests target {}/{} variant {:?}",
                    platform.os,
                    platform.architecture,
                    platform.variant
                );
            }
        }
    }
    Ok(())
}

/// Select the exact Manifest descriptor for the requesting platform.
///
/// Selection is deterministic: zero matches and multiple matches both fail
/// closed. A wrong-platform image is never returned as a fallback.
pub fn select_platform<'a>(index: &'a Index, target: &Platform) -> Result<&'a Descriptor> {
    validate_index(index)?;
    let mut matches = index.manifests.iter().filter(|descriptor| {
        descriptor
            .platform
            .as_ref()
            .is_some_and(|platform| platform.matches(target))
    });
    let first = matches.next().with_context(|| {
        format!(
            "OCI index has no manifest for {}/{} variant {:?} with the erofs os feature",
            target.os, target.architecture, target.variant
        )
    })?;
    if let Some(second) = matches.next() {
        bail!(
            "ambiguous OCI index selection for {}/{}: descriptors {} and {} both match",
            target.os,
            target.architecture,
            first.digest,
            second.digest
        );
    }
    Ok(first)
}

/// Whether a kind annotation is present (used by usage consumers in phase F).
pub fn advisory_kind(manifest: &Manifest) -> Result<Option<ImageKind>> {
    Ok(NessionUsage::from_annotations(manifest.annotations.as_ref())?.kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oci::{parse_config, parse_index, parse_manifest};

    const LAYER: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const CONFIG_DIGEST: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn manifest_json(layer_media_type: &str, layers: usize) -> String {
        let layer = format!(r#"{{"mediaType":"{layer_media_type}","digest":"{LAYER}","size":2}}"#);
        let layers = vec![layer; layers].join(",");
        format!(
            r#"{{"schemaVersion":2,"mediaType":"{MEDIA_TYPE_MANIFEST}","config":{{"mediaType":"{MEDIA_TYPE_CONFIG}","digest":"{CONFIG_DIGEST}","size":1}},"layers":[{layers}]}}"#
        )
    }

    fn config_json(os_features: &str, diff_id: &str) -> String {
        format!(
            r#"{{"architecture":"amd64","os":"linux","os.features":{os_features},"config":{{"Env":["PATH=/usr/bin"]}},"rootfs":{{"type":"layers","diff_ids":["{diff_id}"]}}}}"#
        )
    }

    fn valid_manifest() -> Manifest {
        let (_, manifest) = parse_manifest(manifest_json(MEDIA_TYPE_EROFS, 1).as_bytes()).unwrap();
        manifest
    }

    fn valid_config() -> ImageConfig {
        let (_, config) = parse_config(config_json(r#"["erofs"]"#, LAYER).as_bytes()).unwrap();
        config
    }

    #[test]
    fn a_valid_single_layer_image_passes() {
        let manifest = valid_manifest();
        let config = valid_config();
        validate_manifest_config(&manifest, &config).unwrap();
    }

    #[test]
    fn corrupted_digest_and_size_are_rejected() {
        let manifest = valid_manifest();
        let mut bad_digest = manifest.clone();
        bad_digest.layers.first_mut().unwrap().digest = "sha256:nothex".to_string();
        assert!(validate_manifest(&bad_digest).is_err());

        let (document, _) = parse_manifest(manifest_json(MEDIA_TYPE_EROFS, 1).as_bytes()).unwrap();
        let mut descriptor = manifest.layers.first().unwrap().clone();
        descriptor.size = 99;
        assert!(document.verify_against(&descriptor).is_err());
        descriptor.size = 2;
        descriptor.digest = CONFIG_DIGEST.to_string();
        assert!(document.verify_against(&descriptor).is_err());
    }

    #[test]
    fn a_compressed_layer_media_type_is_refused_explicitly() {
        let (_, manifest) =
            parse_manifest(manifest_json("application/vnd.erofs+zstd", 1).as_bytes()).unwrap();
        let error = validate_manifest(&manifest).unwrap_err().to_string();
        assert!(error.contains("unsupported EROFS layer mediaType"));
    }

    #[test]
    fn multiple_layers_are_refused() {
        let (_, manifest) = parse_manifest(manifest_json(MEDIA_TYPE_EROFS, 2).as_bytes()).unwrap();
        let error = validate_manifest(&manifest).unwrap_err().to_string();
        assert!(error.contains("exactly one raw EROFS layer"));
    }

    #[test]
    fn a_rootfs_diff_id_mismatch_is_refused() {
        let manifest = valid_manifest();
        let wrong = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let (_, config) = parse_config(config_json(r#"["erofs"]"#, wrong).as_bytes()).unwrap();
        let error = validate_manifest_config(&manifest, &config)
            .unwrap_err()
            .to_string();
        assert!(error.contains("does not match the EROFS layer digest"));
    }

    #[test]
    fn a_config_without_the_erofs_feature_is_refused() {
        let manifest = valid_manifest();
        let (_, config) = parse_config(config_json(r#"["wasm"]"#, LAYER).as_bytes()).unwrap();
        let error = validate_manifest_config(&manifest, &config)
            .unwrap_err()
            .to_string();
        assert!(error.contains("os.features must include"));
    }

    fn index_json(entries: &[(&str, &str)]) -> String {
        let manifests = entries
            .iter()
            .map(|(architecture, digest)| {
                format!(
                    r#"{{"mediaType":"{MEDIA_TYPE_MANIFEST}","digest":"{digest}","size":10,"platform":{{"architecture":"{architecture}","os":"linux","os.features":["erofs"]}}}}"#
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"schemaVersion":2,"mediaType":"{MEDIA_TYPE_INDEX}","manifests":[{manifests}]}}"#
        )
    }

    fn target(architecture: &str) -> Platform {
        Platform {
            architecture: architecture.to_string(),
            os: "linux".to_string(),
            os_features: Some(vec!["erofs".to_string()]),
            ..Platform::default()
        }
    }

    #[test]
    fn an_index_selects_the_exact_platform() {
        let amd64 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
        let arm64 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
        let (_, index) =
            parse_index(index_json(&[("amd64", amd64), ("arm64", arm64)]).as_bytes()).unwrap();
        assert_eq!(
            select_platform(&index, &target("amd64")).unwrap().digest,
            amd64
        );
        assert_eq!(
            select_platform(&index, &target("arm64")).unwrap().digest,
            arm64
        );
        assert!(select_platform(&index, &target("riscv64")).is_err());
    }

    #[test]
    fn an_ambiguous_index_fails_closed() {
        let amd64 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
        let duplicate = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
        let (_, index) =
            parse_index(index_json(&[("amd64", amd64), ("amd64", duplicate)]).as_bytes()).unwrap();
        let error = select_platform(&index, &target("amd64"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("ambiguous OCI index"));
    }

    #[test]
    fn an_index_child_without_erofs_is_refused() {
        let raw = format!(
            r#"{{"schemaVersion":2,"manifests":[{{"mediaType":"{MEDIA_TYPE_MANIFEST}","digest":"{CONFIG_DIGEST}","size":10,"platform":{{"architecture":"amd64","os":"linux","os.features":["wasm"]}}}}]}}"#
        );
        let (_, index) = parse_index(raw.as_bytes()).unwrap();
        let error = validate_index(&index).unwrap_err().to_string();
        assert!(error.contains("os feature"));
    }

    #[test]
    fn advisory_annotations_do_not_promote_an_unknown_kind() {
        let mut manifest = valid_manifest();
        manifest.annotations = Some(
            [("io.nession.kind".to_string(), "mystery".to_string())]
                .into_iter()
                .collect(),
        );
        let error = validate_manifest(&manifest).unwrap_err().to_string();
        assert!(error.contains("unsupported io.nession.kind"));
        assert_eq!(advisory_kind(&manifest).unwrap_err().to_string(), error);
    }
}
