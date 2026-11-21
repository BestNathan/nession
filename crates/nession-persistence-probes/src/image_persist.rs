//! Bounded persistence probe for the Server image manager (#3179).
//!
//! This is a verification binary, not a product entrypoint: it opens the same
//! canonical `ServerConfig` paths and the same `ImageManager` the
//! `server.image.*` handlers use, then either builds one controlled local
//! source or reads one existing digest. A Compose Case runs it in the real
//! service environment (environment + named volume) before and after container
//! recreation, so path persistence is measured rather than inferred.
//!
//! Usage: nession-image-persist-probe <config.toml|-> build <directory>
//!        nession-image-persist-probe <config.toml|-> get <digest>

use anyhow::{Context, Result};
use nession_common::config::ServerConfig;
use nession_protocol::contracts::image::v1::{ImageDescriptor, ImageSource};
use nession_server::db::Database;
use nession_server::image::{ImageManager, ImageManagerOptions};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let config_path = args
        .get(1)
        .context("usage: probe <config.toml|-> build|get <value>")?;
    let action = args
        .get(2)
        .context("usage: probe <config.toml|-> build|get <value>")?;
    let value = args.get(3).context("probe action value is required")?;

    let mut config = if config_path == "-" {
        synthetic_config()
    } else {
        toml::from_str(&std::fs::read_to_string(config_path)?)
            .with_context(|| format!("failed to parse {config_path}"))?
    };
    config.apply_env_overrides()?;
    config.validate()?;
    // The Server runtime creates the configured component directories before
    // opening the database; mirror its startup order so the Compose probe
    // exercises the same canonical layout (#3179).
    nession_common::paths::ensure_component_dirs()
        .context("failed to create the configured Nession component directories")?;

    let db = Arc::new(Database::new(&config.db_path).await?);
    let blobs = nession_erofs::FsBlobStore::new(&config.image_blob_dir)
        .context("failed to open the image blob store")?;
    let builder = nession_erofs::ErofsBuilder::new(
        Arc::new(nession_erofs::ProcessGitRunner::default()),
        Arc::new(nession_erofs::ProcessMkfsRunner::default()),
        blobs.clone(),
        &config.image_build_dir,
    )
    .context("failed to open the image build workspace")?;
    let manager = Arc::new(ImageManager::new(
        db,
        Arc::new(builder),
        blobs,
        ImageManagerOptions {
            max_concurrent_builds: config.image_max_concurrent_builds,
            build_root: std::path::PathBuf::from(&config.image_build_dir),
            source_root: (!config.image_source_root.trim().is_empty())
                .then(|| std::path::PathBuf::from(config.image_source_root.trim())),
            build_stage_timeout: (config.image_build_stage_timeout_secs > 0)
                .then(|| std::time::Duration::from_secs(config.image_build_stage_timeout_secs)),
            build_log_max_bytes: config.image_build_log_max_bytes,
            build_retention_secs: config.image_build_retention_secs,
        },
    )?);

    let image = match action.as_str() {
        "build" => {
            manager
                .build(
                    &ImageSource::LocalDirectory {
                        path: value.to_string(),
                    },
                    None,
                )
                .await?
        }
        "get" => manager.get(Some(value), None).await?,
        other => anyhow::bail!("unknown probe action: {other}"),
    };
    emit(&config, &image)
}

fn emit(config: &ServerConfig, image: &ImageDescriptor) -> Result<()> {
    let digest = image
        .digest
        .as_deref()
        .context("image has no ready digest")?;
    let hex = digest
        .strip_prefix("sha256:")
        .context("image digest is not sha256:<hex>")?;
    let blob_path = Path::new(&config.image_blob_dir).join("sha256").join(hex);
    println!(
        "{}",
        serde_json::json!({
            "status": format!("{:?}", image.status),
            "image_id": image.image_id,
            "created_at": image.created_at,
            "updated_at": image.updated_at,
            "digest": digest,
            "size_bytes": image.size_bytes,
            "source_sha": image.source_sha,
            "blob_path": blob_path,
            "blob_sha256": sha256_file(&blob_path)?,
            "db_path": config.db_path,
            "image_blob_dir": config.image_blob_dir,
            "image_build_dir": config.image_build_dir,
        })
    );
    Ok(())
}

/// The config a probe started without a file uses.
///
/// The probe never listens; it is a verification binary that opens the
/// canonical Server paths and the image manager. The synthetic config still
/// goes through `ServerConfig::validate`, so it names a loopback listener
/// rather than the runtime's wildcard default, which the #4066 exposure rule
/// correctly refuses with no token.
fn synthetic_config() -> ServerConfig {
    ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        ..Default::default()
    }
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let Some(chunk) = buffer.get(..read) else {
            break;
        };
        hasher.update(chunk);
    }
    let mut hex = String::with_capacity(64);
    for byte in hasher.finalize() {
        hex.push_str(&format!("{byte:02x}"));
    }
    Ok(hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The probe never listens, but it runs the Server's canonical
    /// `ServerConfig::validate`; its synthetic config must therefore satisfy
    /// the #4066 exposure rule.
    #[test]
    fn the_synthetic_probe_config_is_startable() {
        let config = synthetic_config();
        config
            .validate()
            .expect("the no-config probe mode must pass Server validation");
    }
}
