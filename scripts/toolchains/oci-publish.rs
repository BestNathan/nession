//! #4092: a thin release adapter over the existing Nession EROFS / OCI library.
//! Recipe scripts own files in ROOTFS. This owns no recipe model or OCI transport.
use anyhow::{bail, ensure, Context, Result};
use nession_erofs::oci::annotation::{
    ANNOTATION_KIND, ANNOTATION_PATH_PREPEND, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS,
};
use nession_erofs::oci::descriptor::Descriptor;
use nession_erofs::oci::parse_manifest;
use nession_erofs::registry::{
    push_image, RegistryAuthority, RegistryClient, RegistryConfig, RegistryCredential,
    RegistryCredentialProvider, RegistryError, RemoteReference,
};
use nession_erofs::{
    host_platform, image_documents, validate_erofs_file, BlobStore, ErofsBuilder, Packaging,
    ProcessGitRunner, ProcessMkfsRunner,
};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::Arc;

struct GhcrCredentials {
    username: String,
    token: String,
    repository: String,
}
impl RegistryCredentialProvider for GhcrCredentials {
    fn credential_for(
        &self,
        authority: &RegistryAuthority,
        repository: &str,
    ) -> Option<RegistryCredential> {
        (authority.scheme == "https"
            && authority.host == "ghcr.io"
            && repository == self.repository)
            .then(|| RegistryCredential::new(self.username.clone(), self.token.clone()).ok())
            .flatten()
    }
}

struct Release {
    tool: String,
    version: String,
    platform: String,
    revision: String,
    repository: String,
    tag: String,
}
impl Release {
    fn from_env() -> Result<Self> {
        let tool = env::var("TOOLCHAIN_TOOL").context("TOOLCHAIN_TOOL missing")?;
        let version = env::var("TOOLCHAIN_VERSION").context("TOOLCHAIN_VERSION missing")?;
        let platform = env::var("TOOLCHAIN_PLATFORM").context("TOOLCHAIN_PLATFORM missing")?;
        let revision = env::var("TOOLCHAIN_REVISION").context("TOOLCHAIN_REVISION missing")?;
        ensure!(
            matches!(tool.as_str(), "jq" | "kubectl" | "k8s-bundle" | "gh"),
            "unknown tool"
        );
        ensure!(
            !version.is_empty()
                && version.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-'),
            "unsafe version"
        );
        ensure!(platform == "linux/amd64", "only linux/amd64 is supported in v1");
        ensure!(
            std::env::consts::OS == "linux" && std::env::consts::ARCH == "x86_64",
            "native linux/amd64 builder or verifier is required"
        );
        ensure!(
            revision.len() <= 8
                && !revision.is_empty()
                && revision.bytes().all(|c| c.is_ascii_digit())
                && !revision.starts_with('0'),
            "revision must be positive digits without leading zeroes"
        );
        let repository = format!("bestnathan/nession-toolchain-{tool}");
        let tag = format!("{version}-r{revision}");
        Ok(Self { tool, version, platform, revision, repository, tag })
    }

    fn reference(&self) -> Result<RemoteReference> {
        Ok(RemoteReference::parse(&self.tag)?)
    }

    fn image_ref(&self) -> String {
        format!("ghcr.io/{}:{}", self.repository, self.tag)
    }
}

