//! Client-facing CLI commands implementation.

use anyhow::{Context, Result};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::client::connection::ClientConnection;

/// List agents from the server and display them in a formatted table.
pub async fn list_agents(server_url: &str, auth_token: &str) -> Result<()> {
    // Connect to the server
    let mut conn = ClientConnection::connect(server_url, auth_token)
        .await
        .with_context(|| "Failed to connect to server. Is the server running?")?;

    // Fetch agents
    let agents = conn.list_agents().await?;

    // Close connection
    conn.close().await.ok();

    // Display results
    if agents.is_empty() {
        println!("No agents registered.");
        return Ok(());
    }

    println!();
    println!("Agents:");
    println!(
        "{:<16}{:<18}{:<10}{:<12}{:<15}",
        "ID", "HOSTNAME", "STATUS", "SESSIONS", "LAST HEARTBEAT"
    );

    for agent in &agents {
        let heartbeat_ago = format_time_ago(&agent.last_heartbeat);
        println!(
            "{:<16}{:<18}{:<10}{:<12}{:<15}",
            agent.agent_id, agent.hostname, agent.status, agent.session_count, heartbeat_ago,
        );
    }
    println!();
    println!("{} agent(s) total", agents.len());

    Ok(())
}

/// List sessions from the server and display them in a formatted table.
pub async fn list_sessions(
    server_url: &str,
    auth_token: &str,
    agent_id: Option<&str>,
) -> Result<()> {
    // Connect to the server
    let mut conn = ClientConnection::connect(server_url, auth_token)
        .await
        .with_context(|| "Failed to connect to server. Is the server running?")?;

    // Fetch sessions
    let sessions = conn.list_sessions(agent_id).await?;

    // Close connection
    conn.close().await.ok();

    // Display results
    if sessions.is_empty() {
        if let Some(aid) = agent_id {
            println!("No sessions found for agent '{aid}'.");
        } else {
            println!("No sessions found.");
        }
        return Ok(());
    }

    println!();
    println!("Sessions:");
    println!(
        "{:<34}{:<16}{:<14}{:<12}{:<10}ATTACHED",
        "SESSION ID", "AGENT", "NAME", "STATUS", "WINDOWS"
    );

    for session in &sessions {
        println!(
            "{:<34}{:<16}{:<14}{:<12}{:<10}{}",
            session.session_id,
            session.agent_id,
            session.session_name,
            session.status,
            session.window_count,
            session.attached_clients,
        );
    }
    println!();
    println!("{} session(s) total", sessions.len());

    Ok(())
}

