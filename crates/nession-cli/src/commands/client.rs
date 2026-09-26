//! Client-facing CLI commands implementation.

use anyhow::{Context, Result};
use std::time::{SystemTime, UNIX_EPOCH};

use nession_client::{AttachMode, ClientConfig, ClientConnection};
use nession_protocol::contracts::agent::v1::{AgentListReply, WebAgentInfo};
use nession_protocol::contracts::session::v1::{ClientSessionAttachReply, ServerSessionListReply};

/// Connect to the server, with this CLI's own failure sentence attached.
///
/// The boundary reports typed errors and no prose for the shell; where the
/// sentence lives here is a CLI decision, which is why `nession-client` has no
/// `anyhow` and this function does.
async fn connect(server_url: &str, auth_token: &str) -> Result<ClientConnection> {
    ClientConnection::connect(ClientConfig::new(server_url, auth_token))
        .await
        .with_context(|| "Failed to connect to server. Is the server running?")
}

/// List agents from the server and display them in a formatted table.
pub async fn list_agents(server_url: &str, auth_token: &str) -> Result<()> {
    // Connect to the server
    let mut client = connect(server_url, auth_token).await?;

    // Fetch agents. The reply is the contract's union — the list, or the
    // server's refusal — and the refusal's own sentence is what a reader needs,
    // so it is printed rather than described.
    let agents = match client.list_agents().await? {
        AgentListReply::Listed(list) => list.agents,
        AgentListReply::Refused(refusal) => {
            anyhow::bail!("Server refused to list agents: {}", refusal.message)
        }
    };

    // Close connection
    client.close().await.ok();

    // Display results
    if agents.is_empty() {
        println!("No agents registered.");
        return Ok(());
    }

    println!();
    println!("Agents:");
    println!(
        "{:<16}{:<18}{:<10}{:<12}{:<10}{:<15}",
        "ID", "HOSTNAME", "STATUS", "SESSIONS", "PROTOCOLS", "LAST HEARTBEAT"
    );

    for agent in &agents {
        let heartbeat_ago = format_time_ago(&agent.last_heartbeat);
        println!(
            "{:<16}{:<18}{:<10}{:<12}{:<10}{:<15}",
            agent.agent_id,
            agent.hostname,
            agent.status,
            agent.session_count,
            protocol_summary(agent),
            heartbeat_ago,
        );
    }
    println!();
    println!("{} agent(s) total", agents.len());

    Ok(())
}

/// How an agent's advertised protocol set reads in one column (`#678`).
///
/// `no manifest` rather than `0`: a peer this server has no manifest for is not
/// a peer that serves nothing, and printing `0` would report the second as the
/// first — they resolve differently.
///
/// Since `#678` became a breaking upgrade, registration refuses an agent that
/// advertises nothing, so this is a straggler that has not reconnected since
/// the server was upgraded. It is worth naming rather than hiding: every call
/// to that agent will come back `contract_not_supported`, and a reader looking
/// at this column should be able to see why.
fn protocol_summary(agent: &WebAgentInfo) -> String {
    match &agent.protocols {
        Some(manifest) => format!("{} units", manifest.protocols.len()),
        None => "no manifest".to_string(),
    }
}