fn client_for(release: &Release) -> Result<RegistryClient> {
    ensure!(
        env::var("GITHUB_REPOSITORY").as_deref() == Ok("BestNathan/nession"),
        "GHCR access only from the owning GitHub repository"
    );
    let token = env::var("GHCR_TOKEN").context("GHCR_TOKEN missing")?;
    let actor = env::var("GHCR_ACTOR").context("GHCR_ACTOR missing")?;
    ensure!(!token.is_empty() && !actor.is_empty(), "empty Registry credential");
    let mut config = RegistryConfig::new("https://ghcr.io")?;
    config.allowed_redirect_hosts = vec!["pkg-containers.githubusercontent.com".to_string()];
    Ok(RegistryClient::new(
        config,
        Arc::new(GhcrCredentials {
            username: actor,
            token,
            repository: release.repository.clone(),
        }),
    )?)
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = env::args().nth(1).context("expected local, publish or readback")?;
    ensure!(
        matches!(mode.as_str(), "local" | "publish" | "readback"),
        "unexpected mode"
    );
    let release = Release::from_env()?;
    let temp = tempfile::tempdir().context("create private OCI build root")?;

    if mode == "readback" {
        let expected = env::var("TOOLCHAIN_EXPECTED_DIGEST")
            .context("readback must pin exact publish Manifest digest")?;
        let client = client_for(&release)?;
        let (remote_digest, config, layer) = fetch_remote(&client, &release, &expected).await?;
        let downloaded = BlobStore::new(temp.path().join("readback-cas"))?;
        client
            .download_blob(&downloaded, &release.repository, &layer)
            .await?;
        downloaded.verify_named_size(&layer.digest, layer.size)?;
        let extracted = temp.path().join("readback-extracted");
        extract(&downloaded.path_for(&layer.digest)?, &extracted)?;
        verify_tool(&extracted, &release)?;
        println!("GHCR independent executable readback PASS: {}@{remote_digest}", release.image_ref());
        println!("Config digest: {}", config.digest);
        println!("EROFS layer digest: {}", layer.digest);
        return Ok(());
    }

    let source = env::var("TOOLCHAIN_ROOTFS").context("TOOLCHAIN_ROOTFS missing")?;
    let source = Path::new(&source);
    ensure!(source.is_dir(), "prepared tool directory missing");
    verify_tool(source, &release)?;
    let store = BlobStore::new(temp.path().join("cas"))?;
    let builder = ErofsBuilder::new(
        Arc::new(ProcessGitRunner::default()),
        Arc::new(ProcessMkfsRunner::default()),
        store.clone(),
        temp.path().join("build"),
    )?;
    let built = builder.build_local(source, &Packaging::default())?;
    ensure!(
        validate_erofs_file(&built.blob.path)? == built.blob.size_bytes,
        "EROFS CAS data is invalid"
    );
    let layer = Descriptor {
        media_type: MEDIA_TYPE_EROFS.to_string(),
        digest: built.blob.digest.clone(),
        size: built.blob.size_bytes,
        urls: None,
        annotations: None,
        platform: None,
        artifact_type: None,
        data: None,
        extra: serde_json::Map::new(),
    };
    let annotations = BTreeMap::from([
        (ANNOTATION_KIND.to_string(), "tool".to_string()),
        (ANNOTATION_PATH_PREPEND.to_string(), "bin".to_string()),
    ]);
    let (config, manifest) = image_documents(&layer, &host_platform(), &[], &annotations)?;
    let config_blob = store.put_bytes(config.bytes())?;
    let manifest_blob = store.put_bytes(manifest.bytes())?;
    ensure!(config_blob.digest == config.digest(), "Config CAS hash changed");
    ensure!(manifest_blob.digest == manifest.digest(), "Manifest CAS hash changed");

    let unpacked = temp.path().join("local-extracted");
    extract(&built.blob.path, &unpacked)?;
    compare_trees(source, &unpacked)?;
    verify_tool(&unpacked, &release)?;
    println!(
        "Native EROFS -> OCI build PASS: {} platform={} bytes={} manifest={}",
        release.image_ref(), release.platform, layer.size, manifest.digest()
    );
    if mode == "local" {
        return Ok(());
    }

    let client = client_for(&release)?;
    let reference = release.reference()?;
    match client.fetch_manifest(&release.repository, &reference).await {
        Ok(existing) => ensure!(
            existing.digest == manifest.digest(),
            "immutable version/revision tag already points at a DIFFERENT Manifest; bump packaging revision"
        ),
        Err(RegistryError::NotFound(_)) => {
            let outcome = push_image(
                &client, &store, &release.repository, &reference, manifest.digest()
            ).await?;
            ensure!(outcome.digest == manifest.digest(), "push digest mismatch");
            println!(
                "GHCR Push uploaded={} reused={} manifests={}",
                outcome.blobs_uploaded, outcome.blobs_reused, outcome.manifests_uploaded
            );
        }
        Err(error) => return Err(error.into()),
    }
    let (remote_digest, remote_config, remote_layer) =
        fetch_remote(&client, &release, manifest.digest()).await?;
    ensure!(remote_config.digest == config.digest(), "remote Config reference differs");
    ensure!(remote_layer == layer, "remote Layer descriptor differs");
    let remote = client
        .fetch_manifest(
            &release.repository,
            &RemoteReference::Digest(manifest.digest().to_string()),
        )
        .await?;
    ensure!(remote.document.bytes() == manifest.bytes(), "remote Manifest bytes differ");
    let remote_config_bytes = client.fetch_config(&release.repository, &remote_config).await?;
    ensure!(
        remote_config_bytes.bytes() == config.bytes(),
        "remote Config bytes differ"
    );
    let downloaded = BlobStore::new(temp.path().join("downloaded"))?;
    client
        .download_blob(&downloaded, &release.repository, &remote_layer)
        .await?;
    downloaded.verify_named_size(&remote_layer.digest, remote_layer.size)?;
    let extracted = temp.path().join("remote-extracted");
    extract(&downloaded.path_for(&remote_layer.digest)?, &extracted)?;
    compare_trees(source, &extracted)?;

    println!("GHCR publish + immutable digest readback PASS: {}@{remote_digest}", release.image_ref());
    println!("Config digest: {}", remote_config.digest);
    println!("EROFS Layer digest: {}", remote_layer.digest);
    write_output("digest", &remote_digest)?;
    if let Ok(path) = env::var("GITHUB_STEP_SUMMARY") {
        let mut summary = fs::OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(
            summary,
            "### Toolchain OCI / EROFS GHCR release\n\n- Image: `{}`\n- Manifest: `{}`\n- Config: `{}`\n- EROFS: `{}` ({} bytes)\n- Upstream version: {}\n- Packaging revision: r{}\n- Platform: {}\n- Run: {}\n- Recipe source SHA: `{}`\n",
            release.image_ref(),
            remote_digest,
            remote_config.digest,
            remote_layer.digest,
            remote_layer.size,
            release.version,
            release.revision,
            release.platform,
            env::var("GITHUB_RUN_ID").unwrap_or_default(),
            env::var("GITHUB_SHA").unwrap_or_default(),
        )?;
    }
    Ok(())
}

