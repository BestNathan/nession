//! Client-facing CLI commands implementation.

use anyhow::{Context, Result};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nession_client::{AttachMode, ClientConfig, ClientConnection, RelayBeginOutcome};
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

/// How the CLI chooses a route to the Agent (`#2811`).
///
/// The contract documents `"auto"` as resolved **by the client** — it asks for
/// `p2p` and falls back to `relay` — so this policy lives here rather than on
/// the wire. `nession-client` keeps only the two wire modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachPolicy {
    /// Try the Server's P2P candidates in order, then a fresh Server relay
    /// attach. The default.
    Auto,
    /// Only the advertised P2P candidates. Never switches to relay.
    P2p,
    /// Only the Server relay. This process dials no Agent address.
    Relay,
}

impl AttachPolicy {
    fn parse(force_mode: Option<&str>) -> Result<Self> {
        match force_mode {
            None | Some("auto") => Ok(Self::Auto),
            Some("p2p") => Ok(Self::P2p),
            Some("relay") => Ok(Self::Relay),
            Some(other) => {
                anyhow::bail!("Invalid mode '{other}'. Use 'auto' (default), 'p2p', or 'relay'.")
            }
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::P2p => "p2p",
            Self::Relay => "relay",
        }
    }
}

/// A confirmed transport to the Session, plus the route it came from.
pub struct AttachRoute {
    pub transport: crate::terminal::raw::WebSocketTransport,
    pub session_name: String,
    /// True when the Server is proxying the terminal.
    pub relay: bool,
    /// The Agent address a P2P route dialled, or `"relay"`.
    pub route: String,
}