/// List sessions from the server and display them in a formatted table.
pub async fn list_sessions(
    server_url: &str,
    auth_token: &str,
    agent_id: Option<&str>,
) -> Result<()> {
    // Connect to the server
    let mut client = connect(server_url, auth_token).await?;

    // Fetch sessions. Reading the contract's union is also what fixes a refusal
    // here: the consumer this replaces pulled `payload["sessions"]` out and ran
    // it through `Vec<SessionInfo>`, so a refusal — which has no `sessions` key
    // at all — surfaced as a serde error about a missing field rather than as
    // the sentence the server actually sent.
    let sessions = match client.list_sessions(agent_id).await? {
        ServerSessionListReply::Listed(list) => list.sessions,
        ServerSessionListReply::Refused(refusal) => {
            anyhow::bail!("Server refused to list sessions: {}", refusal.message)
        }
    };

    // Close connection
    client.close().await.ok();

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
    let mut client = connect(server_url, auth_token).await?;

    // Determine preferred mode
    let mode = match force_mode {
        Some("relay") => AttachMode::Relay,
        Some("p2p") | None => AttachMode::P2p,
        Some(other) => {
            anyhow::bail!("Invalid mode '{other}'. Use 'p2p' or 'relay'.");
        }
    };
    let mode_str = match mode {
        AttachMode::P2p => "p2p",
        AttachMode::Relay => "relay",
    };

    println!("Requesting to attach to session '{session_id}' (mode: {mode_str})...");

    // Request attach. The reply is the contract's, not a narrowed copy: it
    // carries `addresses` (the modern list) beside the legacy single
    // `agent_address`, and the consumer this replaces read only the legacy one —
    // which is why it could not reach an agent advertised solely over TLS.
    let attach = client
        .request_attach(session_id, mode)
        .await
        .with_context(|| "Failed to attach to session")?;

    // The reply is a union, so a refusal cannot be mistaken for an attach plan
    // with missing fields — which is what the flat struct this replaces made it
    // (a contract-abiding client could not decode a refusal at all: `missing
    // field 'mode'`). Nothing is lost by matching: a refusal carries no mode,
    // no address and no name, so there was never anything to proceed with.
    let attach = match attach {
        ClientSessionAttachReply::Attached(attach) => attach,
        ClientSessionAttachReply::Refused(refusal) => {
            anyhow::bail!("Attach request failed: {}", refusal.message)
        }
    };

    // The reply's own copy of the name is optional in the contract; the session
    // id already carries it as `agent_id:session_name`, which is where the relay
    // branch read it from anyway.
    let session_name = attach.session_name.clone().unwrap_or_else(|| {
        session_id
            .split(':')
            .nth(1)
            .unwrap_or(session_id)
            .to_string()
    });

    if attach.mode == "relay" {
        println!("Using relay mode (server proxies I/O)...");

        // The server relays on the connection this request was just answered
        // on, so the socket it was answered on *is* the transport.
        let transport =
            crate::terminal::raw::WebSocketTransport::new(client.into_relay_transport());

        attach_and_run(transport, &session_name, true).await
    } else {
        // `agent_address` is optional in the contract and required for this
        // branch — without one there is nowhere to connect. Naming the missing
        // field is more use than the parse failure the consumer this replaces
        // produced when a reply omitted it.
        let agent_address = attach.agent_address.clone().with_context(|| {
            "The server's attach reply named no agent address to connect to (P2P mode)"
        })?;
        println!("Connecting to agent at {agent_address} (P2P mode)...");

        // The credential from the reply we were just given (#1013). Required
        // rather than defaulted: the Server mints one on this path and hands it
        // to the Agent before answering, so a p2p reply without one is a
        // disagreement worth naming rather than a connection to attempt.
        let credential = attach
            .connection_token
            .clone()
            .with_context(|| "The server's attach reply carried no P2P credential (P2P mode)")?;

        // Through the boundary's one agent-socket constructor, not `open_ws`.
        // That is the seam #1013 exists for: one constructor is one signature to
        // change, rather than a search for every place a socket was opened.
        let agent_ws = nession_client::P2pConnection::connect(&agent_address, &credential)
            .await
            .with_context(|| format!("Failed to connect to agent at {agent_address}"))?
            .into_stream();
        let transport = crate::terminal::raw::WebSocketTransport::new(agent_ws);

        attach_and_run(transport, &session_name, false).await
    }
}

/// Send `agent.attach` on this transport, then run the terminal until the
/// session ends or the user detaches.
///
/// Both attach paths do exactly this once they have a socket — they differ only
/// in where the socket came from — and they did it in two copies. `relay` picks
/// the sentence printed and nothing else.
async fn attach_and_run<T: crate::terminal::TerminalTransport>(
    transport: T,
    session_name: &str,
    relay: bool,
) -> Result<()> {
    // One builder for both transports. The two copies this replaces each built
    // their own `agent.attach` frame, and had already diverged in where the
    // session name came from.
    let (cols, rows) = crate::terminal::raw::RawTerminal::size()?;
    let attach_msg = nession_client::attach_frame(session_name, cols, rows);

    // `send_text` comes from the `T: TerminalTransport` bound on this function,
    // so the trait needs no import of its own here.
    let mut transport = transport;
    transport
        .send_text(serde_json::to_string(&attach_msg)?)
        .await?;

    if relay {
        println!("Attached to session '{session_name}' via relay.");
    } else {
        println!("Attached to session '{session_name}'. Press Ctrl+B then D to detach.");
    }

    // Create cancellation channel
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

    // Spawn Ctrl+C handler
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        let _ = cancel_tx.send(true);
    });

    // Create and run terminal session
    let session =
        crate::terminal::TerminalSession::new(session_name.to_string(), transport, cancel_rx);

    // Detach key: Ctrl+B followed by 'd'
    let detach_key = crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('b'),
        crossterm::event::KeyModifiers::CONTROL,
    );

    session.run(Some(detach_key)).await?;

    println!("\nDetached from session.");

    Ok(())
}