fn write_output(name: &str, value: &str) -> Result<()> {
    if let Ok(path) = env::var("GITHUB_OUTPUT") {
        let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(file, "{name}={value}")?;
    }
    Ok(())
}

async fn fetch_remote(
    client: &RegistryClient,
    release: &Release,
    expected_digest: &str,
) -> Result<(String, Descriptor, Descriptor)> {
    let remote = client.fetch_manifest(&release.repository, &release.reference()?).await?;
    ensure!(
        remote.digest == expected_digest,
        "remote mutable tag does not resolve to expected immutable digest"
    );
    let (_, manifest) = parse_manifest(remote.document.bytes())?;
    ensure!(manifest.layers.len() == 1, "unexpected remote layer count");
    ensure!(
        manifest.layers[0].media_type == MEDIA_TYPE_EROFS,
        "remote layer media type changed"
    );
    ensure!(
        manifest.config.media_type == MEDIA_TYPE_CONFIG,
        "remote Config media type changed"
    );
    ensure!(
        manifest
            .annotations
            .as_ref()
            .and_then(|a| a.get(ANNOTATION_KIND))
            .is_some_and(|v| v == "tool"),
        "not a verified tool image"
    );
    let config = client.fetch_config(&release.repository, &manifest.config).await?;
    ensure!(config.digest() == manifest.config.digest, "remote Config digest mismatch");
    Ok((remote.digest, manifest.config, manifest.layers[0].clone()))
}