/// Attach to a remote tmux session.
///
/// Connects to the server, requests to attach to the specified session,
/// and then establishes either a P2P or relay connection to the agent.
/// Terminal I/O is forwarded bidirectionally until the session ends or
/// the user detaches.
///
/// # Arguments
///
/// * `server_url` - URL of the nession server
/// * `auth_token` - Authentication token
/// * `session_id` - Session ID in format "agent_id:session_name"
/// * `force_mode` - Optional mode override ("p2p" or "relay")
pub async fn attach_session(
    server_url: &str,
    auth_token: &str,
    session_id: &str,
    force_mode: Option<&str>,
) -> Result<()> {
    // Connect to server
    let mut conn = ClientConnection::connect(server_url, auth_token)
        .await
        .with_context(|| "Failed to connect to server. Is the server running?")?;

    // Determine preferred mode
    let preferred_mode = match force_mode {
        Some("relay") => "relay",
        Some("p2p") | None => "p2p",
        Some(other) => {
            anyhow::bail!("Invalid mode '{other}'. Use 'p2p' or 'relay'.");
        }
    };

    println!("Requesting to attach to session '{session_id}' (mode: {preferred_mode})...");

    // Request attach
    let attach_resp = conn
        .request_attach(session_id, preferred_mode)
        .await
        .with_context(|| "Failed to attach to session")?;

    match attach_resp {
        crate::client::connection::AttachResponse::P2P(p2p_info) => {
            println!(
                "Connecting to agent at {} (P2P mode)...",
                p2p_info.agent_address
            );

            // Connect directly to agent
            let agent_ws = crate::client::connection::connect_to_agent(&p2p_info.agent_address)
                .await
                .with_context(|| {
                    format!("Failed to connect to agent at {}", p2p_info.agent_address)
                })?;

            // Create WebSocket transport
            let transport = crate::terminal::raw::WebSocketTransport::new(agent_ws);

            // Send client.attach to agent with session name
            use nession_agent::server::websocket::{
                msg_types as agent_msg_types, ClientAttachPayload, Message as AgentMessage,
            };
            let (cols, rows) = crate::terminal::raw::RawTerminal::size()?;
            let attach_msg = AgentMessage {
                msg_type: agent_msg_types::CLIENT_ATTACH.to_string(),
                id: uuid::Uuid::new_v4().to_string(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                payload: ClientAttachPayload {
                    session_name: p2p_info.session_name.clone(),
                    width: cols,
                    height: rows,
                },
            };
            let attach_json = serde_json::to_string(&attach_msg)?;
            use crate::terminal::TerminalTransport;
            let mut transport = transport;
            transport.send_text(attach_json).await?;

            println!(
                "Attached to session '{}'. Press Ctrl+B then D to detach.",
                p2p_info.session_name
            );

            // Create cancellation channel
            let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

            // Spawn Ctrl+C handler
            let cancel_tx_clone = cancel_tx.clone();
            tokio::spawn(async move {
                tokio::signal::ctrl_c().await.ok();
                let _ = cancel_tx_clone.send(true);
            });

            // Create and run terminal session
            let session =
                crate::terminal::TerminalSession::new(p2p_info.session_name, transport, cancel_rx);

            // Detach key: Ctrl+B followed by 'd'
            let detach_key = crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Char('b'),
                crossterm::event::KeyModifiers::CONTROL,
            );

            session.run(Some(detach_key)).await?;

            println!("\nDetached from session.");
        }
        crate::client::connection::AttachResponse::Relay => {
            println!("Using relay mode (server proxies I/O)...");

            // Use server connection as relay transport
            let relay_ws = conn.into_relay_transport();
            let transport = crate::terminal::raw::WebSocketTransport::new(relay_ws);

            // For relay mode, the server expects us to send terminal protocol messages
            // The server will forward them to the agent
            use nession_agent::server::websocket::{
                msg_types as agent_msg_types, ClientAttachPayload, Message as AgentMessage,
            };
            let (cols, rows) = crate::terminal::raw::RawTerminal::size()?;

            // Parse session_name from session_id (format: agent_id:session_name)
            let session_name = session_id.split(':').nth(1).unwrap_or(session_id);

            let attach_msg = AgentMessage {
                msg_type: agent_msg_types::CLIENT_ATTACH.to_string(),
                id: uuid::Uuid::new_v4().to_string(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                payload: ClientAttachPayload {
                    session_name: session_name.to_string(),
                    width: cols,
                    height: rows,
                },
            };
            let attach_json = serde_json::to_string(&attach_msg)?;
            use crate::terminal::TerminalTransport;
            let mut transport = transport;
            transport.send_text(attach_json).await?;

            println!("Attached to session '{session_name}' via relay.");

            // Create cancellation channel
            let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

            // Spawn Ctrl+C handler
            let cancel_tx_clone = cancel_tx.clone();
            tokio::spawn(async move {
                tokio::signal::ctrl_c().await.ok();
                let _ = cancel_tx_clone.send(true);
            });

            // Create and run terminal session
            let session = crate::terminal::TerminalSession::new(
                session_name.to_string(),
                transport,
                cancel_rx,
            );

            // Detach key: Ctrl+B followed by 'd'
            let detach_key = crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Char('b'),
                crossterm::event::KeyModifiers::CONTROL,
            );

            session.run(Some(detach_key)).await?;

            println!("\nDetached from session.");
        }
    }

    Ok(())
}

