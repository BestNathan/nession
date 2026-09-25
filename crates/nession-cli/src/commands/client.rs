//! Client-facing CLI commands implementation.

use anyhow::{Context, Result};
use std::time::{SystemTime, UNIX_EPOCH};

use nession_client::{AttachMode, ClientConfig, ClientConnection};
use nession_protocol::contracts::agent::v1::{AgentListReply, WebAgentInfo};
use nession_protocol::contracts::session::v1::{ClientSessionAttachReply, ServerSessionListReply};
use nession_protocol::Message;

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

        let agent_ws = nession_client::open_ws(&agent_address)
            .await
            .with_context(|| format!("Failed to connect to agent at {agent_address}"))?;
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
    // The agent's own module, not a contract: `agent.attach` is a wire the agent
    // dispatches and the catalog does not carry, so there is nothing to import
    // from `nession-protocol` yet. Removing this import is stage 3 of #1015 —
    // see the R4 decision in its plan.
    use nession_agent::server::websocket::{
        msg_types as agent_msg_types, ClientAttachPayload, Message as AgentMessage,
    };

    let (cols, rows) = crate::terminal::raw::RawTerminal::size()?;
    let attach_msg = AgentMessage {
        msg_type: agent_msg_types::CLIENT_ATTACH.to_string(),
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: now_seconds(),
        payload: ClientAttachPayload {
            session_name: session_name.to_string(),
            width: cols,
            height: rows,
            env_snapshots: Vec::new(),
        },
    };

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
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
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
    let mut client = connect(server_url, auth_token).await?;

    // Find the agent
    let agents = match client.list_agents().await? {
        AgentListReply::Listed(list) => list.agents,
        AgentListReply::Refused(refusal) => {
            anyhow::bail!("Server refused to list agents: {}", refusal.message)
        }
    };
    client.close().await.ok();

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

    let created_name = create_session_on_agent(&agent_address, session_name, width, height)
        .await
        .with_context(|| {
            format!("Failed to create session '{session_name}' on agent '{agent_id}'")
        })?;

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
    let mut client = connect(server_url, auth_token).await?;

    // Find the agent
    let agents = match client.list_agents().await? {
        AgentListReply::Listed(list) => list.agents,
        AgentListReply::Refused(refusal) => {
            anyhow::bail!("Server refused to list agents: {}", refusal.message)
        }
    };
    client.close().await.ok();

    let agent = agents
        .iter()
        .find(|a| a.agent_id == agent_id)
        .with_context(|| format!("Agent '{agent_id}' not found. Is it registered?"))?;

    let agent_address = format!("{}:{}", agent.ip_address, agent.port);
    println!("Killing session '{session_name}' on agent '{agent_id}'...");

    let killed_name = kill_session_on_agent(&agent_address, session_name)
        .await
        .with_context(|| {
            format!("Failed to kill session '{session_name}' on agent '{agent_id}'")
        })?;

    println!("Session '{killed_name}' killed successfully.");

    Ok(())
}

// ── The direct-to-agent management path ─────────────────────────────────────
//
// **Stage 2 of #1015 deletes both of these**, and they are here rather than in
// `nession-client` on purpose.
//
// Creating and killing a session goes *direct to the agent* today. The Server
// already serves `server.session.create` and `server.session.kill` — this crate
// has simply never asked it — so what an operator runs is a second control
// plane that skips the Server's whole authenticate → authorize → resolve target
// → route path, over a socket the agent asks no authentication for.
//
// It lives in the CLI because that is the shape of the mistake: a CLI-local
// shortcut. `nession-client`'s dependency list has no `nession-agent` and no
// `nession-server`, so the shared boundary *cannot spell this* — which is the
// point. Moving these two functions there would make the accidental management
// plane part of the official client and hand it to the next consumer.

// TODO(#1015 stage 2): delete both, and send `server.session.*` on the
// authenticated connection instead.
//
// Note the wire is a literal here rather than a `nession-client` constant: the
// boundary carries no `agent.*` unit yet, and giving it one is stage 3's job
// (it is also where the P2P credential lands, so the two changes are one).
async fn create_session_on_agent(
    agent_address: &str,
    session_name: &str,
    width: u16,
    height: u16,
) -> Result<String> {
    let reply = ask_agent(
        agent_address,
        "agent.session.create",
        "create",
        serde_json::json!({ "name": session_name, "width": width, "height": height }),
    )
    .await?;

    Ok(agent_session_name(&reply, session_name))
}

async fn kill_session_on_agent(agent_address: &str, session_name: &str) -> Result<String> {
    let reply = ask_agent(
        agent_address,
        "agent.session.kill",
        "kill",
        serde_json::json!({ "name": session_name }),
    )
    .await?;

    Ok(agent_session_name(&reply, session_name))
}

/// The name the agent reported, falling back to the one we asked about.
fn agent_session_name(reply: &serde_json::Value, asked_for: &str) -> String {
    reply
        .get("payload")
        .and_then(|payload| payload.get("name"))
        .and_then(|name| name.as_str())
        .unwrap_or(asked_for)
        .to_string()
}

/// Put one request on a direct agent socket and read one answer.
///
/// Envelopes here go through [`Message`] rather than a hand-built `json!` block
/// for a reason worth stating: a literal envelope key in this file would make it
/// a *declaring* file to `scripts/protocol-gate.mjs`, and a declaring file has
/// every dotted constant in it added to the wire set the gate checks against.
/// There are none here today, and the gate's selftest now fails if one appears.
async fn ask_agent(
    agent_address: &str,
    wire: &str,
    id_prefix: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value> {
    use futures_util::{SinkExt, StreamExt};

    let url = format!("ws://{agent_address}");
    let mut ws = nession_client::open_ws(&url)
        .await
        .with_context(|| format!("Failed to connect to agent at {url}"))?;

    let request = Message::new(
        wire,
        format!("{id_prefix}-{}", now_seconds()),
        now_seconds(),
        payload,
    );
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        serde_json::to_string(&request)?,
    ))
    .await
    .with_context(|| format!("Failed to send {wire} to agent"))?;

    let Some(frame) = ws.next().await else {
        anyhow::bail!("Agent closed the connection before answering {wire}")
    };
    let tokio_tungstenite::tungstenite::Message::Text(text) = frame? else {
        anyhow::bail!("Unexpected message type from agent")
    };
    let response: serde_json::Value = serde_json::from_str(&text)?;

    let msg_type = response
        .get("msg_type")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    match msg_type {
        "ok" => Ok(response),
        "error" => {
            let code = response
                .get("payload")
                .and_then(|payload| payload.get("code"))
                .and_then(|code| code.as_str())
                .unwrap_or("unknown");
            let message = response
                .get("payload")
                .and_then(|payload| payload.get("message"))
                .and_then(|message| message.as_str())
                .unwrap_or("unknown error");
            anyhow::bail!("Agent error ({code}): {message}")
        }
        other => {
            anyhow::bail!("Unexpected response from agent: expected 'ok' or 'error', got '{other}'")
        }
    }
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
