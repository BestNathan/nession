//! GHCR publish/readback smoke for Nession's existing EROFS OCI implementation.
//! CI stages this file as an ephemeral example of nession-erofs; it is not
//! production CLI or a second image-format implementation.
use anyhow::{bail, ensure, Context, Result};
use nession_erofs::oci::annotation::{ANNOTATION_KIND, MEDIA_TYPE_EROFS};
use nession_erofs::oci::descriptor::Descriptor;
use nession_erofs::oci::parse_manifest;
use nession_erofs::registry::{
    export_layout, push_image, RegistryAuthority, RegistryClient, RegistryConfig,
    RegistryCredential, RegistryCredentialProvider, RemoteReference,
};
use nession_erofs::{
    host_platform, image_documents, validate_erofs_file, BlobStore, ErofsBuilder, Packaging,
    ProcessGitRunner, ProcessMkfsRunner,
};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

const PACKAGE_REPOSITORY: &str = "bestnathan/nession-erofs-smoke";
const TEST_CONTENT: &[u8] = b"#!/bin/sh\nprintf 'nession-erofs-ghcr-smoke\\n'\n";

/// Repository-scoped, redacted credential provider. Secrets are never placed
/// in the manifest, image layer, diagnostic or CLI argument list.
struct GhcrCredentials {
    username: String,
    token: String,
}