/// Create a new tmux session on an agent.
///
/// Connects to the server to look up the agent's address, then connects
/// directly to the agent to send the `session.create` command.
///
/// # Arguments
///
/// * `server_url` - URL of the nession server
/// * `auth_token` - Authentication token
/// * `agent_id` - ID of the agent to create the session on
/// * `session_name` - Name for the new session
/// * `width` - Terminal width in columns
/// * `height` - Terminal height in rows
pub async fn create_session(
    server_url: &str,
    auth_token: &str,
    agent_id: &str,
    session_name: &str,
    width: u16,
    height: u16,
) -> Result<()> {
    // Connect to server to look up agent address
    let mut conn = ClientConnection::connect(server_url, auth_token)
        .await
        .with_context(|| "Failed to connect to server. Is the server running?")?;

    // Find the agent
    let agents = conn.list_agents().await?;
    conn.close().await.ok();

    let agent = agents
        .iter()
        .find(|a| a.agent_id == agent_id)
        .with_context(|| format!("Agent '{agent_id}' not found. Is it registered?"))?;

    if agent.status != "online" {
        anyhow::bail!(
            "Agent '{}' is not online (status: {}). Cannot create session.",
            agent_id,
            agent.status
        );
    }

    let agent_address = format!("{}:{}", agent.ip_address, agent.port);
    println!("Creating session '{session_name}' on agent '{agent_id}' ({width}x{height})...");

    let created_name = crate::client::connection::create_session_on_agent(
        &agent_address,
        session_name,
        width,
        height,
    )
    .await
    .with_context(|| format!("Failed to create session '{session_name}' on agent '{agent_id}'"))?;

    println!("Session '{created_name}' created successfully.");

    Ok(())
}

/// Kill a tmux session on an agent.
///
/// Parses the session_id (format: `agent_id:session_name`), looks up the
/// agent's address from the server, then connects directly to the agent
/// to send the `session.kill` command.
///
/// # Arguments
///
/// * `server_url` - URL of the nession server
/// * `auth_token` - Authentication token
/// * `session_id` - Session ID in format "agent_id:session_name"
pub async fn kill_session(server_url: &str, auth_token: &str, session_id: &str) -> Result<()> {
    // Parse session_id (format: agent_id:session_name)
    let (agent_id, session_name) = session_id.split_once(':').with_context(|| {
        format!("Invalid session ID '{session_id}'. Expected format: agent_id:session_name")
    })?;

    // Connect to server to look up agent address
    let mut conn = ClientConnection::connect(server_url, auth_token)
        .await
        .with_context(|| "Failed to connect to server. Is the server running?")?;

    // Find the agent
    let agents = conn.list_agents().await?;
    conn.close().await.ok();

    let agent = agents
        .iter()
        .find(|a| a.agent_id == agent_id)
        .with_context(|| format!("Agent '{agent_id}' not found. Is it registered?"))?;

    let agent_address = format!("{}:{}", agent.ip_address, agent.port);
    println!("Killing session '{session_name}' on agent '{agent_id}'...");

    let killed_name =
        crate::client::connection::kill_session_on_agent(&agent_address, session_name)
            .await
            .with_context(|| {
                format!("Failed to kill session '{session_name}' on agent '{agent_id}'")
            })?;

    println!("Session '{killed_name}' killed successfully.");

    Ok(())
}

/// Format a timestamp string (ISO 8601 or Unix seconds) into "Xs ago" or "Xm ago".
fn format_time_ago(timestamp: &str) -> String {
    // Try to parse as a datetime
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(timestamp) {
        let now = chrono::Utc::now();
        let dt_utc = dt.with_timezone(&chrono::Utc);
        let elapsed = now.signed_duration_since(dt_utc);
        let secs = elapsed.num_seconds();

        if secs < 0 {
            return "just now".to_string();
        }
        if secs < 60 {
            return format!("{secs}s ago");
        }
        let mins = secs / 60;
        if mins < 60 {
            return format!("{mins}m ago");
        }
        let hours = mins / 60;
        if hours < 24 {
            return format!("{hours}h ago");
        }
        let days = hours / 24;
        return format!("{days}d ago");
    }

    // Try to parse as unix timestamp (seconds)
    if let Ok(unix_secs) = timestamp.parse::<i64>() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let elapsed = now - unix_secs;

        if elapsed < 0 {
            return "just now".to_string();
        }
        if elapsed < 60 {
            return format!("{elapsed}s ago");
        }
        let mins = elapsed / 60;
        if mins < 60 {
            return format!("{mins}m ago");
        }
        let hours = mins / 60;
        if hours < 24 {
            return format!("{hours}h ago");
        }
        let days = hours / 24;
        return format!("{days}d ago");
    }

    // Fallback: return the original string
    timestamp.to_string()
}
