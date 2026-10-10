//! Connection-scoped Server dispatch, state and shared mechanisms.

use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::env::EnvService;
use crate::registry::{AgentInfo, AgentRegistry, AgentStatus, SessionRegistry, SessionStatus};
use crate::server::client_registry::ClientRegistry;
use crate::server::command_broker::{CommandBroker, ConnectionGeneration};
// The four policies by name, because the `server_routes!` invocation at the
// bottom of this file declares one per unit and the names are the column there.
use crate::server::execution::ResourceKey;
use crate::server::outbound::WsMessageSender;
use crate::server::web_client_registry::WebClientRegistry;
use nession_common::display_name::validate_display_name;
use nession_common::env_file::parse_env;
use nession_protocol::contracts::agent::v1::{
    AddressStatus, AgentAddressUpdatePayload, AgentListReply, AgentRefusal, AgentRegisterPayload,
    AgentRenameFailure, AgentRenameReply, AgentRenameResponse, WebAgentsListResponse,
};
use nession_protocol::contracts::client::v1::{AuthResponsePayload, ClientAuthPayload};
use nession_protocol::contracts::env::v1::{
    ClientEnvDeletePayload, ClientEnvDeleteResponsePayload, ClientEnvGetPayload,
    ClientEnvGetResponsePayload, ClientEnvListPayload, ClientEnvListResponsePayload,
    ClientEnvWritePayload, ClientEnvWriteResponsePayload, EnvFileRef, EnvSnapshot, EnvSource,
};
use nession_protocol::contracts::p2p::agent_url_with_credential;
use nession_protocol::contracts::p2p::v1::{CredentialScope, P2pGrantPayload};
use nession_protocol::contracts::session::v1::{
    AgentTerminalResizePayload, ClientRelayBeginPayload, ClientSessionCapturePreviewPayload,
    ClientSessionCreatePayload, ClientSessionCreateResponsePayload, ClientSessionEnvActivePayload,
    ClientSessionEnvApplyPayload, ClientSessionEnvQueryPayload, ClientSessionEnvResponsePayload,
    ClientSessionEnvUnsetPayload, ClientSessionKillPayload, ServerSessionListPayload,
    ServerSessionListReply, ServerTerminalResizePayload, SessionEnvActiveResponse,
    SessionEnvQueryResponse, SessionRefusal, WebSessionInfo, WebSessionKillResponse,
    WebSessionsListResponse,
};
use nession_protocol::ProtocolMessage;

/// Per-agent deadline for the force-refresh session query. Deliberately much
/// shorter than the general 10s command timeout: a user is watching a spinner,
/// and a slow agent is reported as stale rather than blocking the response.
const SESSION_REFRESH_TIMEOUT: Duration = Duration::from_secs(3);

/// Action returned by the connection handler after processing a message.
pub enum HandlerAction {
    /// Send an optional reply message back to the sender.
    Reply(Option<Message>),
    /// Enter relay mode: forward messages between this client and the agent.
    /// The server tries each URL in order with a fast timeout until one connects.
    Relay {
        /// Candidate agent WebSocket URLs, best-first (Reachable > Unknown > Unreachable).
        agent_ws_urls: Vec<String>,
        /// Session id ("agent_id:session_name") for client registry tracking.
        session_id: String,
        /// Short session name for agent protocol messages (agent.attach, etc.).
        session_name: String,
        /// Unique client id assigned for this relay connection.
        client_id: String,
        /// The stable identity the browser presented on `server.auth`, when it
        /// presented one (#1429).
        ///
        /// The relay presents this to the Agent as the connection's identity,
        /// so the ids the Agent publishes — the controller in
        /// `agent.terminal.control.changed`, the one in the acquire reply —
        /// are ids the browser can recognise as its own. Without it the Agent
        /// knows every relayed browser, and the Server itself, by one shared
        /// `unknown-client`.
        browser_client_id: Option<String>,
        /// Resolved env snapshots to inject via agent.attach to the agent.
        env_snapshots: Vec<EnvSnapshot>,
        /// Terminal columns for the initial tmux resize (from browser viewport).
        cols: u16,
        /// Terminal rows for the initial tmux resize (from browser viewport).
        rows: u16,
        /// Whether `cols`/`rows` are the browser's own measurement, forwarded
        /// verbatim into the `agent.attach` the Server builds. `Some(false)`
        /// tells the agent the browser has not laid a terminal out yet, so the
        /// shared window must keep its size rather than take the placeholder
        /// (#1265). `None` preserves the behaviour of a client that predates
        /// the question.
        size_known: Option<bool>,
        /// The browser's answer to whether the relay should open with a
        /// bootstrap (#321), forwarded verbatim into the `agent.attach` the
        /// Server builds. `None` leaves the agent to decide.
        needs_bootstrap: Option<bool>,
    },
    /// Close the connection.
    Close,
}

