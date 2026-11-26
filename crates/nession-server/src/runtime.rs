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
use nession_common::readiness::Readiness;

use crate::db::Database;
use crate::server::WebSocketServer;

/// Start the Server runtime and run it until it stops.
///
/// Returns `Err` if the Server could not be brought up — logs that cannot be
/// initialised, a database that will not open, a listener that will not bind.
///
/// `ready` is how a daemon parent is told the child got this far. This return
/// value cannot serve that purpose: `run` does not return until shutdown, so a
/// parent would learn "started" only when it stopped (#1016). The announcement
/// happens inside [`WebSocketServer::run`], after the last step that can fail.
pub async fn run(config: ServerConfig, ready: Readiness) -> anyhow::Result<()> {
    // The release-selected terminal configuration (#2487): environment wins
    // over the generated config file, and an invalid value fails before
    // logging, the database, or the listener. Both entrypoints reach this
    // function, so validation has one owner.
    let mut config = config;
    // Failures before the runtime log writer exists have no file destination;
    // the bounded startup capture is where they remain readable (#4600).
    if let Err(error) = config.apply_env_overrides() {
        return Err(startup_failure("validate", error));
    }
    if let Err(error) = config.validate() {
        return Err(startup_failure("validate", error));
    }

    let _log_guard = match nession_common::logging::init_logging(
        &config.logging,
        &nession_common::paths::server_logs_dir()?,
        nession_common::logging::LogComponent::Server.log_prefix(),
    ) {
        Ok(guard) => guard,
        Err(error) => {
            let note = nession_common::startup_log::record_or_note(
                nession_common::logging::LogComponent::Server,
                "logging",
                &format!("{error}"),
            );
            return Err(anyhow::Error::new(error).context(note));
        }
    };

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
    if let Err(e) = server.run(ready).await {
        error!("Server error: {}", e);
        return Err(e);
    }

    Ok(())
}

/// Attach a bounded startup-capture outcome to a pre-logging failure.
fn startup_failure(phase: &str, error: anyhow::Error) -> anyhow::Error {
    let note = nession_common::startup_log::record_or_note(
        nession_common::logging::LogComponent::Server,
        phase,
        &format!("{error:#}"),
    );
    error.context(note)
}