fn extract(image: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    let output = Command::new("fsck.erofs")
        .arg(format!("--extract={}", destination.display()))
        .arg(image)
        .output()
        .context("execute fsck.erofs")?;
    ensure!(
        output.status.success(),
        "EROFS extract failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

fn compare_trees(source: &Path, extracted: &Path) -> Result<()> {
    let left = fs::read_dir(source)
        .with_context(|| format!("source directory {}", source.display()))?
        .map(|entry| entry.map(|e| e.file_name()))
        .collect::<std::io::Result<BTreeSet<_>>>()?;
    let right = fs::read_dir(extracted)
        .with_context(|| format!("extracted directory {}", extracted.display()))?
        .map(|entry| entry.map(|e| e.file_name()))
        .collect::<std::io::Result<BTreeSet<_>>>()?;
    ensure!(left == right, "EROFS extracted filenames differ");
    for entry in left {
        let a = source.join(&entry);
        let b = extracted.join(&entry);
        let a_meta = fs::symlink_metadata(&a)?;
        let b_meta = fs::symlink_metadata(&b)?;
        ensure!(
            a_meta.file_type().is_dir() == b_meta.file_type().is_dir(),
            "EROFS object type differs at {}", a.display()
        );
        if a_meta.is_dir() {
            compare_trees(&a, &b)?;
        } else {
            ensure!(
                a_meta.is_file() && b_meta.is_file(),
                "unsupported special file / symlink"
            );
            ensure!(
                a_meta.permissions().mode() & 0o777 == b_meta.permissions().mode() & 0o777,
                "EROFS permissions differ at {}", a.display()
            );
            ensure!(fs::read(&a)? == fs::read(&b)?, "EROFS bytes differ at {}", a.display());
        }
    }
    Ok(())
}

fn execute(binary: &Path, args: &[&str]) -> Result<Output> {
    let output = Command::new(binary)
        .args(args)
        .env_remove("GHCR_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .env_remove("GITHUB_OUTPUT")
        .output()
        .with_context(|| format!("execute {}", binary.display()))?;
    ensure!(
        output.status.success(),
        "tool failed version probe: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output)
}

fn verify_tool(root: &Path, release: &Release) -> Result<()> {
    match release.tool.as_str() {
        "jq" => verify_jq(root, &release.version),
        "kubectl" => verify_kubectl(root, &release.version),
        "gh" => verify_gh(root, &release.version),
        "k8s-bundle" => {
            ensure!(release.version == "2026.11", "unexpected bundle release");
            verify_jq(root, "1.8.1")?;
            verify_kubectl(root, "1.35.0")
        }
        _ => bail!("unknown tool"),
    }
}

fn verify_jq(root: &Path, version: &str) -> Result<()> {
    let bytes = execute(&root.join("bin/jq"), &["--version"])?;
    ensure!(
        String::from_utf8(bytes.stdout)?.trim() == format!("jq-{version}"),
        "jq version differs from pinned recipe"
    );
    Ok(())
}

fn verify_kubectl(root: &Path, version: &str) -> Result<()> {
    let bytes = execute(&root.join("bin/kubectl"), &["version", "--client", "--output=json"])?;
    let value: serde_json::Value = serde_json::from_slice(&bytes.stdout)?;
    let expected = format!("v{version}");
    ensure!(
        value["clientVersion"]["gitVersion"].as_str() == Some(expected.as_str()),
        "kubectl version differs from pinned recipe"
    );
    Ok(())
}

fn verify_gh(root: &Path, version: &str) -> Result<()> {
    let output = execute(&root.join("bin/gh"), &["--version"])?;
    let stdout = String::from_utf8(output.stdout)?;
    let first_line = stdout.lines().next().context("missing gh version output")?;
    ensure!(
        first_line.starts_with(&format!("gh version {version} (")),
        "gh version differs from pinned recipe"
    );
    Ok(())
}