pub struct ConnectionHandler {
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    client_registry: Arc<ClientRegistry>,
    web_client_registry: Arc<WebClientRegistry>,
    env_service: Arc<EnvService>,
    /// Database handle for quick-command CRUD (issue #95, part 3).
    db: Arc<crate::db::Database>,
    config: ConnectionHandlerConfig,
    authenticated_client: bool,
    registered_agent_id: Option<String>,
    /// Identity of the connection this handler serves, taken from the broker at
    /// construction.
    ///
    /// One handler per accepted WebSocket, so this *is* the connection's
    /// identity: it is what the broker compares when deciding who owns an
    /// agent, which is how a superseded connection is kept from moving state
    /// that belongs to its replacement (#960).
    connection_generation: ConnectionGeneration,
    /// Outgoing message sender for this client connection (set after construction).
    client_sender: Option<WsMessageSender>,
    /// Session this client is attached to via relay (for cleanup on disconnect).
    attached_session_id: Option<String>,
    /// Unique client id for this relay attachment (for cleanup on disconnect).
    attached_client_id: Option<String>,
    /// The stable identity this browser presented on `server.auth` (#1429).
    ///
    /// Kept because the relay is the transport that has to *say* who it is
    /// acting for: the Agent knows one connection per relayed browser-session,
    /// and everything it publishes about control names a client id the browser
    /// is expected to compare against its own (`agentControlLease`). A relay
    /// that does not carry this id leaves the Agent naming every browser, and
    /// the Server itself, `unknown-client`.
    browser_client_id: Option<String>,
    /// The P2P credential ledger, for minting on attach (#1013).
    p2p_broker: Arc<crate::broker::ConnectionBroker>,
}

/// A clone is a **snapshot of one connection's identity at one moment** — what
/// a query-lane task is handed (`server::execution`).
///
/// The shared services are `Arc`s and clone as themselves, so a clone reads and
/// writes the same registries, broker and env store as the connection it came
/// from. The connection-local facts (`authenticated_client`,
/// `registered_agent_id`, the relay attachment) are values, and a clone gets
/// them as they were when it was taken — which is exactly the semantics a query
/// needs, since a query is read *after* the ordered lane applied everything
/// before it and must not see an identity change that arrives later.
///
/// Written out rather than derived because of the second half of that sentence:
/// a change a *clone* makes to those facts is invisible to the connection, so a
/// unit declared `Query` that mutates them loses the change. See
/// `ExecutionPolicy::Query` — a query answers, and it does nothing else.
impl Clone for ConnectionHandler {
    fn clone(&self) -> Self {
        Self {
            agent_registry: Arc::clone(&self.agent_registry),
            session_registry: Arc::clone(&self.session_registry),
            command_broker: Arc::clone(&self.command_broker),
            client_registry: Arc::clone(&self.client_registry),
            web_client_registry: Arc::clone(&self.web_client_registry),
            env_service: Arc::clone(&self.env_service),
            db: Arc::clone(&self.db),
            // Shared, not connection-local: the ledger is the Server's, and a
            // clone that took a copy of it would be a clone that could not mint.
            p2p_broker: Arc::clone(&self.p2p_broker),
            config: ConnectionHandlerConfig {
                server_auth_token: self.config.server_auth_token.clone(),
                heartbeat_interval_secs: self.config.heartbeat_interval_secs,
            },
            authenticated_client: self.authenticated_client,
            registered_agent_id: self.registered_agent_id.clone(),
            connection_generation: self.connection_generation,
            client_sender: self.client_sender.clone(),
            attached_session_id: self.attached_session_id.clone(),
            attached_client_id: self.attached_client_id.clone(),
            browser_client_id: self.browser_client_id.clone(),
        }
    }
}

/// Immutable per-connection configuration.
pub struct ConnectionHandlerConfig {
    pub server_auth_token: String,
    pub heartbeat_interval_secs: u64,
}

/// Shared dependencies for a connection handler.
pub struct ConnectionHandlerDeps {
    pub agent_registry: Arc<AgentRegistry>,
    pub session_registry: Arc<SessionRegistry>,
    pub command_broker: Arc<CommandBroker>,
    pub client_registry: Arc<ClientRegistry>,
    pub web_client_registry: Arc<WebClientRegistry>,
    pub env_service: Arc<EnvService>,
    pub db: Arc<crate::db::Database>,
    /// The P2P credential ledger (#1013).
    ///
    /// A shared dependency rather than per-connection configuration, for the
    /// same reason `command_broker` is: the credentials it holds outlive any one
    /// connection and are visible to every one of them.
    pub p2p_broker: Arc<crate::broker::ConnectionBroker>,
}