impl RegistryCredentialProvider for GhcrCredentials {
    fn credential_for(
        &self,
        authority: &RegistryAuthority,
        repository: &str,
    ) -> Option<RegistryCredential> {
        if authority.scheme == "https"
            && authority.host == "ghcr.io"
            && repository == PACKAGE_REPOSITORY
        {
            RegistryCredential::new(self.username.clone(), self.token.clone()).ok()
        } else {
            None
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = env::args().nth(1).context("expected local or publish mode")?;
    ensure!(mode == "local" || mode == "publish", "unexpected smoke mode");
    ensure!(
        env::var("GITHUB_REPOSITORY").unwrap_or_default() == "BestNathan/nession"
            || mode == "local",
        "GHCR publishing is allowed only from the owning repository"
    );

    let temp = tempfile::tempdir().context("create isolated image smoke root")?;
    let source = temp.path().join("source");
    let tool = source.join("bin/nession-smoke");
    fs::create_dir_all(tool.parent().context("tool parent")?)?;
    fs::write(&tool, TEST_CONTENT)?;
    fs::set_permissions(&tool, fs::Permissions::from_mode(0o755))?;

    let store = BlobStore::new(temp.path().join("cas"))?;
    let builder = ErofsBuilder::new(
        Arc::new(ProcessGitRunner::default()),
        Arc::new(ProcessMkfsRunner::default()),
        store.clone(),
        temp.path().join("build"),
    )?;
    let built = builder.build_local(&source, &Packaging::default())?;
    ensure!(
        validate_erofs_file(&built.blob.path)? == built.blob.size_bytes,
        "generated EROFS size disagrees with CAS"
    );

    let layer = Descriptor {
        media_type: MEDIA_TYPE_EROFS.to_owned(),
        digest: built.blob.digest.clone(),
        size: built.blob.size_bytes,
        urls: None,
        annotations: None,
        platform: None,
        artifact_type: None,
        data: None,
        extra: serde_json::Map::new(),
    };
    let annotations = BTreeMap::from([(ANNOTATION_KIND.to_owned(), "tool".to_owned())]);
    let (config, manifest) =
        image_documents(&layer, &host_platform(), &[], &annotations)?;
    let config_blob = store.put_bytes(config.bytes())?;
    let manifest_blob = store.put_bytes(manifest.bytes())?;
    ensure!(config_blob.digest == config.digest(), "Config CAS digest mismatch");
    ensure!(
        manifest_blob.digest == manifest.digest(),
        "Manifest CAS digest mismatch"
    );

    // The existing exporter must see exactly the Manifest -> Config/EROFS closure.
    let layout = export_layout(&store, manifest.digest(), &temp.path().join("layout"))?;
    ensure!(layout.objects == 3, "unexpected OCI object closure size");
    println!("EROFS bytes: {}", built.blob.size_bytes);
    println!("OCI Manifest: {}", manifest.digest());
    println!("OCI Config: {}", config.digest());
    println!("EROFS Layer: {}", layer.digest);

    if mode == "local" {
        println!("Local EROFS -> OCI CAS -> OCI Layout smoke: PASS");
        return Ok(());
    }

    let token = env::var("GHCR_TOKEN").context("GHCR_TOKEN is required on main")?;
    let actor = env::var("GHCR_ACTOR").context("GHCR_ACTOR is required on main")?;
    ensure!(!token.is_empty() && !actor.is_empty(), "GHCR credential is empty");
    let run_id = env::var("GITHUB_RUN_ID").context("GITHUB_RUN_ID missing")?;
    let attempt = env::var("GITHUB_RUN_ATTEMPT").context("GITHUB_RUN_ATTEMPT missing")?;
    ensure!(
        run_id.chars().all(|c| c.is_ascii_digit())
            && attempt.chars().all(|c| c.is_ascii_digit()),
        "invalid GitHub run identity"
    );
    let tag = format!("ci-{run_id}-{attempt}");
    let mut registry_config = RegistryConfig::new("https://ghcr.io")?;
    // GHCR may redirect blob downloads to its GitHub-owned blob CDN.
    registry_config.allowed_redirect_hosts =
        vec!["pkg-containers.githubusercontent.com".to_owned()];
    let client = RegistryClient::new(
        registry_config,
        Arc::new(GhcrCredentials {
            username: actor,
            token,
        }),
    )?;
    let reference = RemoteReference::Tag(tag.clone());
    let pushed =
        push_image(&client, &store, PACKAGE_REPOSITORY, &reference, manifest.digest()).await?;
    ensure!(
        pushed.digest == manifest.digest(),
        "push returned unexpected Manifest digest"
    );

    // A successful PUT is insufficient: independently GET by the immutable
    // digest, then download and reverify both referenced blobs.
    let remote = client
        .fetch_manifest(
            PACKAGE_REPOSITORY,
            &RemoteReference::Digest(manifest.digest().to_owned()),
        )
        .await?;
    ensure!(
        remote.digest == manifest.digest()
            && remote.document.bytes() == manifest.bytes(),
        "remote Manifest identity/content mismatch"
    );
    let (_, remote_manifest) = parse_manifest(remote.document.bytes())?;
    ensure!(remote_manifest.layers.len() == 1, "remote layer count changed");
    ensure!(remote_manifest.layers[0] == layer, "remote EROFS descriptor changed");
    let remote_config = client
        .fetch_config(PACKAGE_REPOSITORY, &remote_manifest.config)
        .await?;
    ensure!(
        remote_config.bytes() == config.bytes(),
        "remote Config bytes changed"
    );

    let downloaded = BlobStore::new(temp.path().join("downloaded"))?;
    client
        .download_blob(&downloaded, PACKAGE_REPOSITORY, &layer)
        .await?;
    downloaded.verify_named_size(&layer.digest, layer.size)?;
    ensure!(
        fs::read(downloaded.path_for(&layer.digest)?)? == fs::read(&built.blob.path)?,
        "downloaded EROFS differs from locally built bytes"
    );

    // Check that the real filesystem contains the original executable, rather
    // than merely proving opaque bytes made a network round trip.
    assert_extracted_tool(
        &downloaded.path_for(&layer.digest)?,
        &temp.path().join("extracted"),
    )?;

    let identity = format!("ghcr.io/{PACKAGE_REPOSITORY}:{tag}");
    println!("GHCR readback PASS: {identity}@{}", manifest.digest());
    println!(
        "push objects: uploaded={} reused={} manifests={}",
        pushed.blobs_uploaded, pushed.blobs_reused, pushed.manifests_uploaded
    );
    if let Ok(path) = env::var("GITHUB_STEP_SUMMARY") {
        let mut summary = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(
            summary,
            "### Nession EROFS / OCI GHCR smoke\n\n- Image: `{identity}`\n- Manifest: `{}`\n- Layer: `{}`\n- Config: `{}`\n- Uploaded blobs: {}\n- Reused blobs: {}\n- Uploaded manifests: {}\n- Verified: remote Manifest, Config, EROFS bytes and extracted tool\n",
            manifest.digest(),
            layer.digest,
            config.digest(),
            pushed.blobs_uploaded,
            pushed.blobs_reused,
            pushed.manifests_uploaded
        )?;
    }
    Ok(())
}

fn assert_extracted_tool(image: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target)?;
    let output = Command::new("fsck.erofs")
        .arg(format!("--extract={}", target.display()))
        .arg(image)
        .output()
        .context("execute fsck.erofs extraction of downloaded layer")?;
    if !output.status.success() {
        bail!(
            "fsck.erofs rejected the downloaded layer: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    ensure!(
        fs::read(target.join("bin/nession-smoke"))? == TEST_CONTENT,
        "downloaded EROFS extracted unexpected tool bytes"
    );
    Ok(())
}