/// How long one advertised P2P candidate may take to accept a WebSocket.
///
/// A dial against a blackholed endpoint otherwise waits out the operating
/// system's TCP timeout, which is tens of seconds per candidate. A failed
/// candidate must not consume the operation's whole budget.
const P2P_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Replace the scoped credential a failed dial carried.
///
/// A `ClientError::Connect` names the URL it dialled, and that URL carries the
/// Server-issued credential in its query (#1013). The credential is short-lived
/// and scoped, but it is still the thing that authorises the attach, and a
/// failure sentence printed to a terminal or captured by CI is not where it
/// belongs. The endpoint and the reason stay: they are what makes the sentence
/// actionable.
fn redact_credential(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    const MARKER: &str = "token=";
    while let Some(position) = rest.find(MARKER) {
        let (before, after) = rest.split_at(position + MARKER.len());
        out.push_str(before);
        out.push_str("<redacted>");
        let end = after
            .find(|character: char| {
                !(character.is_ascii_alphanumeric()
                    || character == '%'
                    || character == '-'
                    || character == '_')
            })
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// The session name the attach reply names, falling back to the `agent:name`
/// composite the request already carried.
fn attach_session_name(session_id: &str, reply_name: Option<&str>) -> String {
    reply_name.map(str::to_string).unwrap_or_else(|| {
        session_id
            .split(':')
            .nth(1)
            .unwrap_or(session_id)
            .to_string()
    })
}

/// Prefix for an error that followed failed direct routes.
fn p2p_context(p2p_failure: Option<&String>) -> String {
    match p2p_failure {
        Some(reason) => format!("P2P did not reach the agent ({reason}). "),
        None => String::new(),
    }
}

/// Choose and establish the route this attach will use (`#2811`).
///
/// **Auto** asks for a P2P plan, tries every advertised candidate in the
/// Server's order, and only then requests a fresh Server relay attach. The
/// legacy single `agent_address` is the fallback candidate when the modern list
/// is empty. A P2P reply with no Server-issued credential is never dialled:
/// `nession-client`'s one agent-socket constructor requires that credential
/// (#1013), and guessing past its absence would be the credential bypass that
/// boundary exists to prevent.
///
/// **P2P** and **Relay** are forced route families, not preferences: a forced
/// P2P caller gets an actionable error rather than a silent relay switch, and a
/// forced relay caller dials no Agent address itself.
pub async fn resolve_attach_route(
    mut client: ClientConnection,
    session_id: &str,
    policy: AttachPolicy,
    cols: u16,
    rows: u16,
) -> Result<AttachRoute> {
    if policy == AttachPolicy::Relay {
        return enter_relay(client, session_id, cols, rows, None).await;
    }

    // Request attach. The reply is the contract's, not a narrowed copy: it
    // carries `addresses` (the modern list) beside the legacy single
    // `agent_address`, and the consumer this replaces read only the legacy one —
    // which is why it could not reach an agent advertised solely over TLS.
    let attach = client
        .request_attach(session_id, AttachMode::P2p)
        .await
        .with_context(|| "Failed to attach to session")?;

    // The reply is a union, so a refusal cannot be mistaken for an attach plan
    // with missing fields. Nothing is lost by matching: a refusal carries no
    // mode, no address and no name, so there was never anything to proceed
    // with. Auto does not retry relay after a delivered refusal: the Server
    // checks the Session and Agent before it chooses a mode, so its sentence
    // would be the same one and is the thing worth handing on.
    let attach = match attach {
        ClientSessionAttachReply::Attached(attach) => attach,
        ClientSessionAttachReply::Refused(refusal) => {
            anyhow::bail!("Attach request failed: {}", refusal.message)
        }
    };
    let session_name = attach_session_name(session_id, attach.session_name.as_deref());

    if attach.mode == "relay" {
        // A Server that answers a P2P request with the relay route is offering
        // the only route it has. Forced P2P asked not to take it.
        if policy == AttachPolicy::P2p {
            anyhow::bail!(
                "The server answered a P2P attach request with relay mode; \
                 re-run without --mode p2p to allow the relay route."
            );
        }
        return enter_relay(client, session_id, cols, rows, None).await;
    }

    // The Server's order is the order the Server ranked these in; the CLI does
    // not re-rank them. A malformed URL is still a candidate: it fails its own
    // dial and the next one is tried, which is the same rule as an unreachable
    // endpoint.
    let mut candidates: Vec<String> = attach
        .addresses
        .iter()
        .map(|probed| probed.address.url.trim().to_string())
        .filter(|url| !url.is_empty())
        .collect();
    if candidates.is_empty() {
        if let Some(legacy) = attach.agent_address.as_deref() {
            let legacy = legacy.trim();
            if !legacy.is_empty() {
                candidates.push(legacy.to_string());
            }
        }
    }

    let p2p_failure = match attach.connection_token.as_deref() {
        // Required rather than defaulted: the Server mints one on this path and
        // hands it to the Agent before answering, so a P2P reply without one is
        // a disagreement worth naming rather than a connection to attempt.
        None => Some(
            "the server's P2P attach reply carried no connection credential, so no Agent was dialled"
                .to_string(),
        ),
        Some(_) if candidates.is_empty() => {
            Some("the server's P2P attach reply named no agent address to connect to".to_string())
        }
        Some(credential) => {
            let mut failures = Vec::new();
            for url in &candidates {
                println!("Connecting to agent at {url} (P2P mode)...");
                // Through the boundary's one agent-socket constructor, not
                // `open_ws`. That is the seam #1013 exists for: one
                // constructor is one signature to change, rather than a
                // search for every place a socket was opened.
                match tokio::time::timeout(
                    P2P_CONNECT_TIMEOUT,
                    nession_client::P2pConnection::connect(url, credential),
                )
                .await
                {
                    Ok(Ok(connection)) => {
                        return Ok(AttachRoute {
                            transport: crate::terminal::raw::WebSocketTransport::new(
                                connection.into_stream(),
                            ),
                            session_name,
                            relay: false,
                            route: url.clone(),
                        });
                    }
                    Ok(Err(error)) => {
                        let reason = redact_credential(&error.to_string());
                        println!("  ...failed: {reason}");
                        failures.push(format!("{url}: {reason}"));
                    }
                    Err(_) => {
                        let reason =
                            format!("timed out after {}s", P2P_CONNECT_TIMEOUT.as_secs());
                        println!("  ...failed: {reason}");
                        failures.push(format!("{url}: {reason}"));
                    }
                }
            }
            Some(format!(
                "no advertised P2P candidate answered; tried {}: {}",
                candidates.len(),
                failures.join("; ")
            ))
        }
    };

    match policy {
        AttachPolicy::P2p => {
            let reason = p2p_failure.unwrap_or_else(|| "P2P is unavailable".to_string());
            anyhow::bail!(
                "Could not attach to session '{session_id}' over P2P: {reason}. \
                 Use --mode auto (or omit --mode) to allow a relay fallback."
            );
        }
        AttachPolicy::Auto => enter_relay(client, session_id, cols, rows, p2p_failure).await,
        AttachPolicy::Relay => unreachable!("handled above"),
    }
}

/// Establish the Server relay route after a relay attach and a begin.
///
/// The Server, not this process, dials the Agent and sends `agent.attach`, so
/// the returned transport must **not** send `agent.attach` again. `relay_begin`
/// confirms the Server's relay attach receipt before this returns; a refusal or
/// a closed socket becomes an error that also names the failed direct routes.
async fn enter_relay(
    mut client: ClientConnection,
    session_id: &str,
    cols: u16,
    rows: u16,
    p2p_failure: Option<String>,
) -> Result<AttachRoute> {
    println!("Requesting a relay attach for session '{session_id}'...");
    let reply = client
        .request_attach(session_id, AttachMode::Relay)
        .await
        .with_context(|| "Failed to request a relay attach")?;
    let attach = match reply {
        ClientSessionAttachReply::Attached(attach) => attach,
        ClientSessionAttachReply::Refused(refusal) => {
            anyhow::bail!(
                "{}Relay attach failed: {}",
                p2p_context(p2p_failure.as_ref()),
                refusal.message
            )
        }
    };
    if attach.mode != "relay" {
        anyhow::bail!(
            "{}The server answered a relay attach request with mode '{}'.",
            p2p_context(p2p_failure.as_ref()),
            attach.mode
        );
    }
    let session_name = attach_session_name(session_id, attach.session_name.as_deref());
    println!("Using relay mode (server proxies I/O)...");

    // `size_known: Some(true)` because this is a measurement of the terminal
    // the process is running in, not the 80x24 placeholder a client that has
    // not measured would state (#1265).
    let outcome = client
        .relay_begin(session_id, cols, rows, Some(true))
        .await
        .with_context(|| {
            format!(
                "{}The relay did not start",
                p2p_context(p2p_failure.as_ref())
            )
        })?;
    let buffered = match outcome {
        RelayBeginOutcome::Ready { buffered } | RelayBeginOutcome::Unconfirmed { buffered } => {
            buffered
        }
        RelayBeginOutcome::Refused { message } => {
            anyhow::bail!(
                "{}Relay attach failed: {message}",
                p2p_context(p2p_failure.as_ref())
            )
        }
    };

    Ok(AttachRoute {
        // The server relays on the connection this request was just answered
        // on, so the socket it was answered on *is* the transport. Frames the
        // Server forwarded before its receipt are the session's first screen
        // and are replayed ahead of the socket.
        transport: crate::terminal::raw::WebSocketTransport::with_pending(
            client.into_relay_transport(),
            buffered,
        ),
        session_name,
        relay: true,
        route: "relay".to_string(),
    })
}

/// Attach to a remote tmux session.
///
/// Connects to the Server, resolves a route under `force_mode`'s policy, and
/// then forwards terminal I/O bidirectionally until the session ends or the
/// user detaches. The default policy is [`AttachPolicy::Auto`] (#2811).
///
/// # Arguments
///
/// * `server_url` - URL of the nession server
/// * `auth_token` - Authentication token
/// * `session_id` - Session ID in format "agent_id:session_name"
/// * `force_mode` - Optional mode override ("auto", "p2p" or "relay")
pub async fn attach_session(
    server_url: &str,
    auth_token: &str,
    session_id: &str,
    force_mode: Option<&str>,
) -> Result<()> {
    let policy = AttachPolicy::parse(force_mode)?;

    // Measured once: the P2P attach frame and the relay begin both state the
    // terminal this process is running in.
    let (cols, rows) = crate::terminal::raw::RawTerminal::size()?;

    let client = connect(server_url, auth_token).await?;
    println!(
        "Requesting to attach to session '{session_id}' (mode: {})...",
        policy.as_str()
    );
    let route = resolve_attach_route(client, session_id, policy, cols, rows).await?;
    if !route.relay {
        println!("Using P2P route {}.", route.route);
    }
    attach_and_run(
        route.transport,
        &route.session_name,
        route.relay,
        cols,
        rows,
    )
    .await
}

/// Send `agent.attach` on a P2P transport (the Server already sent it on a
/// relay) and run the terminal until the session ends or the user detaches.
async fn attach_and_run<T: crate::terminal::TerminalTransport>(
    transport: T,
    session_name: &str,
    relay: bool,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let mut transport = transport;
    if !relay {
        // One builder for both transports. `send_text` comes from the
        // `T: TerminalTransport` bound on this function, so the trait needs no
        // import of its own here.
        let attach_msg = nession_client::attach_frame(session_name, cols, rows);
        transport
            .send_text(serde_json::to_string(&attach_msg)?)
            .await?;
    }

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
/// Creation takes no dimensions (#2268). Every session starts at
/// `SESSION_WIDTH` × `SESSION_HEIGHT` (200×60) and the first client to attach
/// states the size it ends up with; a create-time size was accepted and
/// ignored on every path since the sizing decision of 2026-08-15, so the
/// options have been removed rather than kept as phantom controls. The
/// `session create` command now rejects them instead of silently succeeding
/// with a size it does not apply.
///
/// # Arguments
///
/// * `server_url` - URL of the nession server
/// * `auth_token` - Authentication token
/// * `agent_id` - ID of the agent to create the session on
/// * `session_name` - Name for the new session
pub async fn create_session(
    server_url: &str,
    auth_token: &str,
    agent_id: &str,
    session_name: &str,
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
