use anyhow::Context;
use std::path::Path;
use tracing::{error, info};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use nession_common::config::ServerConfig;
use nession_server::db::Database;
use nession_server::server::WebSocketServer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing/logging
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nession_server=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("Starting nession-server");

    // Load configuration
    let config = load_config()?;
    info!(
        "Configuration loaded: listen_address={}, db_path={}",
        config.listen_address, config.db_path
    );

    // Ensure component directories exist
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Initialize database
    info!("Initializing database at {}", config.db_path);
    let _database = Database::new(&config.db_path).await?;
    info!("Database initialized successfully");

    // Create and run WebSocket server
    info!("Creating WebSocket server");
    let mut server = WebSocketServer::new(config).await?;

    info!("Starting WebSocket server");
    if let Err(e) = server.run().await {
        error!("Server error: {}", e);
        return Err(e);
    }

    Ok(())
}

fn load_config() -> anyhow::Result<ServerConfig> {
    let config_path = "config.toml";

    if Path::new(config_path).exists() {
        info!("Loading configuration from {}", config_path);
        let config_str = std::fs::read_to_string(config_path)?;
        let config: ServerConfig = toml::from_str(&config_str)?;
        Ok(config)
    } else {
        info!("No config.toml found, using default configuration");
        Ok(ServerConfig {
            listen_address: "127.0.0.1:8080".to_string(),
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: String::new(),
            heartbeat_interval_secs: 10,
            heartbeat_timeout_secs: 30,
            db_path: nession_common::paths::server_db_path()
                .unwrap_or_else(|_| std::path::PathBuf::from("nession.db"))
                .to_string_lossy()
                .into_owned(),
        })
    }
}