impl ConnectionHandler {
    pub fn new(deps: ConnectionHandlerDeps, config: ConnectionHandlerConfig) -> Self {
        // Take this connection's identity from the broker, which is the only
        // thing that ever compares it.
        let connection_generation = deps.command_broker.new_connection_generation();
        Self {
            agent_registry: deps.agent_registry,
            session_registry: deps.session_registry,
            command_broker: deps.command_broker,
            client_registry: deps.client_registry,
            web_client_registry: deps.web_client_registry,
            env_service: deps.env_service,
            db: deps.db,
            p2p_broker: deps.p2p_broker,
            config,
            authenticated_client: false,
            registered_agent_id: None,
            connection_generation,
            client_sender: None,
            attached_session_id: None,
            attached_client_id: None,
            browser_client_id: None,
        }
    }

    pub fn registered_agent_id(&self) -> Option<&String> {
        self.registered_agent_id.as_ref()
    }

    /// Identity of the connection this handler serves.
    ///
    /// `server/websocket.rs` hands it back to the broker with every agent
    /// message it claims, and with the release on disconnect — so the claim
    /// that ends a reconnect can only ever be released by the connection that
    /// made it.
    pub fn connection_generation(&self) -> ConnectionGeneration {
        self.connection_generation
    }

    /// The agent this message may speak for, or `None` if it may not speak for
    /// one.
    ///
    /// Two questions, one answer, because a message that fails either one has no
    /// authority to act on:
    ///
    /// **Identity.** Agent identity is established by connection registration,
    /// and that registration — not the `agent_id` a payload happens to carry —
    /// is the authority for everything the connection says afterwards (#960).
    /// Agent control connections are long-lived and carry the agent's whole
    /// state: heartbeats, session updates, advertised addresses. Reading the id
    /// out of each payload would mean a connection registered as `A` could move
    /// `B`'s state, by bug or by intent, for as long as the id in the payload
    /// said so. A payload that *does* name an agent is checked against the bound
    /// identity, because the two disagreeing means one of them is wrong. A
    /// message that omits the id is not refused: it claims nothing, and the
    /// connection supplies the answer. A connection that never registered has no
    /// authority at all — there is no bound identity to fall back on.
    ///
    /// **Generation.** Identity alone is not enough, because a connection that
    /// registered as `A` is not always still `A`'s. A reconnect registers again
    /// on a brand-new WebSocket and takes the agent over; the old socket, half
    /// closed or not yet reaped, can still deliver what it read — and those
    /// late frames are reports about an agent instance that no longer exists.
    /// Writing them would resurrect the sessions the new registration just
    /// cleared. So the connection must additionally still be the agent's
    /// **current generation**, which the broker records where it records
    /// ownership (`CommandBroker::is_current_generation`): one lifecycle, read
    /// for routing and for state writes both, instead of the two notions of
    /// authority this used to have.
    ///
    /// The refusal is message-level, not connection-level: a wrong id, or a
    /// superseded generation, is a fault in one message, and tearing down a
    /// working control connection over it would hand any peer a way to
    /// disconnect an agent by sending it garbage.
    ///
    /// Not for `server.agent.command-response`, which is deliberately
    /// identity-only: it answers a request the Server itself sent, and a
    /// response from a connection that has since been superseded is still the
    /// answer to that request (see `handle_agent_command_response`, #743).
    async fn authorized_agent_id(&self, payload: &Value, wire: &str) -> Option<String> {
        let Some(bound) = self.registered_agent_id.as_deref() else {
            warn!("{wire} from a connection that has not registered an agent");
            return None;
        };
        if let Some(claimed) = payload.get("agent_id").and_then(Value::as_str) {
            if claimed != bound {
                warn!(
                    "{wire} names agent '{claimed}' but this connection is registered as \
                     '{bound}'; refusing"
                );
                return None;
            }
        }
        if !self
            .command_broker
            .is_current_generation(bound, self.connection_generation)
            .await
        {
            warn!(
                "{wire} from {} for agent '{bound}', which a newer connection has taken \
                 over; refusing",
                self.connection_generation
            );
            return None;
        }
        Some(bound.to_string())
    }

    /// Set the outgoing message sender for this client connection.
    /// Must be called before processing messages that may need to broadcast.
    pub fn set_client_sender(&mut self, sender: WsMessageSender) {
        self.client_sender = Some(sender);
    }

    /// Session this client is attached to via relay (for cleanup on disconnect).
    pub fn attached_session_id(&self) -> Option<&str> {
        self.attached_session_id.as_deref()
    }

    /// Unique client id for this relay attachment (for cleanup on disconnect).
    pub fn attached_client_id(&self) -> Option<&str> {
        self.attached_client_id.as_deref()
    }

