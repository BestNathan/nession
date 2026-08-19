use anyhow::Context;
use std::path::Path;
use tracing::{error, info};

use nession_common::config::ServerConfig;
use nession_server::db::Database;
use nession_server::server::WebSocketServer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load configuration first (needed for logging setup).
    let config = load_config()?;

    // Initialize logging (stdout + file).
    let _log_guard = nession_common::logging::init_logging(
        &config.logging,
        &nession_common::paths::server_logs_dir()?,
        "nession-server",
    )?;

    info!("Starting nession-server");
    info!(
        "Configuration loaded: listen_address={}, db_path={}",
        config.listen_address, config.db_path
    );

    // Ensure component directories exist
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Initialize database
    info!("Initializing database at {}", config.db_path);
    let database = Database::new(&config.db_path).await?;
    info!("Database initialized successfully");

    // Create and run WebSocket server
    info!("Creating WebSocket server");
    let mut server = WebSocketServer::new(config, std::sync::Arc::new(database)).await?;

    info!("Starting WebSocket server");
    if let Err(e) = server.run().await {
        error!("Server error: {}", e);
        return Err(e);
    }

    Ok(())
}

/// Load server configuration.
///
/// The config path is taken from the first argv argument (if present),
/// falling back to `config.toml` in the current directory.
fn load_config() -> anyhow::Result<ServerConfig> {
    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config.toml".to_string());

    if Path::new(&config_path).exists() {
        info!("Loading configuration from {}", config_path);
        let config_str = std::fs::read_to_string(&config_path)?;
        let config: ServerConfig = toml::from_str(&config_str)?;
        Ok(config)
    } else {
        info!(
            "No config found at '{}', using default configuration",
            config_path
        );
        Ok(ServerConfig {
            listen_address: "127.0.0.1:8080".to_string(),
            ..Default::default()
        })
    }
}
