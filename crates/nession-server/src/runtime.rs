//! The Server runtime: one composition, every entrypoint.
//!
//! The `nession-server` binary and `nession server start --foreground` both call
//! [`run`], so the Server one of them starts is the same Server (#1014). The
//! Agent runtime beside this one has the longer story; the shape and the reason
//! are the same.
//!
//! What belongs here is the runtime graph: logging, the component directories,
//! the database, the WebSocket server. A caller may resolve a config — flags and
//! environment overrides are theirs — but does not re-specify the graph.

use anyhow::Context;
use std::sync::Arc;
use tracing::{error, info};

use nession_common::config::ServerConfig;

use crate::db::Database;
use crate::server::WebSocketServer;

/// Start the Server runtime and run it until it stops.
///
/// Returns `Err` if the Server could not be brought up — logs that cannot be
/// initialised, a database that will not open, a listener that will not bind.
pub async fn run(config: ServerConfig) -> anyhow::Result<()> {
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
    let mut server = WebSocketServer::new(config, Arc::new(database)).await?;

    info!("Starting WebSocket server");
    if let Err(e) = server.run().await {
        error!("Server error: {}", e);
        return Err(e);
    }

    Ok(())
}