    /// One frame, decoded here, as the frame-level entry point.
    ///
    /// The connection's read loop splits the two halves itself: it decodes the
    /// envelope first, because that is where the unit's execution policy is read
    /// from (`server::execution`), and calls [`Self::handle_protocol_message`]
    /// with the result. This method is what is left for the frames the loop does
    /// not classify — a close, a ping, a binary frame — and for the handler
    /// tests, which are about one frame answered.
    pub async fn handle_message(&mut self, msg: Message) -> anyhow::Result<HandlerAction> {
        match msg {
            Message::Text(text) => {
                let protocol_msg: ProtocolMessage<serde_json::Value> = serde_json::from_str(&text)?;
                self.handle_protocol_message(protocol_msg).await
            }
            Message::Close(_) => {
                info!("Client disconnected");
                Ok(HandlerAction::Close)
            }
            _ => Ok(HandlerAction::Reply(None)),
        }
    }

    /// One decoded protocol message, dispatched.
    ///
    /// Visible to the read loop (`server::websocket`), which decodes once so
    /// that the frame's meaning — including which lane it is dispatched on — is
    /// read from the envelope it already has.
    pub(crate) async fn handle_protocol_message(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Log all agent-originated messages at info for diagnostics
        if msg.msg_type.starts_with("agent.") {
            info!(
                "Received agent message: type={}, id={}",
                msg.msg_type, msg.id
            );
        }
        // One list, not two: `SERVER_WIRES` and `dispatch_server` come from the
        // same `server_routes!` invocation below, so a unit cannot be
        // advertised in the Server's manifest without a handler, or handled
        // without being advertised. The Server is a provider like any other —
        // it serves `agent.register`, `session.attach`, `env.*` and the rest —
        // and before this it was the one peer whose offer was invisible.
        if SERVER_WIRES.contains(&msg.msg_type.as_str()) {
            return dispatch_server(self, msg).await;
        }

        // Control wires, handled beside the route table rather than in it, and
        // **before the relay path below**. Two reasons, and the second is a
        // bug rather than a matter of taste:
        //
        //   * `server_routes!` emits a descriptor per arm, and a control wire
        //     is not a unit. Nothing offers one — it is not an offer this peer
        //     makes to a caller, it is a message every peer must handle.
        //   * The relay path keys on the payload's `agent_id`, which every
        //     control payload carries because it is sent *about* an agent.
        //     Left to fall through, `control.heartbeat` would be relayed to the
        //     agent that sent it.
        //
        // All three arms are here, including the two the server has no sender
        // for: control is symmetric, so every runtime handles every control
        // wire, and `scripts/protocol-gate.mjs` holds each runtime to that.
        //
        // The wire type is taken out of the message before the match, for the
        // same reason `server_routes!` does it: the heartbeat arm moves `msg`,
        // and a borrow held in the scrutinee would conflict with that.
        let wire = msg.msg_type.clone();
        match wire.as_str() {
            "control.heartbeat" => return self.handle_control_heartbeat(msg).await,
            "control.ping" => {
                // The server has no keepalive that pings a peer; the arm is the
                // symmetry above. A peer that pings anyway is not refused — and
                // is not answered either, because control has no reply
                // mechanism and the server has nothing to state back.
                debug!(
                    "control.ping from a client; the server pings nothing, so it \
                     answers nothing"
                );
                return Ok(HandlerAction::Reply(None));
            }
            "control.pong" => {
                debug!("control.pong received; nothing awaits it");
                return Ok(HandlerAction::Reply(None));
            }
            _ => {}
        }

        // Not one of ours, so it is either a relay or nothing. The Server's
        // entire knowledge of an agent's own protocols — including the ones a
        // plugin provides — is the manifest that agent registered, and this is
        // where it is consulted.
        //
        // It used to be a name test: `starts_with("extension.")`. That carried
        // a category the Server has no business holding. Whether a protocol is
        // a plugin is an agent-side fact; the Server's only legitimate question
        // is "does this target say it can carry this wire?", which is what the
        // manifest answers. The prefix also could not survive `#565`: a
        // standalone capability host has nothing to be an "extension" *of*.
        //
        // Addressed to an agent, so it is a relay — and the relay decides. The
        // gate is "does it name a target", not "does the target support it",
        // deliberately: an agent that registered **no** manifest has to reach
        // `handle_relayed_message` to get the refusal that names the fix
        // ("it predates manifests — upgrade it"). Gating on the manifest here
        // would drop that agent into the no-op below and say nothing.
        if msg
            .payload
            .get("agent_id")
            .and_then(|v| v.as_str())
            .is_some_and(|id| !id.is_empty())
        {
            return self.handle_relayed_message(msg).await;
        }

        // Not a declared unit. Nothing is served here — `server.session.relay.end`
        // reaches this only as a duplicate after the relay function
        // (`relay_bidirectional_via_channel`) has already handled it during
        // active relay, and is a safe no-op.
        warn!("Unknown message type: {}", msg.msg_type);
        Ok(HandlerAction::Reply(None))
    }




    /// Push the current session list to every connected web client.
    ///
    /// Called after any mutation so browsers don't have to poll or wait for a
    /// manual refresh to notice changes.
    async fn broadcast_sessions(&self) {
        self.web_client_registry
            .broadcast_sessions_changed(Arc::clone(&self.session_registry))
            .await;
    }