/// Seconds since the Unix epoch, for the agent-facing envelopes built here.
/// Create a new tmux session on an agent.
///
/// **One request on one authenticated connection.** It used to be three steps
/// over two sockets: list every agent on the Server connection, pick this one
/// out of the reply, *close* that connection, then dial the agent directly and
/// speak a management command to it. That is the Server's job — authenticate,
/// authorize, resolve the target, route — performed by a client that had
/// already authenticated, which is why #1015 removes it rather than patches it.
///
/// It is also what makes the operation expressible at all now: the direct dial
/// carried no credential, and the Agent refuses an uncredentialed connection
/// (#1013). A consumer that never contacts the Server has nothing to present.
///
/// # ⚠ `--width` and `--height` do not do anything
///
/// They are accepted and ignored, and **always have been** — including on the
/// direct-agent path this replaces, which passed them to an Agent function whose
/// own doc says the parameters are ignored. Every session is created at
/// `SESSION_WIDTH` × `SESSION_HEIGHT` (200×60) and resized by the first client
/// to attach; the size a session has is a property of whoever attached last, not
/// of who created it (the sizing decision of 2026-08-15).
///
/// Verified rather than inferred: a session created with `--width 111` came up
/// at 200 on both paths.
///
/// They are still here, still named in the shell, and still passed through,
/// because **what to do about them is a product decision this change must not
/// take on its own** — either they go, or a create-time size becomes something
/// the Agent honours, and that second one edits a deliberate design.
///
/// # Arguments
///
/// * `server_url` - URL of the nession server
/// * `auth_token` - Authentication token
/// * `agent_id` - ID of the agent to create the session on
/// * `session_name` - Name for the new session
/// * `_width` - Ignored; see above
/// * `_height` - Ignored; see above
pub async fn create_session(
    server_url: &str,
    auth_token: &str,
    agent_id: &str,
    session_name: &str,
    _width: u16,
    _height: u16,
) -> Result<()> {
    let mut client = connect(server_url, auth_token).await?;
    println!("Creating session '{session_name}' on agent '{agent_id}'...");

    let reply = client
        .create_session(agent_id, session_name)
        .await
        .with_context(|| {
            format!("Failed to create session '{session_name}' on agent '{agent_id}'")
        })?;
    client.close().await.ok();

    if !reply.success {
        // The Server's own sentence, not a paraphrase of it. It knows which of
        // the cases this is — an unknown agent, an offline one, a name already
        // taken — and a client that restates it can only be less specific.
        let reason = reply.error.unwrap_or_else(|| "no reason given".to_string());
        anyhow::bail!("Server refused to create session '{session_name}': {reason}");
    }

    println!(
        "Session '{}' created successfully.",
        reply.session_id.as_deref().unwrap_or(session_name)
    );

    Ok(())
}

/// Kill a tmux session on an agent.
///
/// Parses the session_id (format: `agent_id:session_name`) and asks the Server,
/// which resolves the agent and routes the kill. The parse stays because the
/// wire takes a whole `session_id` and a malformed one is worth naming here
/// rather than sending for the Server to reject.
///
/// # Arguments
///
/// * `server_url` - URL of the nession server
/// * `auth_token` - Authentication token
/// * `session_id` - Session ID in format "agent_id:session_name"
pub async fn kill_session(server_url: &str, auth_token: &str, session_id: &str) -> Result<()> {
    let (agent_id, session_name) = session_id.split_once(':').with_context(|| {
        format!("Invalid session ID '{session_id}'. Expected format: agent_id:session_name")
    })?;

    let mut client = connect(server_url, auth_token).await?;
    println!("Killing session '{session_name}' on agent '{agent_id}'...");

    let reply = client.kill_session(session_id).await.with_context(|| {
        format!("Failed to kill session '{session_name}' on agent '{agent_id}'")
    })?;
    client.close().await.ok();

    if !reply.success {
        let reason = reply.error.unwrap_or_else(|| "no reason given".to_string());
        anyhow::bail!("Server refused to kill session '{session_name}': {reason}");
    }

    println!("Session '{session_name}' killed successfully.");

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
