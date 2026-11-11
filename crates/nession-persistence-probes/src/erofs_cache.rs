//! Bounded EROFS-cache persistence probe for the Agent (#3179).
//!
//! Verification-only binary: it opens the cache at an explicitly declared
//! durable root and performs exactly one `get_or_fetch`, reporting whether the
//! call was a warm hit, how many body bytes it transferred, and the SHA-256 of
//! the served bytes. A Compose Case runs it in the real Agent service
//! environment before/after container recreation.
//!
//! Usage: nession-erofs-cache-probe --cache-root DIR --digest sha256:<hex>
//!        --url http://host:port/blob --token TOKEN [--identity ID]

use anyhow::{Context, Result};
use nession_agent::config::ResolvedErofsStorage;
use nession_agent::erofs_cache::{open_resolved, DownloadGrant};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

#[tokio::main]
async fn main() -> Result<()> {
    let mut cache_root: Option<PathBuf> = None;
    let mut digest: Option<String> = None;
    let mut url: Option<String> = None;
    let mut token: Option<String> = None;
    let mut identity = "probe-agent".to_string();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let value = args
            .next()
            .with_context(|| format!("{arg} requires a value"))?;
        match arg.as_str() {
            "--cache-root" => cache_root = Some(PathBuf::from(value)),
            "--digest" => digest = Some(value),
            "--url" => url = Some(value),
            "--token" => token = Some(value),
            "--identity" => identity = value,
            other => anyhow::bail!("unknown argument: {other}"),
        }
    }

    let storage = ResolvedErofsStorage {
        path: cache_root.context("--cache-root is required")?,
        explicit: true,
    };
    let digest = digest.context("--digest is required")?;
    let grant = DownloadGrant {
        url: url.context("--url is required")?,
        token: token.context("--token is required")?,
    };

    let cache = open_resolved(&storage, &identity)
        .await
        .context("failed to open the EROFS cache at the declared durable root")?;
    let image = cache.get_or_fetch(&digest, &grant).await?;
    println!(
        "{}",
        serde_json::json!({
            "from_cache": image.from_cache,
            "bytes_transferred": cache.bytes_transferred(),
            "fetch_count": cache.fetch_count(),
            "digest": image.digest,
            "size_bytes": image.size_bytes,
            "blob_path": image.path,
            "blob_sha256": sha256_file(&image.path)?,
            "cache_root": storage.path,
            "identity": cache.identity(),
            "namespace_root": cache.root(),
        })
    );
    Ok(())
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