    /// Query online agents for their live tmux sessions and rebuild the
    /// registry from the answers. Scoped to `only_agent` when given.
    ///
    /// Returns the IDs of agents that did not answer. Their registry entries
    /// are deliberately left alone: a transient timeout must not delete
    /// sessions that are still alive in tmux, so the client is told the data
    /// may be stale instead.
    async fn refresh_sessions_from_agents(&self, only_agent: Option<&str>) -> Vec<String> {
        let targets: Vec<String> = self
            .agent_registry
            .list()
            .await
            .into_iter()
            // Offline agents have no live control connection — `send_command`
            // would drop the sender immediately, so skip rather than wait.
            .filter(|a| a.status == AgentStatus::Online)
            .filter(|a| only_agent.is_none_or(|want| a.agent_id == want))
            .map(|a| a.agent_id)
            .collect();

        if targets.is_empty() {
            return Vec::new();
        }

        // Fan out concurrently: this runs while a user waits on a button
        // click, so the cost must be one timeout, not N.
        let results = futures_util::future::join_all(targets.iter().map(|agent_id| async move {
            let outcome = self
                .agent_command_with_timeout(
                    agent_id,
                    "agent.session.report",
                    json!({}),
                    SESSION_REFRESH_TIMEOUT,
                )
                .await;
            (agent_id.clone(), outcome)
        }))
        .await;

        let mut stale = Vec::new();
        for (agent_id, outcome) in results {
            match outcome {
                Ok(resp) => {
                    let incoming = parse_agent_sessions(&agent_id, &resp);
                    let removed = self
                        .session_registry
                        .replace_agent_sessions(&agent_id, incoming)
                        .await;
                    // Sessions that vanished must release their env locks so
                    // the files become editable again.
                    for session_id in &removed {
                        self.env_service.usage.clear_session(session_id);
                    }
                }
                Err(e) => {
                    warn!(
                        "sessions.list refresh from agent {} failed: {}",
                        agent_id, e
                    );
                    stale.push(agent_id);
                }
            }
        }

        stale
    }











    // ========================================================================
    // Environment-variable file management
    // ========================================================================

    /// Send a command to an agent and await its response (10s timeout).
    /// Returns the response payload, or an error string on timeout/disconnect.
    async fn agent_command(
        &self,
        agent_id: &str,
        msg_type: &str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        // not-protocol: this is the pass-through. Every caller of it names a
        // wire literal, and those are the sites the gate reads.
        self.agent_command_with_timeout(agent_id, msg_type, payload, Duration::from_secs(10))
            .await
    }

    /// Same as [`Self::agent_command`] but with a caller-chosen timeout.
    /// Interactive paths (a user waiting on a click) want a much shorter
    /// deadline than background bookkeeping.
    /// Push a P2P credential to the agent that will verify it (#1013).
    ///
    /// Waits for the acknowledgement, because the caller is about to hand the
    /// token to a client that will dial immediately. The deadline is short on
    /// purpose: a client's attach is blocked on this, and a wedged agent should
    /// fail one in two seconds rather than hold a browser for ten.
    async fn grant_p2p_credential(
        &self,
        agent_id: &str,
        grant: &P2pGrantPayload,
    ) -> Result<(), String> {
        let payload = serde_json::to_value(grant).map_err(|e| e.to_string())?;
        let response = self
            .agent_command_with_timeout(
                agent_id,
                "agent.p2p.grant",
                payload,
                Duration::from_secs(2),
            )
            .await?;

        if response.get("success").and_then(serde_json::Value::as_bool) == Some(true) {
            return Ok(());
        }

        Err(response
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the agent gave no reason")
            .to_string())
    }

    async fn agent_command_with_timeout(
        &self,
        agent_id: &str,
        msg_type: &str,
        mut payload: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        info!(
            "agent_command_with_timeout: sending {} to agent {} (req: {})",
            msg_type, agent_id, request_id
        );

        if let Some(obj) = payload.as_object_mut() {
            obj.insert("request_id".to_string(), json!(request_id));
        }
        let rx = self
            .command_broker
            .send_command(agent_id, msg_type, &request_id, payload)
            .await;
        info!(
            "agent_command_with_timeout: waiting for response from agent {} (req: {})",
            agent_id, request_id
        );
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => {
                info!(
                    "agent_command_with_timeout: got response from agent {} (req: {})",
                    agent_id, request_id
                );
                Ok(response)
            }
            Ok(Err(e)) => {
                warn!("agent_command_with_timeout: oneshot receiver error for agent {} (req: {}): {:?}", agent_id, request_id, e);
                Err("Agent disconnected".to_string())
            }
            Err(_) => {
                warn!(
                    "agent_command_with_timeout: timeout waiting for agent {} (req: {})",
                    agent_id, request_id
                );
                Err("Timeout waiting for agent response".to_string())
            }
        }
    }





    /// Resolve a set of env-file references into snapshots, capturing content at
    /// this moment (snapshot semantics). Server files are read locally; agent
    /// files are fetched from the owning agent. Missing files produce an error.
    async fn resolve_snapshots(
        &self,
        agent_id: &str,
        refs: &[EnvFileRef],
    ) -> Result<Vec<EnvSnapshot>, String> {
        let mut snapshots = Vec::new();
        for r in refs {
            let content = match r.source {
                EnvSource::Server => self.env_service.store.read(&r.name).await.map_err(|_| {
                    format!("Env file not found. It may have been deleted: {}", r.name)
                })?,
                EnvSource::Agent => {
                    // Agent files are read from the file's owning agent (which is
                    // normally the same agent hosting the session).
                    let owner = r.agent_id.as_deref().unwrap_or(agent_id);
                    let resp = self
                        .agent_command(owner, "agent.env.get", json!({ "name": r.name }))
                        .await?;
                    if resp.get("success").and_then(serde_json::Value::as_bool) != Some(true) {
                        return Err(format!(
                            "Env file not found. It may have been deleted: {}",
                            r.name
                        ));
                    }
                    resp.get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                }
            };
            let parsed = parse_env(&content);
            snapshots.push(EnvSnapshot {
                name: r.name.clone(),
                source: r.source,
                agent_id: r.agent_id.clone(),
                vars: parsed.vars,
                warnings: parsed.warnings,
            });
        }
        Ok(snapshots)
    }

    /// Source env-file refs into a running session, on the agent that owns it.
    ///
    /// The one path for "put this env into that running session": resolve the
    /// refs into snapshots (content captured now), then ask the owning agent to
    /// source them. Both the `server.session.env.apply` handler and the
    /// re-source that follows a forced write go through here, so the two cannot
    /// drift into separate behaviours.
    ///
    /// Returns the resolution's non-fatal warnings on success. Usage recording
    /// is left to the caller: a forced write re-sources a file the session
    /// *already* has, which is not a new attachment.
    async fn source_env_into_session(
        &self,
        session_id: &str,
        refs: &[EnvFileRef],
    ) -> Result<Vec<String>, String> {
        let Some((agent_id, session_name)) = session_id.split_once(':') else {
            return Err("Invalid session_id".to_string());
        };
        let snapshots = self.resolve_snapshots(agent_id, refs).await?;
        let warnings: Vec<String> = snapshots.iter().flat_map(|s| s.warnings.clone()).collect();

        match self
            .agent_command(
                agent_id,
                "agent.session.env.apply",
                json!({ "name": session_name, "snapshots": snapshots }),
            )
            .await
        {
            Ok(r) if r.get("success").and_then(serde_json::Value::as_bool) == Some(true) => {
                Ok(warnings)
            }
            Ok(r) => Err(r
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("the agent could not source the env")
                .to_string()),
            Err(e) => Err(e),
        }
    }





    // ── Quick Commands (issue #95, part 3) ───────────────────────────




}

/// Build a `HandlerAction::Reply` with a standard protocol envelope.
/// Extract an IP address from a WebSocket URL like `ws://192.168.1.5:8080/ws`.
/// Returns `None` if the URL has no recognizable host portion (e.g. hostname-based).
fn extract_ip_from_url(url: &str) -> Option<String> {
    // Strip scheme: ws://host:port/path → host:port/path
    let after_scheme = url.split("://").nth(1)?;
    // Strip path: host:port/path → host:port
    let host_port = after_scheme.split('/').next()?;
    // Strip IPv6 brackets: [::1]:port → ::1:port → ::1
    if host_port.starts_with('[') {
        return host_port
            .split(']')
            .next()?
            .strip_prefix('[')
            .map(String::from);
    }
    // Strip port: host:port → host
    host_port.split(':').next().map(String::from)
}

#[cfg(test)]
mod extract_ip_tests {
    use super::*;

    #[test]
    fn extract_ipv4() {
        assert_eq!(
            extract_ip_from_url("ws://192.168.1.5:8080/ws"),
            Some("192.168.1.5".into())
        );
    }

    #[test]
    fn extract_ipv6() {
        assert_eq!(
            extract_ip_from_url("ws://[fd00::1]:8080/ws"),
            Some("fd00::1".into())
        );
    }

    #[test]
    fn extract_hostname_returns_hostname() {
        assert_eq!(
            extract_ip_from_url("wss://agent.example.com/ws"),
            Some("agent.example.com".into())
        );
    }

    #[test]
    fn extract_no_scheme_returns_none() {
        assert_eq!(extract_ip_from_url("not-a-url"), None);
    }

    #[test]
    fn extract_tunnel_url() {
        assert_eq!(
            extract_ip_from_url("wss://tunnel.example.com/ws"),
            Some("tunnel.example.com".into())
        );
    }
}

/// Serialize a `server.env.list` reply.
///
/// `to_value` cannot fail for a struct of these shapes, but the house pattern
/// keeps a fallback rather than an unwrap — and an empty list is still a valid
/// payload, so a caller reads "no files" instead of losing the reply.
/// Serialize a `server.auth` reply.
///
/// The same payload type the Agent's `client.auth` answers with — one handshake
/// at two ends, so one type. This call is the one that has no client id to put
/// in it, which is why the field is optional rather than required.
fn auth_reply(id: &str, payload: AuthResponsePayload) -> HandlerAction {
    reply_json(
        id,
        "server.auth",
        serde_json::to_value(&payload)
            .unwrap_or(json!({ "status": "failed", "message": "serialization failed" })),
    )
}

/// Serialize a `server.session.relay.begin` refusal.
///
/// A refusal and nothing else, because the success path never reaches here: it
/// returns `HandlerAction::Relay` and starts forwarding without answering.
fn relay_begin_reply(id: &str, refusal: SessionRefusal) -> HandlerAction {
    reply_json(
        id,
        "server.session.relay.begin",
        serde_json::to_value(&refusal)
            .unwrap_or(json!({ "status": "error", "message": "serialization failed" })),
    )
}

/// Serialize a `server.agent.rename` reply.
fn agent_rename_reply(id: &str, reply: AgentRenameReply) -> HandlerAction {
    reply_json(
        id,
        "server.agent.rename",
        serde_json::to_value(&reply).unwrap_or(json!({ "success": false })),
    )
}

/// Serialize a `server.agent.list` reply.
fn agent_list_reply(id: &str, reply: AgentListReply) -> HandlerAction {
    reply_json(
        id,
        "server.agent.list",
        serde_json::to_value(&reply).unwrap_or(json!({ "agents": [] })),
    )
}

/// Serialize a `server.session.env.query` reply.
fn session_env_query_reply(id: &str, payload: SessionEnvQueryResponse) -> HandlerAction {
    reply_json(
        id,
        "server.session.env.query",
        serde_json::to_value(&payload).unwrap_or(json!({ "sourced_files": [] })),
    )
}

/// Serialize a `server.session.env.active` reply.
fn session_env_active_reply(id: &str, payload: SessionEnvActiveResponse) -> HandlerAction {
    reply_json(
        id,
        "server.session.env.active",
        serde_json::to_value(&payload).unwrap_or(json!({ "active": [] })),
    )
}

/// Serialize a session env reply — `apply` and `unset` share one response type
/// and differ only in the wire, so the caller names it.
fn session_env_reply(
    id: &str,
    msg_type: &str,
    payload: ClientSessionEnvResponsePayload,
) -> HandlerAction {
    reply_json(
        id,
        msg_type,
        serde_json::to_value(&payload).unwrap_or(json!({ "success": false })),
    )
}

/// Serialize a `server.session.create` reply. Same fallback reasoning as
/// [`env_list_reply`].
fn session_create_reply(id: &str, payload: ClientSessionCreateResponsePayload) -> HandlerAction {
    reply_json(
        id,
        "server.session.create",
        serde_json::to_value(&payload).unwrap_or(json!({ "success": false })),
    )
}

/// Serialize a `server.session.kill` reply. Same fallback reasoning as
/// [`env_list_reply`].
fn session_kill_reply(id: &str, payload: WebSessionKillResponse) -> HandlerAction {
    reply_json(
        id,
        "server.session.kill",
        serde_json::to_value(&payload).unwrap_or(json!({ "success": false })),
    )
}

/// Serialize a `server.session.list` reply.
///
/// The first unit to use a union: its two branches share no field, so a
/// discriminated shape would have to invent a tag the wire does not carry.
fn session_list_reply(id: &str, reply: ServerSessionListReply) -> HandlerAction {
    reply_json(
        id,
        "server.session.list",
        serde_json::to_value(&reply).unwrap_or(json!({ "sessions": [] })),
    )
}

/// Serialize a `server.env.write` reply. Same fallback reasoning as
/// [`env_list_reply`].
fn env_write_reply(id: &str, payload: ClientEnvWriteResponsePayload) -> HandlerAction {
    reply_json(
        id,
        "server.env.write",
        serde_json::to_value(&payload).unwrap_or(json!({ "success": false })),
    )
}

/// Serialize a `server.env.delete` reply. Same fallback reasoning as
/// [`env_list_reply`].
fn env_del_reply(id: &str, payload: ClientEnvDeleteResponsePayload) -> HandlerAction {
    reply_json(
        id,
        "server.env.delete",
        serde_json::to_value(&payload).unwrap_or(json!({ "success": false })),
    )
}

/// Serialize a `server.env.get` reply. Same fallback reasoning as
/// [`env_list_reply`].
fn env_get_reply(id: &str, payload: ClientEnvGetResponsePayload) -> HandlerAction {
    reply_json(
        id,
        "server.env.get",
        serde_json::to_value(&payload).unwrap_or(json!({ "success": false })),
    )
}

fn env_list_reply(id: &str, payload: ClientEnvListResponsePayload) -> HandlerAction {
    reply_json(
        id,
        "server.env.list",
        serde_json::to_value(&payload).unwrap_or(json!({ "files": [] })),
    )
}

fn reply_json(id: &str, msg_type: &str, payload: serde_json::Value) -> HandlerAction {
    HandlerAction::Reply(Some(Message::Text(
        json!({
            "msg_type": msg_type,
            "id": id,
            "timestamp": current_timestamp(),
            "payload": payload,
        })
        .to_string(),
    )))
}

fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Serialise a session for the wire. Shared by `server.session.list` and the
/// `server.sessions.changed` broadcast so both always agree on the field set — the
/// web client feeds either straight into the same state setter.
pub(crate) fn session_to_info(s: &crate::registry::SessionInfo) -> WebSessionInfo {
    WebSessionInfo {
        session_id: s.session_id.clone(),
        agent_id: s.agent_id.clone(),
        session_name: s.session_name.clone(),
        status: match s.status {
            SessionStatus::Active => "active",
            SessionStatus::Detached => "detached",
            SessionStatus::Recovering => "recovering",
            SessionStatus::Orphaned => "orphaned",
            SessionStatus::Zombie => "zombie",
        }
        .to_string(),
        window_count: s.window_count,
        attached_clients: s.attached_clients,
        foreground_command: s.foreground_command.clone(),
        working_dir: s.working_dir.clone(),
        last_activity: s.last_activity.to_rfc3339(),
    }
}

pub(crate) fn session_to_json(s: &crate::registry::SessionInfo) -> serde_json::Value {
    serde_json::to_value(session_to_info(s)).unwrap_or(json!({}))
}

/// Convert an agent's `sessions.list` reply into registry entries.
///
/// The agent reports raw tmux fields only; status is derived here from
/// `attached_clients` using the same rule as the agent's SessionWatcher, so
/// the mapping lives in exactly one place. Malformed or unnamed entries are
/// skipped rather than failing the whole refresh.
fn parse_agent_sessions(
    agent_id: &str,
    resp: &serde_json::Value,
) -> Vec<crate::registry::SessionInfo> {
    let now = chrono::Utc::now();
    resp.get("sessions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let name = s.get("name").and_then(|v| v.as_str())?;
                    if name.is_empty() {
                        return None;
                    }
                    let attached_clients = u32::try_from(
                        s.get("attached_clients")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                    )
                    .unwrap_or(0);
                    let window_count = u32::try_from(
                        s.get("window_count")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                    )
                    .unwrap_or(0);
                    let created_at = s
                        .get("created_at")
                        .and_then(serde_json::Value::as_i64)
                        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
                        .unwrap_or(now);
                    let foreground_command = s
                        .get("foreground_command")
                        .and_then(serde_json::Value::as_str)
                        .filter(|command| !command.is_empty())
                        .map(std::string::ToString::to_string);
                    Some(crate::registry::SessionInfo {
                        session_id: format!("{agent_id}:{name}"),
                        agent_id: agent_id.to_string(),
                        session_name: name.to_string(),
                        status: if attached_clients > 0 {
                            SessionStatus::Active
                        } else {
                            SessionStatus::Detached
                        },
                        window_count,
                        attached_clients,
                        foreground_command,
                        working_dir: s
                            .get("working_dir")
                            .and_then(serde_json::Value::as_str)
                            .filter(|p| !p.is_empty())
                            .map(std::string::ToString::to_string),
                        created_at,
                        last_activity: now,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) use routes::{server_descriptors, unit_policy, SERVER_WIRES};
#[cfg(test)]
use routes::{env_file_key, session_by_id, session_by_parts};

mod control;
mod relay;
mod routes;
mod server_agent_address_update_v1;
mod server_agent_command_response_v1;
mod server_agent_delete_v1;
mod server_agent_git_invalidated_v1;
mod server_agent_list_v1;
mod server_agent_register_v1;
mod server_agent_rename_v1;
mod server_agent_session_update_v1;
mod server_agent_terminal_resize_v1;
mod server_auth_v1;
mod server_commands_add_v1;
mod server_commands_list_v1;
mod server_commands_remove_v1;
mod server_commands_update_v1;
mod server_env_delete_v1;
mod server_env_get_v1;
mod server_env_list_v1;
mod server_env_write_v1;
mod server_info_v1;
mod server_session_attach_v1;
mod server_session_capture_preview_v1;
mod server_session_create_v1;
mod server_session_env_active_v1;
mod server_session_env_apply_v1;
mod server_session_env_query_v1;
mod server_session_env_unset_v1;
mod server_session_kill_v1;
mod server_session_list_v1;
mod server_session_relay_begin_v1;
#[cfg(test)]
mod tests;
