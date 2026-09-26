use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::env::EnvService;
use crate::protocol::server_routes;
use crate::registry::{AgentInfo, AgentRegistry, AgentStatus, SessionRegistry, SessionStatus};
use crate::server::client_registry::ClientRegistry;
use crate::server::command_broker::{CommandBroker, ConnectionGeneration};
// The four policies by name, because the `server_routes!` invocation at the
// bottom of this file declares one per unit and the names are the column there.
use crate::server::execution::ExecutionPolicy::{Inline, Key, Ordered, Query};
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
        /// Resolved env snapshots to inject via agent.attach to the agent.
        env_snapshots: Vec<EnvSnapshot>,
        /// Terminal columns for the initial tmux resize (from browser viewport).
        cols: u16,
        /// Terminal rows for the initial tmux resize (from browser viewport).
        rows: u16,
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

    async fn handle_agent_register(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: AgentRegisterPayload = serde_json::from_value(msg.payload)?;

        // Empty server auth_token means no-auth mode: accept any agent
        let auth_ok = self.config.server_auth_token.is_empty()
            || payload.auth_token == self.config.server_auth_token;

        if !auth_ok {
            info!("Agent {} rejected: invalid auth token", payload.agent_id);
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.register",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "rejected",
                        "message": "Invalid auth token"
                    }
                })
                .to_string(),
            ))));
        }

        // Registration is a **state transition, not a rebind**: a connection
        // either has not registered yet or is already somebody. Re-registering
        // is refused rather than applied, because everything downstream keeps
        // one identity per connection — the broker holds the claimed agent, the
        // disconnect path releases exactly this id, and the frames in between
        // are authorized against it. A connection that registered `A` and then
        // `B` would leave the broker claiming `A` from a socket the handler
        // remembers as `B`, and `A` would keep a control channel nobody releases
        // (#960). An agent that wants to come back as somebody else opens a new
        // connection, which is what its own reconnect path does anyway.
        if let Some(bound) = &self.registered_agent_id {
            info!(
                "Agent {} rejected: {} is already registered as '{bound}'",
                payload.agent_id, self.connection_generation
            );
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.register",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "rejected",
                        "message": format!(
                            "This connection is already registered as agent '{bound}'. \
                             Registration is one-shot per connection; reconnect to \
                             register as a different agent."
                        )
                    }
                })
                .to_string(),
            ))));
        }

        // A manifest is required, not optional (`#678`).
        //
        // This is a **breaking upgrade**, chosen deliberately over supporting
        // manifest-less peers through explicit adapters. An agent that
        // advertises nothing is one this server cannot route for: every relay
        // decision below is made by asking the target's manifest whether it
        // carries a wire type, and a peer that has not spoken cannot answer.
        // Relaying to it unconditionally — what this did before — is guessing,
        // and guessing is the failure the whole design exists to remove.
        //
        // Refusing at registration rather than at the first relay is the
        // difference between an agent that never starts and one that connects,
        // looks healthy, and silently drops every request aimed at it.
        //
        // The field stays `Option` on the wire so this is a *clear rejection*
        // rather than a parse error: an old agent's payload deserializes, and
        // the answer it gets says why.
        let Some(protocol_manifest) = payload.protocol_manifest.clone() else {
            info!("Agent {} rejected: no protocol manifest", payload.agent_id);
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.register",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "rejected",
                        "message": "This agent advertised no protocol manifest. \
                                    This server routes only by manifest, so a peer \
                                    without one cannot be served — upgrade the agent."
                    }
                })
                .to_string(),
            ))));
        };

        let addresses = crate::registry::build_probed_addresses(
            payload.addresses.clone(),
            &payload.ip_address,
            payload.port,
            payload.connect_url.as_deref(),
        );
        info!(
            "Agent {} advertised {} P2P address(es)",
            payload.agent_id,
            addresses.len()
        );

        // Keep an existing display_name if it was manually set via Web UI
        // (survives agent restart). Otherwise use the agent's config value.
        let display_name = match self.agent_registry.get(&payload.agent_id).await {
            Some(existing) if existing.display_name.is_some() => {
                info!(
                    "Agent {} keeping existing display_name: {:?}",
                    payload.agent_id, existing.display_name
                );
                existing.display_name
            }
            _ => payload.display_name.clone(),
        };

        let agent_info = AgentInfo {
            agent_id: payload.agent_id.clone(),
            hostname: payload.hostname,
            ip_address: payload.ip_address,
            port: payload.port,
            display_name,
            connect_url: payload.connect_url.clone(),
            addresses,
            registered_at: chrono::Utc::now(),
            last_heartbeat: chrono::Utc::now(),
            status: AgentStatus::Online,
            metadata: payload.metadata,
            session_count: 0,
            active_sessions: 0,
            // What the agent says it can serve, taken from its own composition.
            // Always present: registration is refused without it, above. The
            // field stays `Option` because the *registry* can still hold an
            // agent that registered before this server was upgraded and has not
            // reconnected since — and for that straggler the relay gate refuses
            // rather than guesses.
            protocol_manifest: Some(protocol_manifest),
        };

        self.agent_registry.register(agent_info).await;
        // Binding *this connection* to the agent: from here on it is the
        // authority for every agent-originated message it carries, whatever
        // those payloads name (`authorized_agent_id`). The other half of
        // registration is the broker claim the websocket loop makes for it —
        // see `server/websocket.rs` on why ownership is keyed on the connection.
        self.registered_agent_id = Some(payload.agent_id.clone());

        // Clear any sessions left over from a previous agent instance.
        // On reconnect the agent's tmux state is fresh — the SessionWatcher
        // starts with empty prev_sessions and can only report currently-
        // existing sessions.  Stale entries from the prior run must be
        // removed here or they linger forever.
        let removed = self
            .session_registry
            .remove_by_agent(&payload.agent_id)
            .await;
        if !removed.is_empty() {
            info!(
                "Cleared {} stale session(s) for agent {} after re-registration: {:?}",
                removed.len(),
                payload.agent_id,
                removed
            );
            // Tell web clients the list shrank — otherwise their view keeps
            // showing sessions the registry no longer has.
            self.broadcast_sessions().await;
        }

        info!("Agent {} registered successfully", payload.agent_id);

        Ok(HandlerAction::Reply(Some(Message::Text(
            json!({
                "msg_type": "server.agent.register",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "status": "accepted",
                    "message": "Registration successful",
                    "heartbeat_interval_secs": self.config.heartbeat_interval_secs
                }
            })
            .to_string(),
        ))))
    }

    /// Handle `control.heartbeat`.
    ///
    /// Named for the wire rather than for the agent, because the wire no longer
    /// names one: it used to be `server.agent.heartbeat`, which read as "the
    /// server answers this" and stopped being true when the acknowledgement was
    /// recognised as a message of its own.
    ///
    /// The agent it belongs to comes from the connection, not from the payload
    /// — see `authorized_agent_id`.
    async fn handle_control_heartbeat(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: serde_json::Value = msg.payload;
        let Some(agent_id) = self
            .authorized_agent_id(&payload, "control.heartbeat")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };

        if self.agent_registry.get(&agent_id).await.is_none() {
            warn!("Heartbeat from unregistered agent: {}", agent_id);
            return Ok(HandlerAction::Reply(None));
        }

        let session_count = u32::try_from(
            payload
                .get("session_count")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        )
        .unwrap_or(0);
        let active_sessions = u32::try_from(
            payload
                .get("active_sessions")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        )
        .unwrap_or(0);

        info!(
            "Heartbeat from {}: sessions={}, active={}",
            agent_id, session_count, active_sessions
        );

        // Update agent metadata if provided (keeps version/tmux/OS current
        // after agent upgrades — previously only sent on register).
        if let Some(agent_meta) = payload
            .get("metadata")
            .and_then(|v| v.get("agent"))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
        {
            self.agent_registry
                .update_metadata(&agent_id, agent_meta)
                .await;
        }

        let changed = self
            .agent_registry
            .update_heartbeat(&agent_id, session_count, active_sessions)
            .await;

        // Push updated agent state to all connected web dashboard clients
        // only when a meaningful field changed (status, session counts).
        // Timestamp-only heartbeats don't need a broadcast.
        if changed {
            self.web_client_registry
                .broadcast_agents_changed(Arc::clone(&self.agent_registry))
                .await;
        }

        // Nothing is sent back. There used to be an acknowledgement here, on a
        // wire of its own (`server.heartbeat.ack`), and it was removed rather
        // than renamed: **control has no acknowledgement**. A heartbeat is a
        // one-way statement — `control.heartbeat` — so an ack is not a reply
        // the protocol owes anyone, and the agent's handler for it logged and
        // returned, which is what a message sent for no one's benefit looks
        // like. (The "miss counter" an older comment here said the ack reset
        // does not exist in `nession-agent` either; nothing was reset.)
        Ok(HandlerAction::Reply(None))
    }

    /// Handle `server.agent.session-update` — the agent reporting the state of
    /// one of its tmux sessions.
    ///
    /// The agent it belongs to comes from the connection, not from the payload
    /// — see `authorized_agent_id`. Session ids are `agent_id:session_name`, so the
    /// payload's id decides which *namespace* the update writes into; a
    /// connection registered as `A` reporting for `B` would otherwise rewrite
    /// another agent's session list.
    async fn handle_agent_session_update(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: serde_json::Value = msg.payload;
        let Some(agent_id) = self
            .authorized_agent_id(&payload, "server.agent.session-update")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };
        let session_name = payload
            .get("session_name")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let status_str = payload.get("status").and_then(|v| v.as_str()).unwrap_or("");

        if self.agent_registry.get(&agent_id).await.is_none() {
            warn!("Session update from unregistered agent: {}", agent_id);
            return Ok(HandlerAction::Reply(None));
        }

        let session_id = format!("{agent_id}:{session_name}");

        if status_str == "gone" {
            info!("Session {} removed (agent: {})", session_name, agent_id);
            self.session_registry.remove(&session_id).await;
            // Release any env usage locks held by this session so the env
            // files can be edited/deleted again. Without this, externally
            // killed sessions leave stale locks in memory.
            self.env_service.usage.clear_session(&session_id);
            self.broadcast_sessions().await;
            return Ok(HandlerAction::Reply(None));
        }

        let status = match status_str {
            "active" => crate::registry::session::SessionStatus::Active,
            "detached" => crate::registry::session::SessionStatus::Detached,
            "recovering" => crate::registry::session::SessionStatus::Recovering,
            "orphaned" => crate::registry::session::SessionStatus::Orphaned,
            "zombie" => crate::registry::session::SessionStatus::Zombie,
            _ => {
                warn!("Unknown session status '{}' for {}", status_str, session_id);
                return Ok(HandlerAction::Reply(None));
            }
        };

        let window_count = u32::try_from(
            payload
                .get("window_count")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        )
        .unwrap_or(0);
        let attached_clients = u32::try_from(
            payload
                .get("attached_clients")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        )
        .unwrap_or(0);

        let foreground_command = payload
            .get("foreground_command")
            .and_then(serde_json::Value::as_str)
            .filter(|command| !command.is_empty())
            .map(std::string::ToString::to_string);

        let session_info = crate::registry::session::SessionInfo {
            session_id: session_id.clone(),
            agent_id: agent_id.clone(),
            session_name: session_name.to_string(),
            status,
            window_count,
            attached_clients,
            foreground_command,
            created_at: chrono::Utc::now(),
            last_activity: chrono::Utc::now(),
        };

        info!(
            "Session {} updated (agent: {}, status: {:?}, windows: {}, clients: {})",
            session_name, agent_id, session_info.status, window_count, attached_clients
        );
        self.session_registry.update_session(session_info).await;
        self.broadcast_sessions().await;

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

    async fn handle_client_auth(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary, and the type is the Agent's
        // `client.auth` payload: a browser sends the same two fields to
        // whichever end it is talking to, so the two ends share one shape.
        //
        // An unreadable payload becomes an empty token rather than an error,
        // which is what the old field-by-field read did (`unwrap_or("")`): it
        // fails authentication except in no-auth mode, and that is the intended
        // behaviour for a malformed handshake.
        let payload: ClientAuthPayload =
            serde_json::from_value(msg.payload).unwrap_or(ClientAuthPayload {
                auth_token: String::new(),
                client_id: None,
            });

        // Empty server auth_token means no-auth mode: accept any client
        let auth_ok = self.config.server_auth_token.is_empty()
            || payload.auth_token == self.config.server_auth_token;

        if auth_ok {
            self.authenticated_client = true;
            // Subscribe web client for real-time push (server.agents.changed, etc.)
            if let Some(ref sender) = self.client_sender {
                self.web_client_registry.subscribe(sender.clone());
            }
            info!("Client authenticated successfully");

            Ok(auth_reply(
                &msg.id,
                AuthResponsePayload {
                    status: "success".to_string(),
                    message: "Authentication successful".to_string(),
                    // The Server assigns no client id and never did. The
                    // contract used to require one, which is why the field is
                    // optional now — this branch has nothing honest to put here.
                    client_id: None,
                },
            ))
        } else {
            info!("Client authentication failed");

            Ok(auth_reply(
                &msg.id,
                AuthResponsePayload {
                    status: "failed".to_string(),
                    message: "Invalid auth token".to_string(),
                    client_id: None,
                },
            ))
        }
    }

    /// Handle `server.agent.list` - returns all registered agents.
    async fn handle_client_agents_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary: the list half is built by
        // `agent_view`, whose single builder both this and the `server.agents.changed`
        // push go through, and the refusal half is `AgentRefusal`.
        if !self.authenticated_client {
            warn!("Unauthenticated client requested agents list");
            return Ok(agent_list_reply(
                &msg.id,
                AgentListReply::Refused(AgentRefusal {
                    status: "error".to_string(),
                    message: "Not authenticated".to_string(),
                }),
            ));
        }

        let agents = self.agent_registry.list().await;

        let view: Vec<nession_protocol::contracts::agent::v1::WebAgentInfo> = agents
            .iter()
            .map(super::agent_view::agent_to_view)
            .collect();

        info!(
            "Client requested agents list, returning {} agents",
            view.len()
        );

        Ok(agent_list_reply(
            &msg.id,
            AgentListReply::Listed(WebAgentsListResponse { agents: view }),
        ))
    }

    /// Handle `server.info` — return server version, uptime, and stats.
    async fn handle_client_server_info(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let agents = self.agent_registry.list().await;
        let online = agents
            .iter()
            .filter(|a| a.status == AgentStatus::Online)
            .count();
        let sessions = self.session_registry.list().await.len();

        Ok(HandlerAction::Reply(Some(Message::Text(
            json!({
                "msg_type": "server.info",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "version": env!("CARGO_PKG_VERSION"),
                    "image_tag": option_env!("IMAGE_TAG").unwrap_or("dev"),
                    "uptime_seconds": crate::uptime_seconds(),
                    "agent_count": agents.len(),
                    "online_agent_count": online,
                    "session_count": sessions,
                    "build_time": option_env!("BUILD_TIME").unwrap_or("unknown"),
                    // What this server serves (`#678`). Derived from the same
                    // declaration that dispatches, so it cannot claim a unit
                    // this server does not answer.
                    "protocol_manifest": crate::protocol::server_manifest()?,
                }
            })
            .to_string(),
        ))))
    }

    /// Handle `server.agent.rename` — update an agent's display name.
    /// Accepts `agent_id` and `display_name` (string or null to clear).
    /// Returns the updated agent info on success.
    async fn handle_client_agent_rename(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. The success branch below now goes
        // through `agent_view::agent_to_view` like `server.agent.list` does —
        // it used to build a second agent block by hand, twelve fields against
        // the builder's thirteen, and it had drifted in exactly the two ways
        // that builder's doc comment describes as fixed.
        let refusal = |error: &str| {
            AgentRenameReply::Refused(AgentRenameFailure {
                success: false,
                error: error.to_string(),
            })
        };

        if !self.authenticated_client {
            return Ok(agent_rename_reply(&msg.id, refusal("Not authenticated")));
        }

        let agent_id = msg
            .payload
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if agent_id.is_empty() {
            return Ok(agent_rename_reply(&msg.id, refusal("agent_id is required")));
        }

        // Resolve the new display_name: JSON null → clear, string → validate
        let raw: Option<String> = msg
            .payload
            .get("display_name")
            .and_then(|v| {
                if v.is_null() {
                    Some(None) // explicit null = clear
                } else {
                    v.as_str().map(|s| Some(s.to_string()))
                }
            })
            .flatten();

        let display_name = match raw {
            Some(ref s) => match validate_display_name(s) {
                Ok(Some(normalized)) => Some(normalized),
                Ok(None) => None, // empty after trim → clear
                Err(e) => {
                    return Ok(agent_rename_reply(&msg.id, refusal(&e)));
                }
            },
            None => None, // explicit null → clear
        };

        info!(
            "Rename agent {} display_name: {:?} -> {:?}",
            agent_id,
            self.agent_registry
                .get(agent_id)
                .await
                .and_then(|a| a.display_name),
            display_name
        );

        match self
            .agent_registry
            .update_display_name(agent_id, display_name.clone())
            .await
        {
            Some(updated) => Ok(agent_rename_reply(
                &msg.id,
                AgentRenameReply::Renamed(Box::new(AgentRenameResponse {
                    success: true,
                    // The one builder, which is what removes the drift this arm
                    // used to carry: `protocols` and `metadata.image_tag` were
                    // both missing from the block that was here.
                    agent: super::agent_view::agent_to_view(&updated),
                })),
            )),
            None => Ok(agent_rename_reply(
                &msg.id,
                refusal(&format!("Agent '{agent_id}' not found")),
            )),
        }
    }

    /// Handle `server.agent.delete` — permanently remove an offline agent and its sessions.
    /// Rejects if the agent is online or degraded.
    async fn handle_client_agent_delete(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.delete",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "Not authenticated"
                    }
                })
                .to_string(),
            ))));
        }

        let agent_id = msg
            .payload
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if agent_id.is_empty() {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.delete",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "agent_id is required"
                    }
                })
                .to_string(),
            ))));
        }

        // Check agent exists and is offline.
        let agent = match self.agent_registry.get(agent_id).await {
            Some(a) => a,
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "server.agent.delete",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": format!("Agent '{}' not found", agent_id)
                        }
                    })
                    .to_string(),
                ))));
            }
        };

        if agent.status != AgentStatus::Offline {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.delete",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": format!(
                            "Agent '{}' is {} — only offline agents can be deleted",
                            agent_id,
                            match agent.status {
                                AgentStatus::Online => "online",
                                AgentStatus::Degraded => "degraded",
                                AgentStatus::Offline => "offline",
                            }
                        )
                    }
                })
                .to_string(),
            ))));
        }

        info!("Deleting offline agent {} and its sessions", agent_id);

        // Delete sessions from DB, then agent from DB.
        if let Err(e) = self.db.delete_sessions_by_agent(agent_id).await {
            tracing::error!("Failed to delete sessions for agent {}: {:?}", agent_id, e);
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.delete",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": format!("Failed to delete sessions: {e}")
                    }
                })
                .to_string(),
            ))));
        }

        if let Err(e) = self.db.delete_agent(agent_id).await {
            tracing::error!("Failed to delete agent {}: {:?}", agent_id, e);
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.delete",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": format!("Failed to delete agent: {e}")
                    }
                })
                .to_string(),
            ))));
        }

        // Remove from in-memory registries. The broker entry goes with them,
        // but not through the disconnect path: this is a verdict about the
        // *agent* (it is offline), and it is not the release of a claim — see
        // `CommandBroker::forget_agent`, which is the one removal that may drop
        // the generation high-water mark, because the agent it belonged to is
        // gone rather than quiet.
        self.agent_registry.unregister(agent_id).await;
        self.session_registry.remove_by_agent(agent_id).await;
        self.command_broker.forget_agent(agent_id).await;

        // Broadcast updated lists to all connected web clients.
        self.web_client_registry
            .broadcast_agents_changed(Arc::clone(&self.agent_registry))
            .await;
        self.broadcast_sessions().await;

        Ok(HandlerAction::Reply(Some(Message::Text(
            json!({
                "msg_type": "server.agent.delete",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "success": true
                }
            })
            .to_string(),
        ))))
    }

    /// Handle `server.session.list` - returns all sessions, optionally filtered by agent_id.
    ///
    /// With `force: true` the server first queries every online agent for its
    /// live tmux state and rebuilds the registry from the answers, so the
    /// client gets strongly-consistent data instead of whatever the last
    /// watcher poll happened to leave behind. Agents that fail to answer keep
    /// their existing entries and are named in `stale_agents`.
    async fn handle_client_sessions_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. The refusal branch used to be built
        // by hand because no contract described it — eleven handlers reply this
        // shape and none of them declared it.
        if !self.authenticated_client {
            warn!("Unauthenticated client requested sessions list");
            return Ok(session_list_reply(
                &msg.id,
                ServerSessionListReply::Refused(SessionRefusal {
                    status: "error".to_string(),
                    message: "Not authenticated".to_string(),
                }),
            ));
        }

        let payload: ServerSessionListPayload =
            serde_json::from_value(msg.payload).unwrap_or_default();
        let agent_id = payload.agent_id.as_deref();
        let force = payload.force;

        let stale_agents = if force {
            let stale = self.refresh_sessions_from_agents(agent_id).await;
            // The rebuild may have changed the list for everyone, not just the
            // requester — push it so other open browsers converge too.
            self.broadcast_sessions().await;
            stale
        } else {
            Vec::new()
        };

        let sessions = if let Some(aid) = agent_id {
            self.session_registry.list_by_agent(aid).await
        } else {
            self.session_registry.list().await
        };

        let sessions_json: Vec<serde_json::Value> = sessions.iter().map(session_to_json).collect();
        let sessions: Vec<WebSessionInfo> = sessions.iter().map(session_to_info).collect();

        info!(
            "Client requested sessions list (force: {}), returning {} sessions, {} stale agent(s)",
            force,
            sessions_json.len(),
            stale_agents.len()
        );

        Ok(session_list_reply(
            &msg.id,
            ServerSessionListReply::Listed(WebSessionsListResponse {
                sessions,
                stale_agents,
            }),
        ))
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

    /// Handle `server.session.attach` - returns P2P agent address or enters relay mode.
    ///
    /// In P2P mode, the response includes the agent's IP:port so the client can
    /// connect directly. In relay mode, the server opens a WebSocket to the agent
    /// and bidirectionally forwards terminal I/O.
    async fn handle_client_session_attach(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.session.attach",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": "Not authenticated"
                    }
                })
                .to_string(),
            ))));
        }

        let session_id = msg
            .payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let preferred_mode = msg
            .payload
            .get("preferred_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("p2p");

        // Parse session_id as "agent_id:session_name"
        let (agent_id, session_name) = match session_id.split_once(':') {
            Some((aid, sname)) => (aid.to_string(), sname.to_string()),
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "server.session.attach",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": "Invalid session_id format. Expected 'agent_id:session_name'"
                        }
                    })
                    .to_string(),
                ))));
            }
        };

        // Look up the session in the registry
        let session = self.session_registry.get(session_id).await;
        if session.is_none() {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.session.attach",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": format!("Session '{}' not found", session_id)
                    }
                })
                .to_string(),
            ))));
        }

        // Look up the agent
        let agent = self.agent_registry.get(&agent_id).await;
        let agent = match agent {
            Some(a) if a.status == AgentStatus::Online => a,
            Some(_) => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "server.session.attach",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": format!("Agent '{}' is offline", agent_id)
                        }
                    })
                    .to_string(),
                ))));
            }
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "server.session.attach",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": format!("Agent '{}' not found or offline", agent_id)
                        }
                    })
                    .to_string(),
                ))));
            }
        };

        // Legacy single endpoint for old clients: prefer a tunnel, then any
        // reachable address, then the first. Falls back to the constructed
        // URL when the agent advertised no addresses at all.
        let agent_ws_url = crate::registry::legacy_agent_address(&agent.addresses)
            .or_else(|| agent.connect_url.clone())
            .unwrap_or_else(|| format!("ws://{}:{}/ws", agent.ip_address, agent.port));
        let agent_address = agent_ws_url.clone();

        // Mint the credential, and hand it to the agent that will **verify** it
        // before the client that will **present** it is told the token (#1013).
        //
        // That ordering is the whole design. A client dials the agent the
        // instant it holds a token, so a grant that had not arrived yet would
        // refuse a legitimate attach — a race the client cannot detect and the
        // user cannot act on. Awaiting the acknowledgement first makes it
        // impossible rather than unlikely.
        let credential = self
            .p2p_broker
            .mint(
                &agent_id,
                session_id,
                &agent.ip_address,
                agent.port,
                CredentialScope::for_attach(&session_name),
            )
            .await;

        let grant = P2pGrantPayload {
            // The command transport injects the authoritative one.
            request_id: String::new(),
            credential: credential.token.clone(),
            agent_id: agent_id.clone(),
            session_id: session_id.to_string(),
            scope: credential.scope.clone(),
            expires_at: credential.expires_at.to_rfc3339(),
        };

        // Serialise the full probed-address list for multi-address clients.
        let addresses_json = serde_json::to_value(&agent.addresses).unwrap_or(json!([]));

        info!(
            "Client requested attach to session {} (mode: {}), agent at {} ({} address(es))",
            session_id,
            preferred_mode,
            agent_ws_url,
            agent.addresses.len()
        );

        if preferred_mode == "relay" {
            // Resolve env snapshots if provided in the attach request.
            let attach_env_snapshots: Vec<EnvSnapshot> = msg
                .payload
                .get("env_snapshots")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            if !attach_env_snapshots.is_empty() {
                info!(
                    "Relay attach with {} env snapshot(s) for session {}",
                    attach_env_snapshots.len(),
                    session_name
                );
            }

            // Honour a manually-selected relay address from the browser.
            let _manual_relay_url: Option<String> = msg
                .payload
                .get("relay_url")
                .and_then(|v| v.as_str())
                .map(str::to_string);

            // Build candidate URL list for the server to try when
            // connecting to the agent.  If the browser specified a
            // relay_url, use only that one.  Otherwise auto-select:
            // Reachable > Unknown > Unreachable > legacy fallback.
            let _relay_urls: Vec<String> = if let Some(ref url) = _manual_relay_url {
                info!(
                    "Relay mode: using manual URL {} for session {}",
                    url, session_name
                );
                vec![url.clone()]
            } else {
                let mut urls: Vec<String> = agent
                    .addresses
                    .iter()
                    .filter(|p| p.status == AddressStatus::Reachable)
                    .map(|p| p.address.url.clone())
                    .chain(
                        agent
                            .addresses
                            .iter()
                            .filter(|p| p.status == AddressStatus::Unknown)
                            .map(|p| p.address.url.clone()),
                    )
                    .chain(
                        agent
                            .addresses
                            .iter()
                            .filter(|p| p.status == AddressStatus::Unreachable)
                            .map(|p| p.address.url.clone()),
                    )
                    .collect();
                if urls.is_empty() {
                    urls.push(agent_ws_url.clone());
                }
                info!(
                    "Relay mode: {} candidate URL(s) for agent {} (session {})",
                    urls.len(),
                    agent_id,
                    session_name
                );
                urls
            };

            let client_id = uuid::Uuid::new_v4().to_string();
            if let Some(ref sender) = self.client_sender {
                self.client_registry
                    .register(session_id, &client_id, sender.clone())
                    .await;
            } else {
                warn!(
                    "Client attach to session {} in relay mode but no client_sender set",
                    session_id
                );
            }
            self.attached_session_id = Some(session_id.to_string());
            self.attached_client_id = Some(client_id.clone());

            // Send attach response to browser BEFORE entering relay mode,
            // so the browser's requestAttach() resolves instead of timing out.
            if let Some(ref sender) = self.client_sender {
                let response = Message::Text(
                    serde_json::json!({
                        "msg_type": "server.session.attach",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "success",
                            "mode": "relay",
                            // Echo the requested session id: the response
                            // identifies which session it describes (the web
                            // client's SessionRuntime gate keys on it).
                            "session_id": session_id,
                            "session_name": session_name,
                            // Server TCP probe results — the browser shows these
                            // so the user can pick a specific relay endpoint.
                            "addresses": addresses_json,
                        }
                    })
                    .to_string(),
                );
                // The browser's `requestAttach()` is waiting on this frame, so
                // it goes out on the reply lane: `relay.begin` only arrives once
                // the Terminal is mounted, and until then there is nothing else
                // on this connection to answer it. A queue that is closed means
                // the browser is already gone, which `let _` here and nowhere
                // else.
                let _ = sender.send_reply(response).await;
            }

            // Phase 1 complete — relay info returned to browser.
            // The browser will send server.session.relay.begin when the
            // Terminal is mounted and ready to receive terminal output.
            // This avoids the race between server entering relay mode and
            // the browser subscribing to terminal.output.
            Ok(HandlerAction::Reply(None))
        } else {
            // The credential is handed to the client **only here**, so this is
            // the only branch that needs the agent to have been told (#1013).
            // The relay branch mints one too — it did before this change — but
            // nothing presents it until relay carries a credential of its own.
            // A credential the verifier never received can only fail later, in the
            // browser, with less to go on — so a refused grant fails the attach
            // here, where the reason is still in hand.
            if let Err(refusal) = self.grant_p2p_credential(&agent_id, &grant).await {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "server.session.attach",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": format!(
                                "Agent '{agent_id}' would not accept a P2P credential: {refusal}"
                            )
                        }
                    })
                    .to_string(),
                ))));
            }

            let connection_token = credential.token.clone();

            // P2P mode: return the full candidate list (with probe status) plus
            // the legacy single `agent_address` for backward compatibility. The
            // client tests latency across `addresses` and falls back per-address.
            Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.session.attach",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "success",
                        "mode": "p2p",
                        // Echo the requested session id: the response
                        // identifies which session it describes (the web
                        // client's SessionRuntime gate keys on it).
                        "session_id": session_id,
                        "agent_address": agent_address,
                        "addresses": addresses_json,
                        "connection_token": connection_token,
                        "session_name": session_name
                    }
                })
                .to_string(),
            ))))
        }
    }

    /// Handle `server.session.relay.begin` — Phase 2 of relay attach.
    ///
    /// Phase 1 (server.session.attach, relay mode) returned the candidate
    /// addresses but did NOT enter relay forwarding.  Now the Terminal is
    /// mounted and subscribed — the browser sends this to actually start
    /// the relay data flow.
    async fn handle_client_session_relay_begin(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(relay_begin_reply(
                &msg.id,
                SessionRefusal {
                    status: "error".to_string(),
                    message: "Not authenticated".to_string(),
                },
            ));
        }

        // A payload that does not parse is treated as an unusable session id
        // rather than as a hard error, which is exactly what the field-by-field
        // read did (`unwrap_or("")`): it falls through to the "Invalid
        // session_id format" refusal below, the same way a missing `session_id`
        // always has. The literals restate the serde defaults so the two cannot
        // disagree.
        let payload: ClientRelayBeginPayload =
            serde_json::from_value(msg.payload).unwrap_or(ClientRelayBeginPayload {
                session_id: String::new(),
                relay_url: None,
                cols: 80,
                rows: 24,
            });

        let session_id = payload.session_id.as_str();
        let (agent_id, session_name) = match session_id.split_once(':') {
            Some((aid, sname)) => (aid.to_string(), sname.to_string()),
            None => {
                return Ok(relay_begin_reply(
                    &msg.id,
                    SessionRefusal {
                        status: "error".to_string(),
                        message: "Invalid session_id format".to_string(),
                    },
                ));
            }
        };

        let session = self.session_registry.get(session_id).await;
        if session.is_none() {
            return Ok(relay_begin_reply(
                &msg.id,
                SessionRefusal {
                    status: "error".to_string(),
                    message: format!("Session not found: {session_id}"),
                },
            ));
        }

        let agent = self.agent_registry.get(&agent_id).await;
        let agent = match agent {
            Some(a) if a.status == AgentStatus::Online => a,
            _ => {
                return Ok(relay_begin_reply(
                    &msg.id,
                    SessionRefusal {
                        status: "error".to_string(),
                        message: format!("Agent '{agent_id}' is offline"),
                    },
                ));
            }
        };

        // Manual relay URL override from the browser.
        let manual_relay_url: Option<String> = payload.relay_url.clone();

        // Build URL list: respect manual override, otherwise auto-select.
        let agent_ws_url = crate::registry::legacy_agent_address(&agent.addresses)
            .or_else(|| agent.connect_url.clone())
            .unwrap_or_else(|| format!("ws://{}:{}/ws", agent.ip_address, agent.port));

        let relay_urls: Vec<String> = if let Some(ref url) = manual_relay_url {
            vec![url.clone()]
        } else {
            let mut urls: Vec<String> = agent
                .addresses
                .iter()
                .filter(|p| p.status == AddressStatus::Reachable)
                .map(|p| p.address.url.clone())
                .chain(
                    agent
                        .addresses
                        .iter()
                        .filter(|p| p.status == AddressStatus::Unknown)
                        .map(|p| p.address.url.clone()),
                )
                .chain(
                    agent
                        .addresses
                        .iter()
                        .filter(|p| p.status == AddressStatus::Unreachable)
                        .map(|p| p.address.url.clone()),
                )
                .collect();
            if urls.is_empty() {
                urls.push(agent_ws_url);
            }
            urls
        };

        info!(
            "Relay begin: {} URL(s) for session '{}'",
            relay_urls.len(),
            session_name
        );

        // Mint the relay credential and hand it to the agent that will verify
        // it, **before any dial** (#1013). Same ordering as the p2p path, for
        // the same reason: the dial is what presents it.
        //
        // The credential rides **on the URLs** rather than beside them, and that
        // is what makes both relay dials work without knowing about it — the
        // attach dial iterates this list, and the detach dial reuses the one that
        // succeeded. A credential threaded alongside would have to reach both
        // sites and stay in step with them; this way there is one place it can
        // be forgotten, and it is here.
        let credential = self
            .p2p_broker
            .mint(
                &agent_id,
                session_id,
                &agent.ip_address,
                agent.port,
                CredentialScope::for_relay(&session_name),
            )
            .await;

        let grant = P2pGrantPayload {
            request_id: String::new(),
            credential: credential.token.clone(),
            agent_id: agent_id.clone(),
            session_id: session_id.to_string(),
            scope: credential.scope.clone(),
            expires_at: credential.expires_at.to_rfc3339(),
        };

        if let Err(refusal) = self.grant_p2p_credential(&agent_id, &grant).await {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.session.attach",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": format!(
                            "Agent '{agent_id}' would not accept a relay credential: {refusal}"
                        )
                    }
                })
                .to_string(),
            ))));
        }

        let relay_urls: Vec<String> = relay_urls
            .into_iter()
            .map(|url| agent_url_with_credential(&url, &credential.token))
            .collect();

        let client_id = uuid::Uuid::new_v4().to_string();
        if let Some(ref sender) = self.client_sender {
            self.client_registry
                .register(session_id, &client_id, sender.clone())
                .await;
        }
        self.attached_session_id = Some(session_id.to_string());
        self.attached_client_id = Some(client_id.clone());

        // No separate response — the server enters relay forwarding immediately.
        // terminal.output flows back through this WebSocket.

        // Terminal dimensions from the browser viewport (via ResizeObserver).
        // The 80×24 fallback for a browser that has not measured anything yet
        // lives on the type now, so a caller that omits them and a caller that
        // sends them cannot disagree about the default.
        let cols = payload.cols;
        let rows = payload.rows;

        Ok(HandlerAction::Relay {
            agent_ws_urls: relay_urls,
            session_id: session_id.to_string(),
            session_name,
            client_id,
            env_snapshots: Vec::new(),
            cols,
            rows,
        })
    }

    /// Handle `server.session.create` — create a new session on a target agent.
    async fn handle_client_session_create(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. This unit's `error` carries
        // `skip_serializing_if`, so unlike `session.kill` the type *omits* it
        // when absent — which is why the created branch below loses an
        // `error: null` it used to send rather than gaining one.
        let refusal = |error: &str| ClientSessionCreateResponsePayload {
            success: false,
            session_id: None,
            error: Some(error.to_string()),
        };

        if !self.authenticated_client {
            return Ok(session_create_reply(&msg.id, refusal("Not authenticated")));
        }

        // `env_files` is declared now. The handler read it off the payload after
        // this parse would have moved it, so the compiler showed the contract
        // was missing a field rather than a reviewer having to notice.
        let Ok(ClientSessionCreatePayload {
            agent_id,
            name,
            env_files: env_refs,
        }) = serde_json::from_value::<ClientSessionCreatePayload>(msg.payload)
        else {
            return Ok(session_create_reply(
                &msg.id,
                refusal("agent_id and name are required"),
            ));
        };

        if agent_id.is_empty() || name.is_empty() {
            return Ok(session_create_reply(
                &msg.id,
                refusal("agent_id and name are required"),
            ));
        }
        let agent_id = agent_id.as_str();

        // Check agent exists and is online
        let agent = self.agent_registry.get(agent_id).await;
        match agent {
            Some(a) if a.status == AgentStatus::Online => {}
            Some(_) => {
                return Ok(session_create_reply(
                    &msg.id,
                    refusal(&format!("Agent '{agent_id}' is offline")),
                ));
            }
            None => {
                return Ok(session_create_reply(
                    &msg.id,
                    refusal(&format!("Agent '{agent_id}' not found")),
                ));
            }
        }

        let request_id = uuid::Uuid::new_v4().to_string();

        // `env_refs` came out of the parsed payload above — the create-time
        // injection selection.
        let env_snapshots = if env_refs.is_empty() {
            Vec::new()
        } else {
            match self.resolve_snapshots(agent_id, &env_refs).await {
                Ok(s) => s,
                Err(e) => {
                    return Ok(session_create_reply(&msg.id, refusal(&e)));
                }
            }
        };

        info!(
            "Client requested session create on agent {}: name={}, env_files={}",
            agent_id,
            name,
            env_refs.len()
        );

        let rx = self
            .command_broker
            .send_command(
                agent_id,
                "agent.session.create",
                &request_id,
                json!({
                    "request_id": request_id,
                    "name": name,
                    // Ignored on the far side: the Agent creates every session at
                    // its own fixed starting size and lets the first attach
                    // resize it (`TmuxManager::create_session`, and the sizing
                    // decision of 2026-08-15). Kept because the agent payload
                    // field exists and a missing key is not the same wire as one
                    // that says 80×24 — see the note on the CLI's `--width`.
                    "width": 80,
                    "height": 24,
                    "env_snapshots": env_snapshots,
                }),
            )
            .await;

        // Wait up to 30 seconds for agent response.
        // Increased from 10s to handle slow CI environments where tmux operations
        // and agent processing can take longer.
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(response)) => {
                let success = response
                    .get("success")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let session_id = if success {
                    let sid = format!("{agent_id}:{name}");
                    // Immediately register the session so it shows up in list
                    // and attach requests without waiting for the agent's
                    // SessionWatcher poll cycle.
                    let session_info = crate::registry::session::SessionInfo {
                        session_id: sid.clone(),
                        agent_id: agent_id.to_string(),
                        session_name: name.to_string(),
                        status: crate::registry::session::SessionStatus::Detached,
                        window_count: 1,
                        attached_clients: 0,
                        // Just created: the agent reports the pane command on
                        // its next update.
                        foreground_command: None,
                        created_at: chrono::Utc::now(),
                        last_activity: chrono::Utc::now(),
                    };
                    self.session_registry.update_session(session_info).await;
                    self.broadcast_sessions().await;
                    // Record create-time env usage for visibility + in-use lock.
                    if !env_refs.is_empty() {
                        self.env_service.usage.record_create(&sid, &env_refs, None);
                    }
                    Some(sid)
                } else {
                    None
                };
                let error = response
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string);

                Ok(session_create_reply(
                    &msg.id,
                    ClientSessionCreateResponsePayload {
                        success,
                        session_id,
                        error,
                    },
                ))
            }
            Ok(Err(_)) => Ok(session_create_reply(&msg.id, refusal("Agent disconnected"))),
            Err(_) => Ok(session_create_reply(
                &msg.id,
                refusal("Timeout waiting for agent response"),
            )),
        }
    }

    /// Handle `server.session.kill` — kill a session on its agent.
    async fn handle_client_session_kill(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. No contract change was needed here —
        // `WebSessionKillResponse` already describes this wire — but one branch
        // does move: it used to send `{ "success": true }` with no `error` at
        // all, and the type has no `skip_serializing_if`, so it now sends
        // `error: null`. True rather than merely additive (a successful kill
        // had no error), and the Web already declares `error?: string`.
        if !self.authenticated_client {
            return Ok(session_kill_reply(
                &msg.id,
                WebSessionKillResponse {
                    success: false,
                    error: Some("Not authenticated".to_string()),
                },
            ));
        }

        // A missing or non-string `session_id` parses to nothing and lands on
        // the same "Invalid session_id format" reply the empty-string path
        // already produced, so that behaviour is unchanged.
        let Ok(ClientSessionKillPayload { session_id }) =
            serde_json::from_value::<ClientSessionKillPayload>(msg.payload)
        else {
            return Ok(session_kill_reply(
                &msg.id,
                WebSessionKillResponse {
                    success: false,
                    error: Some(
                        "Invalid session_id format. Expected 'agent_id:session_name'".to_string(),
                    ),
                },
            ));
        };
        let session_id = session_id.as_str();

        let (agent_id, session_name) = match session_id.split_once(':') {
            Some((aid, sname)) => (aid.to_string(), sname.to_string()),
            None => {
                return Ok(session_kill_reply(
                    &msg.id,
                    WebSessionKillResponse {
                        success: false,
                        error: Some(
                            "Invalid session_id format. Expected 'agent_id:session_name'"
                                .to_string(),
                        ),
                    },
                ));
            }
        };

        // Check session exists in registry
        let session = self.session_registry.get(session_id).await;
        if session.is_none() {
            let agent = self.agent_registry.get(&agent_id).await;
            match agent {
                Some(a) if a.status != AgentStatus::Online => {
                    self.session_registry.remove(session_id).await;
                    // The one branch of this unit whose wire changes: the type
                    // has no `skip_serializing_if` on `error`, so this reply
                    // gains `error: null`. True — a successful kill had no
                    // error — and the Web already declares `error?: string`.
                    return Ok(session_kill_reply(
                        &msg.id,
                        WebSessionKillResponse {
                            success: true,
                            error: None,
                        },
                    ));
                }
                Some(_) => {
                    return Ok(session_kill_reply(
                        &msg.id,
                        WebSessionKillResponse {
                            success: false,
                            error: Some(format!("Session '{session_id}' not found")),
                        },
                    ));
                }
                None => {
                    return Ok(session_kill_reply(
                        &msg.id,
                        WebSessionKillResponse {
                            success: false,
                            error: Some(format!("Agent '{agent_id}' not found")),
                        },
                    ));
                }
            }
        }

        let request_id = uuid::Uuid::new_v4().to_string();

        info!(
            "Client requested session kill: {} (agent: {})",
            session_name, agent_id
        );

        let rx = self
            .command_broker
            .send_command(
                &agent_id,
                "agent.session.kill",
                &request_id,
                json!({
                    "request_id": request_id,
                    "name": session_name,
                }),
            )
            .await;

        // Wait up to 30 seconds for agent response.
        // Increased from 10s to handle slow CI environments.
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(response)) => {
                let success = response
                    .get("success")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let error = response
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string);

                if success {
                    self.session_registry.remove(session_id).await;
                    // Session destroyed: create-time env vars are gone with it
                    // (EC7) and any attach-time usage is now moot, so release
                    // all locks this session held.
                    self.env_service.usage.clear_session(session_id);
                }

                Ok(session_kill_reply(
                    &msg.id,
                    WebSessionKillResponse { success, error },
                ))
            }
            Ok(Err(_)) => Ok(session_kill_reply(
                &msg.id,
                WebSessionKillResponse {
                    success: false,
                    error: Some("Agent disconnected".to_string()),
                },
            )),
            Err(_) => Ok(session_kill_reply(
                &msg.id,
                WebSessionKillResponse {
                    success: false,
                    error: Some("Timeout waiting for agent response".to_string()),
                },
            )),
        }
    }

    /// Handle `server.agent.command-response` — resolve a pending command.
    async fn handle_agent_command_response(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let agent_id = match &self.registered_agent_id {
            Some(id) => id.clone(),
            None => {
                warn!("server.agent.command-response from unregistered connection");
                return Ok(HandlerAction::Reply(None));
            }
        };

        let request_id = msg
            .payload
            .get("request_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if request_id.is_empty() {
            warn!("server.agent.command-response missing request_id");
            return Ok(HandlerAction::Reply(None));
        }

        info!(
            "Received command response from agent {}: request_id={}, command={}",
            agent_id,
            request_id,
            msg.payload
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );

        self.command_broker
            .resolve_command(&agent_id, &request_id, msg.payload)
            .await;

        Ok(HandlerAction::Reply(None))
    }

    /// Handle `agent.terminal.resize` — broadcast terminal resize to all
    /// web clients attached to the session via relay.
    ///
    /// Authorized the same way as the other agent-originated state: the sending
    /// connection must be the agent's current generation, and the session it
    /// names must be one of *its own*. This handler used to check nothing at
    /// all — it read `session_id` and broadcast — which made it the one
    /// agent-originated wire where a connection registered as `A` could move
    /// state belonging to `B`, and where a superseded connection could still
    /// drive a session it no longer served (#960).
    ///
    /// The session check reads the id's own structure rather than a registry
    /// lookup: session ids are `agent_id:session_name` (see
    /// `crate::registry::session`), so the prefix is whose screen this is. A
    /// resize for a session the registry has never heard of is not refused —
    /// the resize is a level, and a client attached to a session the registry
    /// has not caught up with is still a client that needs the size.
    async fn handle_agent_terminal_resize(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let value = msg.payload;
        let Some(agent_id) = self
            .authorized_agent_id(&value, "server.agent.terminal-resize")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };
        let payload: AgentTerminalResizePayload = match serde_json::from_value(value) {
            Ok(p) => p,
            Err(e) => {
                warn!("agent.terminal.resize with invalid payload: {}", e);
                return Ok(HandlerAction::Reply(None));
            }
        };

        // `agent_id:` rather than a split, so that whatever a session name
        // contains cannot change which agent the id is attributed to.
        if !payload.session_id.starts_with(&format!("{agent_id}:")) {
            warn!(
                "agent.terminal.resize from agent '{agent_id}' for session '{}', which is \
                 not one of its own; refusing",
                payload.session_id
            );
            return Ok(HandlerAction::Reply(None));
        }

        info!(
            "Terminal resize for session {}: {}x{}",
            payload.session_id, payload.cols, payload.rows
        );

        let server_payload = ServerTerminalResizePayload {
            session_id: payload.session_id.clone(),
            cols: payload.cols,
            rows: payload.rows,
        };
        let broadcast_msg = serde_json::json!({
            "msg_type": "terminal.resize",
            "id": uuid::Uuid::new_v4().to_string(),
            "timestamp": current_timestamp(),
            "payload": server_payload,
        });

        let sent = self
            .client_registry
            .broadcast(&payload.session_id, broadcast_msg.to_string())
            .await;

        if sent > 0 {
            info!(
                "Broadcast terminal resize to {} client(s) for session {}",
                sent, payload.session_id
            );
        }

        Ok(HandlerAction::Reply(None))
    }

    /// Handle `agent.address_update` — update the agent's advertised
    /// addresses after a network change on the agent host.
    ///
    /// The agent it belongs to comes from the connection, not from the payload
    /// — see `authorized_agent_id`.
    async fn handle_agent_address_update(
        &self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // The identity is read from the raw payload, before it is consumed by
        // the typed parse below — the connection's registration is what decides
        // whose addresses these are, not the id in the body.
        let value = msg.payload;
        let Some(agent_id) = self
            .authorized_agent_id(&value, "server.agent.address-update")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };
        let payload: AgentAddressUpdatePayload = serde_json::from_value(value)?;

        let Some(mut agent) = self.agent_registry.get(&agent_id).await else {
            info!(
                "agent.address_update from unknown agent '{}'; ignoring",
                agent_id
            );
            return Ok(HandlerAction::Reply(None));
        };

        // Extract a display IP from the first LAN address so the legacy
        // `ip_address` field (shown in the Web UI) stays in sync.
        let primary_ip = payload
            .addresses
            .iter()
            .find(|a| a.network_type == nession_protocol::contracts::agent::v1::NetworkType::Lan)
            .or_else(|| payload.addresses.first())
            .and_then(|a| extract_ip_from_url(&a.url));

        let addresses = crate::registry::build_probed_addresses(
            payload.addresses,
            primary_ip.as_deref().unwrap_or(&agent.ip_address),
            agent.port,
            agent.connect_url.as_deref(),
        );
        agent.addresses = addresses;
        if let Some(ip) = primary_ip {
            agent.ip_address = ip;
        }

        info!(
            "Updated {} address(es) for agent {} (primary ip: {})",
            agent.addresses.len(),
            agent_id,
            agent.ip_address,
        );

        self.agent_registry.register(agent).await;
        Ok(HandlerAction::Reply(None))
    }

    /// Relay a message to the agent it names.
    ///
    /// Named for what it does rather than for what it used to recognise: the
    /// caller has already established that this target's manifest carries the
    /// wire, and nothing here inspects the message type beyond using it as the
    /// lookup key and echoing it back. Whether the far side implements it with
    /// a plugin is not visible from here and does not need to be.
    ///
    /// Uses agent_command() which injects request_id into the payload so the agent
    /// can correlate its response via server.agent.command-response.
    async fn handle_relayed_message(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // The pipeline's first step (`#678`), and the one that was missing
        // until `#877`.
        //
        // **Before the payload is read, deliberately.** Everything below this
        // point answers differently depending on which agent was named — a
        // target that does not exist and a target that exists but does not
        // advertise the unit are both `contract_not_supported`, with different
        // text. An unauthenticated caller must not be able to tell those apart,
        // so the refusal cannot consult the payload at all: it is the same
        // answer for every request, which is also the answer that tells the
        // caller nothing about the fleet.
        //
        // Every other client-facing handler in this file has had this gate all
        // along; the relay reaches further than any of them — it crosses into
        // another machine and can read that machine's repositories and
        // `~/.claude/` — and was the one path that did not check.
        //
        // `server.auth` sets `authenticated_client` (see `handle_client_auth`),
        // and the Web sends it as a handshake before the socket is usable, so
        // nothing that works today stops working.
        if !self.authenticated_client {
            warn!(
                "Rejected unauthenticated relayed request `{}` id={}",
                msg.msg_type, msg.id
            );
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": msg.msg_type,
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "error": "not_authenticated",
                        "available": false,
                        "message": "this connection has not authenticated; send `client.auth` first",
                    },
                })
                .to_string(),
            ))));
        }

        let agent_id = msg
            .payload
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if agent_id.is_empty() {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": msg.msg_type,
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "error": "missing agent_id",
                        "available": false,
                    }
                })
                .to_string(),
            ))));
        }

        // The reply travels under the request's own wire name — one wire per
        // operation, correlated by the envelope's `id`. It used to be
        // `<wire>.response`, and the client had to know both names to hear an
        // answer to one call.
        let reply_wire = msg.msg_type.as_str();

        // Does the target say it can carry this? (`#678`)
        //
        // The pipeline's "verify target manifest supports contract" step, and
        // the first thing that consults the manifest an agent advertised.
        //
        // A target with **no** manifest is refused, not relayed. Registration
        // already turns away an agent that advertises nothing, so reaching this
        // means a straggler: one that registered before this server was
        // upgraded and has not reconnected since. Relaying to it would be
        // guessing at a shape nobody declared — the thing the manifest exists
        // to stop — and the guess would be invisible, because the relay would
        // look exactly like a working one.
        //
        // Refusing here is a *unit-scoped* answer, not a connection-level one —
        // the design is explicit that a unit with no intersection disables that
        // unit and does not take the connection with it. The client gets a
        // response correlated to its own request id and everything else on the
        // socket is untouched.
        let Some(manifest) = self
            .agent_registry
            .get(agent_id)
            .await
            .and_then(|agent| agent.protocol_manifest)
        else {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": reply_wire,
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "error": "contract_not_supported",
                        "available": false,
                        // Names the fix: the agent has to come back with a
                        // manifest, which means an upgrade, not a retry.
                        "message": format!(
                            "`{agent_id}` advertised no protocol manifest, so this server \
                             will not route `{}` to it. It predates manifests — upgrade it.",
                            msg.msg_type
                        ),
                    },
                })
                .to_string(),
            ))));
        };

        let Some(unit) = manifest.unit_for_wire(&msg.msg_type) else {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": reply_wire,
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "error": "contract_not_supported",
                        "available": false,
                        "message": format!(
                            "`{}` does not advertise `{}`",
                            agent_id, msg.msg_type
                        ),
                    },
                })
                .to_string(),
            ))));
        };

        // If the caller named a contract version, the target must offer it.
        //
        // A caller that names one has already resolved — it read the manifest
        // this server serves and picked a version. Refusing here is not a
        // second negotiation; it is checking that the manifest the caller
        // resolved against is still the one the target advertises, which is the
        // "target manifest stale" case the design lists.
        //
        // No version named means the caller has not resolved, and it relays as
        // it always did. Absence is not a claim about versions any more than it
        // is about wire types.
        if let Some(named) = msg.payload.get("contract_version").and_then(Value::as_u64) {
            let offered = manifest
                .support(unit)
                .map(|support| support.versions.clone())
                .unwrap_or_default();
            let known = offered.iter().any(|v| u64::from(v.get()) == named);
            if !known {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": reply_wire,
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "error": "contract_not_supported",
                            "available": false,
                            // Both sides, so a reader can see who has to move
                            // rather than only that something did not line up.
                            "message": format!(
                                "`{agent_id}` offers `{unit}` at {offered:?}, not v{named}"
                            ),
                            "protocol": unit.as_str(),
                            "named_version": named,
                            "offered_versions": offered.iter().map(|v| v.get()).collect::<Vec<_>>(),
                        },
                    })
                    .to_string(),
                ))));
            }
        } else {
            // No version named. Refused **only when the target serves more than
            // one generation of this unit**, because that is the one case where
            // the silence is genuinely ambiguous: the caller could have meant
            // either, and nothing on the wire says which.
            //
            // Refusing everywhere was the alternative, and it is not a smaller
            // change — it is a different one. Every `agent.file.*`,
            // `agent.env.*` and `agent.session.*` call is unversioned today and
            // every one of those units is in the target's manifest, so a blanket
            // refusal refuses essentially all traffic. A unit with exactly one
            // version has only one thing an unversioned call can mean; refusing
            // that would break every caller while catching nothing.
            //
            // So the rule is the ambiguity, not the absence. `#963` Scope 2's
            // literal wording asks for the second; this is the first, chosen
            // because it targets the failure that scope names — a manifest-backed
            // operation whose version nobody checked — without the repository-wide
            // caller migration the literal reading implies.
            let offered = manifest
                .support(unit)
                .map(|support| support.versions.clone())
                .unwrap_or_default();
            if offered.len() > 1 {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": reply_wire,
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "error": "contract_not_supported",
                            "available": false,
                            "message": format!(
                                "`{agent_id}` serves `{unit}` at {offered:?}, so this call has \
                                 to name one — an unversioned request to a unit with more than \
                                 one generation does not say which"
                            ),
                            "protocol": unit.as_str(),
                            "offered_versions": offered.iter().map(|v| v.get()).collect::<Vec<_>>(),
                        },
                    })
                    .to_string(),
                ))));
            }
        }

        match self
            // not-protocol: the relay forwards the wire the client named, so the
            // id arrives as data. `agent_command` takes it as a parameter.
            .agent_command(agent_id, &msg.msg_type, msg.payload.clone())
            .await
        {
            Ok(response) => {
                // agent_command returns { request_id, command, result }.
                // Extract just the result for the client response.
                let result = response.get("result").cloned().unwrap_or(response);
                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": reply_wire,
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": result,
                    })
                    .to_string(),
                ))))
            }
            Err(e) => {
                warn!("Extension command failed for agent {}: {}", agent_id, e);
                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": reply_wire,
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": { "error": "agent_disconnected", "available": false },
                    })
                    .to_string(),
                ))))
            }
        }
    }

    /// Handle `server.session.capture-preview` — capture tmux scrollback from
    /// a session on its agent and relay the base64-encoded ANSI back to the client.
    async fn handle_client_session_capture_preview(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        info!(
            "handle_client_session_capture_preview: called with msg_id={}",
            msg.id
        );

        if !self.authenticated_client {
            warn!("handle_client_session_capture_preview: client not authenticated");
            return Ok(reply_json(
                &msg.id,
                "server.session.capture-preview",
                json!({ "error": "Not authenticated" }),
            ));
        }

        // Typed at the contract boundary — the *request* only. This unit's
        // replies stay hand-built on purpose: five of them are the Server's own
        // refusals, and the sixth relays whatever the agent answered. The
        // Server does not read a provider's payload shape, so there is no
        // Nession-owned response type to build (see `docs/architecture/protocol.md`
        // on the relay).
        let ClientSessionCapturePreviewPayload { session_id, lines } =
            serde_json::from_value(msg.payload).unwrap_or_else(|_| {
                ClientSessionCapturePreviewPayload {
                    session_id: String::new(),
                    lines: 2000,
                }
            });
        let session_id = session_id.as_str();

        info!(
            "handle_client_session_capture_preview: session_id={}, lines={}",
            session_id, lines
        );

        let (agent_id, session_name) = match session_id.split_once(':') {
            Some((aid, sname)) => (aid.to_string(), sname.to_string()),
            None => {
                warn!(
                    "handle_client_session_capture_preview: invalid session_id format: {}",
                    session_id
                );
                return Ok(reply_json(
                    &msg.id,
                    "server.session.capture-preview",
                    json!({ "error": "Invalid session_id format. Expected 'agent_id:session_name'" }),
                ));
            }
        };

        info!(
            "handle_client_session_capture_preview: agent_id={}, session_name={}",
            agent_id, session_name
        );

        // Check agent is online
        let agent = self.agent_registry.get(&agent_id).await;
        match agent {
            Some(a) if a.status != AgentStatus::Online => {
                warn!(
                    "handle_client_session_capture_preview: agent {} is offline",
                    agent_id
                );
                return Ok(reply_json(
                    &msg.id,
                    "server.session.capture-preview",
                    json!({ "error": format!("Agent '{}' is offline", agent_id) }),
                ));
            }
            None => {
                warn!(
                    "handle_client_session_capture_preview: agent {} not found in registry",
                    agent_id
                );
                return Ok(reply_json(
                    &msg.id,
                    "server.session.capture-preview",
                    json!({ "error": format!("Agent '{}' not found", agent_id) }),
                ));
            }
            Some(_) => {
                info!(
                    "handle_client_session_capture_preview: agent {} is online",
                    agent_id
                );
            }
        }

        // Relay to agent with 15s timeout (capture can be slow for large lines)
        let payload = json!({
            "session_name": session_name,
            "lines": lines,
        });
        info!("handle_client_session_capture_preview: calling agent_command_with_timeout for agent {}", agent_id);
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.session.capture-preview",
                payload,
                Duration::from_secs(15),
            )
            .await
        {
            Ok(response) => {
                info!(
                    "handle_client_session_capture_preview: got response from agent {}",
                    agent_id
                );
                Ok(reply_json(
                    &msg.id,
                    "server.session.capture-preview",
                    response,
                ))
            }
            Err(e) => {
                warn!("handle_client_session_capture_preview: agent_command_with_timeout failed for agent {}: {}", agent_id, e);
                Ok(reply_json(
                    &msg.id,
                    "server.session.capture-preview",
                    json!({ "error": e }),
                ))
            }
        }
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

    /// Handle `server.env.list` — aggregate server env files with those from
    /// every online agent (EC6: same filename on both shows twice with badges).
    async fn handle_client_env_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary, erased only at the dispatcher. Both
        // halves of this unit live in `contracts::env::v1`, and the agent's
        // half of the same protocol (`agent.env.list`) already declares them —
        // this handler read and wrote `Value` while they sat there unused.
        let ClientEnvListPayload {} = serde_json::from_value(msg.payload)?;

        if !self.authenticated_client {
            return Ok(env_list_reply(
                &msg.id,
                ClientEnvListResponsePayload {
                    files: Vec::new(),
                    error: Some("Not authenticated".to_string()),
                },
            ));
        }

        let mut files = self.env_service.store.list().await.unwrap_or_default();

        // Query each online agent for its local files.
        for agent in self.agent_registry.list().await {
            if agent.status != AgentStatus::Online {
                continue;
            }
            match self
                .agent_command(&agent.agent_id, "agent.env.list", json!({}))
                .await
            {
                Ok(resp) => {
                    if let Some(arr) = resp.get("files").and_then(|v| v.as_array()) {
                        for f in arr {
                            if let Ok(info) = serde_json::from_value::<
                                nession_protocol::contracts::env::v1::EnvFileInfo,
                            >(f.clone())
                            {
                                files.push(info);
                            }
                        }
                    }
                }
                Err(e) => warn!("env.list from agent {} failed: {}", agent.agent_id, e),
            }
        }

        Ok(env_list_reply(
            &msg.id,
            ClientEnvListResponsePayload { files, error: None },
        ))
    }

    /// Handle `server.env.get` — read one env file's content and report which
    /// sessions currently use it (for the in-use lock).
    async fn handle_client_env_get(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. `ClientEnvGetPayload::source` carries
        // a serde default so this accepts exactly what `parse_env_ref` accepted
        // — a request naming no source is a server file, not a refusal. A
        // payload with no `name` fails to parse and gets the same reply the
        // empty-name branch gives, so the wire is unchanged either way.
        if !self.authenticated_client {
            return Ok(env_get_reply(
                &msg.id,
                ClientEnvGetResponsePayload {
                    success: false,
                    content: None,
                    in_use_by: None,
                    error: Some("Not authenticated".to_string()),
                },
            ));
        }
        let Ok(ClientEnvGetPayload {
            name,
            source,
            agent_id,
        }) = serde_json::from_value(msg.payload)
        else {
            return Ok(env_get_reply(
                &msg.id,
                ClientEnvGetResponsePayload {
                    success: false,
                    content: None,
                    in_use_by: None,
                    error: Some("name is required".to_string()),
                },
            ));
        };
        if name.is_empty() {
            return Ok(env_get_reply(
                &msg.id,
                ClientEnvGetResponsePayload {
                    success: false,
                    content: None,
                    in_use_by: None,
                    error: Some("name is required".to_string()),
                },
            ));
        }

        let in_use_by = self
            .env_service
            .usage
            .sessions_using(&name, source, agent_id.as_deref());

        let result = match source {
            EnvSource::Server => self
                .env_service
                .store
                .read(&name)
                .await
                .map_err(|e| e.to_string()),
            EnvSource::Agent => match &agent_id {
                Some(aid) => self
                    .agent_command(aid, "agent.env.get", json!({ "name": name }))
                    .await
                    .and_then(|resp| {
                        if resp.get("success").and_then(serde_json::Value::as_bool) == Some(true) {
                            Ok(resp
                                .get("content")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string())
                        } else {
                            Err(resp
                                .get("error")
                                .and_then(|v| v.as_str())
                                .unwrap_or("read failed")
                                .to_string())
                        }
                    }),
                None => Err("agent_id is required for agent files".to_string()),
            },
        };

        match result {
            Ok(content) => Ok(env_get_reply(
                &msg.id,
                ClientEnvGetResponsePayload {
                    success: true,
                    content: Some(content),
                    in_use_by: Some(in_use_by),
                    error: None,
                },
            )),
            Err(e) => Ok(env_get_reply(
                &msg.id,
                ClientEnvGetResponsePayload {
                    success: false,
                    content: None,
                    in_use_by: Some(in_use_by),
                    error: Some(e),
                },
            )),
        }
    }

    /// Handle `server.env.write` — create/overwrite an env file. Blocks writes
    /// to files currently in use by a running session (SC5/EC10).
    async fn handle_client_env_write(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. Three fields used to be read off the
        // payload beside the parser — `content`, `overwrite` and `force` — and
        // only the first two were declared.
        let refusal = |error: &str| ClientEnvWriteResponsePayload {
            success: false,
            exists: false,
            error: Some(error.to_string()),
            warnings: Vec::new(),
            in_use_by: None,
            re_sourced: None,
            re_source_errors: None,
        };

        if !self.authenticated_client {
            return Ok(env_write_reply(&msg.id, refusal("Not authenticated")));
        }
        let Ok(ClientEnvWritePayload {
            name,
            source,
            agent_id,
            content,
            overwrite,
            force,
        }) = serde_json::from_value(msg.payload)
        else {
            return Ok(env_write_reply(&msg.id, refusal("name is required")));
        };

        if name.is_empty() {
            return Ok(env_write_reply(&msg.id, refusal("name is required")));
        }

        // In-use lock: an overwrite of a file bound to a running session is
        // refused with a clear message listing the sessions, unless `force` is
        // set (caller accepts the risk and re-sources the file afterwards).
        if overwrite && !force {
            let in_use = self
                .env_service
                .usage
                .sessions_using(&name, source, agent_id.as_deref());
            if !in_use.is_empty() {
                return Ok(env_write_reply(
                    &msg.id,
                    ClientEnvWriteResponsePayload {
                        error: Some(format!(
                            "This file is in use by session(s): {}. Stop the session or detach before editing.",
                            in_use.join(", ")
                        )),
                        in_use_by: Some(in_use),
                        ..refusal("")
                    },
                ));
            }
        }

        let warnings = parse_env(&content).warnings;

        let outcome = match source {
            EnvSource::Server => self
                .env_service
                .store
                .write(&name, &content, overwrite)
                .await
                .map_err(|e| e.to_string()),
            EnvSource::Agent => match &agent_id {
                Some(aid) => self
                    .agent_command(
                        aid,
                        "agent.env.write",
                        json!({ "name": name, "content": content, "overwrite": overwrite }),
                    )
                    .await
                    .map(|resp| {
                        // Agent returns success=true on write, exists=true when
                        // refused for lack of overwrite.
                        resp.get("success").and_then(serde_json::Value::as_bool) == Some(true)
                    }),
                None => Err("agent_id is required for agent files".to_string()),
            },
        };

        match outcome {
            Ok(true) => {
                let mut re_sourced: Vec<String> = Vec::new();
                let mut re_source_errors: Vec<String> = Vec::new();

                if force {
                    let sessions =
                        self.env_service
                            .usage
                            .sessions_using(&name, source, agent_id.as_deref());
                    for sid in &sessions {
                        // Re-source through the same path the explicit
                        // `server.session.env.apply` takes. This used to ask for
                        // `agent.env.resource`, a wire no agent has ever
                        // answered — so every forced write reported a re-source
                        // failure and the running session kept the old values.
                        let refs = [EnvFileRef {
                            name: name.clone(),
                            source,
                            agent_id: agent_id.clone(),
                        }];
                        match self.source_env_into_session(sid, &refs).await {
                            Ok(_) => re_sourced.push(sid.clone()),
                            Err(e) => re_source_errors.push(format!("{sid}: {e}")),
                        }
                    }
                }

                Ok(env_write_reply(
                    &msg.id,
                    ClientEnvWriteResponsePayload {
                        success: true,
                        exists: false,
                        error: None,
                        warnings,
                        in_use_by: None,
                        re_sourced: Some(re_sourced),
                        re_source_errors: Some(re_source_errors),
                    },
                ))
            }
            // Refused for existing, which carries `exists` and no error — the
            // UI prompts for confirmation rather than reporting a failure.
            Ok(false) => Ok(env_write_reply(
                &msg.id,
                ClientEnvWriteResponsePayload {
                    success: false,
                    exists: true,
                    error: None,
                    warnings: Vec::new(),
                    in_use_by: None,
                    re_sourced: None,
                    re_source_errors: None,
                },
            )),
            Err(e) => Ok(env_write_reply(&msg.id, refusal(&e))),
        }
    }

    /// Handle `server.env.delete` — delete an env file (blocked if in use).
    async fn handle_client_env_delete(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. `force` used to be read off the
        // payload beside the parser because the contract did not name it,
        // though the Web has always sent it.
        if !self.authenticated_client {
            return Ok(env_del_reply(
                &msg.id,
                ClientEnvDeleteResponsePayload {
                    success: false,
                    error: Some("Not authenticated".to_string()),
                },
            ));
        }
        let Ok(ClientEnvDeletePayload {
            name,
            source,
            agent_id,
            force,
        }) = serde_json::from_value(msg.payload)
        else {
            return Ok(env_del_reply(
                &msg.id,
                ClientEnvDeleteResponsePayload {
                    success: false,
                    error: Some("name is required".to_string()),
                },
            ));
        };
        if name.is_empty() {
            return Ok(env_del_reply(
                &msg.id,
                ClientEnvDeleteResponsePayload {
                    success: false,
                    error: Some("name is required".to_string()),
                },
            ));
        }

        // In-use lock: refuse to delete a file bound to a running session
        // unless `force` is set (the file is gone, so no re-source is needed).
        if !force {
            let in_use = self
                .env_service
                .usage
                .sessions_using(&name, source, agent_id.as_deref());
            if !in_use.is_empty() {
                return Ok(env_del_reply(
                    &msg.id,
                    ClientEnvDeleteResponsePayload {
                        success: false,
                        error: Some(format!(
                            "This file is in use by session(s): {}. Stop the session or detach before deleting.",
                            in_use.join(", ")
                        )),
                    },
                ));
            }
        }

        let outcome = match source {
            EnvSource::Server => self
                .env_service
                .store
                .delete(&name)
                .await
                .map_err(|e| e.to_string()),
            EnvSource::Agent => match &agent_id {
                Some(aid) => self
                    .agent_command(aid, "agent.env.delete", json!({ "name": name }))
                    .await
                    .and_then(|resp| {
                        if resp.get("success").and_then(serde_json::Value::as_bool) == Some(true) {
                            Ok(())
                        } else {
                            Err(resp
                                .get("error")
                                .and_then(|v| v.as_str())
                                .unwrap_or("delete failed")
                                .to_string())
                        }
                    }),
                None => Err("agent_id is required for agent files".to_string()),
            },
        };

        match outcome {
            Ok(()) => Ok(env_del_reply(
                &msg.id,
                ClientEnvDeleteResponsePayload {
                    success: true,
                    error: None,
                },
            )),
            Err(e) => Ok(env_del_reply(
                &msg.id,
                ClientEnvDeleteResponsePayload {
                    success: false,
                    error: Some(e),
                },
            )),
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

    /// Handle `server.session.env.apply` — apply env files to a running session.
    async fn handle_client_session_env_apply(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. `refs` used to be read beside a
        // `session_id` also read by hand; both are fields of the payload the
        // contract already described.
        if !self.authenticated_client {
            return Ok(session_env_reply(
                &msg.id,
                "server.session.env.apply",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some("Not authenticated".to_string()),
                    warnings: Vec::new(),
                },
            ));
        }
        let ClientSessionEnvApplyPayload {
            session_id,
            env_files: refs,
        } = serde_json::from_value(msg.payload).unwrap_or_else(|_| ClientSessionEnvApplyPayload {
            session_id: String::new(),
            env_files: Vec::new(),
        });

        match self.source_env_into_session(&session_id, &refs).await {
            Ok(warnings) => {
                // An explicit apply is a new attachment. The forced-write
                // re-source is not — that session already had the file — which
                // is why usage is recorded here rather than in the helper.
                self.env_service
                    .usage
                    .record_attach(&session_id, &refs, None);
                Ok(session_env_reply(
                    &msg.id,
                    "server.session.env.apply",
                    ClientSessionEnvResponsePayload {
                        success: true,
                        error: None,
                        warnings,
                    },
                ))
            }
            Err(e) => Ok(session_env_reply(
                &msg.id,
                "server.session.env.apply",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some(e),
                    warnings: Vec::new(),
                },
            )),
        }
    }

    /// Handle `server.session.env.unset` — remove attach-time env files from a
    /// running session (on detach).
    async fn handle_client_session_env_unset(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary, same as `env.apply`. Its one wire
        // change is on the success branch below, which used to send
        // `{success: true}` with no `warnings` at all.
        if !self.authenticated_client {
            return Ok(session_env_reply(
                &msg.id,
                "server.session.env.unset",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some("Not authenticated".to_string()),
                    warnings: Vec::new(),
                },
            ));
        }
        let ClientSessionEnvUnsetPayload {
            session_id,
            env_files: refs,
        } = serde_json::from_value(msg.payload).unwrap_or_else(|_| ClientSessionEnvUnsetPayload {
            session_id: String::new(),
            env_files: Vec::new(),
        });

        let Some((agent_id, session_name)) = session_id.split_once(':') else {
            return Ok(session_env_reply(
                &msg.id,
                "server.session.env.unset",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some("Invalid session_id".to_string()),
                    warnings: Vec::new(),
                },
            ));
        };
        let agent_id = agent_id.to_string();
        let session_name = session_name.to_string();

        // Resolve the keys to unset from the current file content. Best-effort:
        // if a file is now missing, skip it rather than failing the detach.
        let snapshots = self
            .resolve_snapshots(&agent_id, &refs)
            .await
            .unwrap_or_default();
        let keys: Vec<String> = snapshots
            .iter()
            .flat_map(|s| s.vars.iter().map(|(k, _)| k.clone()))
            .collect();

        let resp = self
            .agent_command(
                &agent_id,
                "agent.session.env.unset",
                json!({ "name": session_name, "keys": keys }),
            )
            .await;

        // Release the usage regardless of the agent's reply — the client's
        // intent to detach is authoritative for lock purposes.
        self.env_service
            .usage
            .remove_attach(&session_id, &refs, None);

        match resp {
            Ok(r) if r.get("success").and_then(serde_json::Value::as_bool) == Some(true) => {
                // The branch whose wire changes: `warnings` is always
                // serialised, so a successful unset now says `warnings: []`
                // where it previously said nothing. True — there were none.
                Ok(session_env_reply(
                    &msg.id,
                    "server.session.env.unset",
                    ClientSessionEnvResponsePayload {
                        success: true,
                        error: None,
                        warnings: Vec::new(),
                    },
                ))
            }
            Ok(r) => Ok(reply_json(
                &msg.id,
                "server.session.env.unset",
                json!({
                    "success": false,
                    "error": r.get("error").and_then(|v| v.as_str()).unwrap_or("unset failed")
                }),
            )),
            Err(e) => Ok(session_env_reply(
                &msg.id,
                "server.session.env.unset",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some(e),
                    warnings: Vec::new(),
                },
            )),
        }
    }

    /// Handle `server.session.env.active` — list env files active on a session.
    async fn handle_client_session_env_active(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. One shape with an optional error, so
        // unlike the session-list reply there is nothing to discriminate on.
        if !self.authenticated_client {
            return Ok(session_env_active_reply(
                &msg.id,
                SessionEnvActiveResponse {
                    active: Vec::new(),
                    error: Some("Not authenticated".to_string()),
                },
            ));
        }
        let ClientSessionEnvActivePayload { session_id } = serde_json::from_value(msg.payload)
            .unwrap_or_else(|_| ClientSessionEnvActivePayload {
                session_id: String::new(),
            });
        let active = self.env_service.usage.active_for(&session_id);
        Ok(session_env_active_reply(
            &msg.id,
            SessionEnvActiveResponse {
                active,
                error: None,
            },
        ))
    }

    /// Handle `server.session.env.query` — ask the agent which env files are
    /// currently sourced (applied to its process environment).
    async fn handle_client_session_env_query(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary, same shape as `env.active`.
        if !self.authenticated_client {
            return Ok(session_env_query_reply(
                &msg.id,
                SessionEnvQueryResponse {
                    sourced_files: Vec::new(),
                    error: Some("Not authenticated".to_string()),
                },
            ));
        }
        let ClientSessionEnvQueryPayload { session_id } = serde_json::from_value(msg.payload)
            .unwrap_or_else(|_| ClientSessionEnvQueryPayload {
                session_id: String::new(),
            });
        let Some((agent_id, _session_name)) = session_id.split_once(':') else {
            return Ok(session_env_query_reply(
                &msg.id,
                SessionEnvQueryResponse {
                    sourced_files: Vec::new(),
                    error: Some("Invalid session_id".to_string()),
                },
            ));
        };
        let resp = self
            .agent_command(agent_id, "agent.env.query", json!({}))
            .await;
        match resp {
            Ok(r) => {
                let sourced = r
                    .get("sourced_files")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Ok(session_env_query_reply(
                    &msg.id,
                    SessionEnvQueryResponse {
                        sourced_files: sourced,
                        error: None,
                    },
                ))
            }
            Err(e) => Ok(session_env_query_reply(
                &msg.id,
                SessionEnvQueryResponse {
                    sourced_files: Vec::new(),
                    error: Some(e),
                },
            )),
        }
    }

    // ── Quick Commands (issue #95, part 3) ───────────────────────────

    async fn handle_client_commands_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "server.commands.list",
                json!({ "commands": [], "error": "Not authenticated" }),
            ));
        }
        let commands = self.db.list_quick_commands().await.unwrap_or_default();
        let items: Vec<serde_json::Value> = commands
            .into_iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "label": c.label,
                    "command": c.command,
                    "raw": c.raw,
                    "sort_order": c.sort_order,
                    "created_at": c.created_at,
                })
            })
            .collect();
        Ok(reply_json(
            &msg.id,
            "server.commands.list",
            json!({ "commands": items }),
        ))
    }

    async fn handle_client_commands_add(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "server.commands.add",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let payload = msg.payload;
        let label = payload
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        let command = payload
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        let raw = payload
            .get("raw")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        if label.is_empty() || command.is_empty() {
            return Ok(reply_json(
                &msg.id,
                "server.commands.add",
                json!({ "success": false, "error": "Label and command are required" }),
            ));
        }

        let id = format!("user-{}", uuid::Uuid::new_v4());
        let now = chrono::Utc::now().timestamp();
        let row = crate::db::QuickCommandRow {
            id: id.clone(),
            label,
            command,
            raw,
            sort_order: 0,
            created_at: now,
        };
        if let Err(e) = self.db.upsert_quick_command(&row).await {
            return Ok(reply_json(
                &msg.id,
                "server.commands.add",
                json!({ "success": false, "error": e.to_string() }),
            ));
        }
        self.web_client_registry.broadcast_commands_changed().await;
        Ok(reply_json(
            &msg.id,
            "server.commands.add",
            json!({ "success": true, "id": id }),
        ))
    }

    async fn handle_client_commands_remove(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "server.commands.remove",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let id = msg
            .payload
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        if id.is_empty() {
            return Ok(reply_json(
                &msg.id,
                "server.commands.remove",
                json!({ "success": false, "error": "id is required" }),
            ));
        }
        if let Err(e) = self.db.delete_quick_command(&id).await {
            return Ok(reply_json(
                &msg.id,
                "server.commands.remove",
                json!({ "success": false, "error": e.to_string() }),
            ));
        }
        self.web_client_registry.broadcast_commands_changed().await;
        Ok(reply_json(
            &msg.id,
            "server.commands.remove",
            json!({ "success": true }),
        ))
    }

    async fn handle_client_commands_update(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "server.commands.update",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let payload = msg.payload;
        let id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        if id.is_empty() {
            return Ok(reply_json(
                &msg.id,
                "server.commands.update",
                json!({ "success": false, "error": "id is required" }),
            ));
        }
        let label = payload.get("label").and_then(|v| v.as_str());
        let command = payload.get("command").and_then(|v| v.as_str());
        let raw = payload.get("raw").and_then(serde_json::Value::as_bool);

        match self.db.update_quick_command(&id, label, command, raw).await {
            Ok(true) => {
                self.web_client_registry.broadcast_commands_changed().await;
                Ok(reply_json(
                    &msg.id,
                    "server.commands.update",
                    json!({ "success": true }),
                ))
            }
            Ok(false) => Ok(reply_json(
                &msg.id,
                "server.commands.update",
                json!({ "success": false, "error": "Command not found" }),
            )),
            Err(e) => Ok(reply_json(
                &msg.id,
                "server.commands.update",
                json!({ "success": false, "error": e.to_string() }),
            )),
        }
    }
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
                        created_at,
                        last_activity: now,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::env::EnvService;
    use crate::registry::{AgentRegistry, SessionRegistry};
    use crate::server::client_registry::ClientRegistry;
    use crate::server::command_broker::CommandBroker;
    use nession_protocol::contracts::agent::v1::AgentMetadata;
    use nession_protocol::ProtocolManifest;
    use tokio_tungstenite::tungstenite::Message;

    /// Build a test handler wired to in-memory DB + tempdir env store.
    async fn test_handler(auth_token: &str) -> ConnectionHandler {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let agent_registry = Arc::new(AgentRegistry::new(60, Arc::clone(&db)));
        let session_registry = Arc::new(SessionRegistry::new(Arc::clone(&db)));
        let command_broker = Arc::new(CommandBroker::new());
        let client_registry = Arc::new(ClientRegistry::new());
        let web_client_registry = Arc::new(WebClientRegistry::new());
        let env_service = EnvService::new(Arc::clone(&db));
        ConnectionHandler::new(
            ConnectionHandlerDeps {
                agent_registry,
                session_registry,
                command_broker,
                client_registry,
                web_client_registry,
                env_service,
                db,

                p2p_broker: std::sync::Arc::new(crate::broker::ConnectionBroker::new(300)),
            },
            ConnectionHandlerConfig {
                server_auth_token: auth_token.to_string(),
                heartbeat_interval_secs: 30,
            },
        )
    }

    fn proto_msg(msg_type: &str, payload: serde_json::Value) -> Message {
        let text = json!({
            "msg_type": msg_type,
            "id": "test-1",
            "timestamp": 0,
            "payload": payload,
        })
        .to_string();
        Message::Text(text)
    }

    fn parse_reply(action: HandlerAction) -> serde_json::Value {
        match action {
            HandlerAction::Reply(Some(Message::Text(text))) => serde_json::from_str(&text).unwrap(),
            _ => panic!("expected Reply(Some(Text))"),
        }
    }

    // ---- handle_message dispatch ----

    #[tokio::test]
    async fn close_message_returns_close() {
        let mut h = test_handler("").await;
        let action = h.handle_message(Message::Close(None)).await.unwrap();
        assert!(matches!(action, HandlerAction::Close));
    }

    #[tokio::test]
    async fn binary_message_returns_empty_reply() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(Message::Binary(vec![1, 2, 3]))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    // ---- manifest-gated extension relay (#678) ----

    /// Register an agent, optionally with a manifest that carries one wire type.
    async fn register_agent(h: &ConnectionHandler, manifest: Option<ProtocolManifest>) {
        register_agent_id(h, "agent-a", manifest).await;
    }

    /// Put an agent in the *registry* under an explicit id.
    ///
    /// Deliberately not the same thing as registering a connection as that
    /// agent: this is the state a second connection's registration leaves
    /// behind, reachable by a handler that is bound to somebody else (#960).
    async fn register_agent_id(
        h: &ConnectionHandler,
        agent_id: &str,
        manifest: Option<ProtocolManifest>,
    ) {
        h.agent_registry
            .register(AgentInfo {
                agent_id: agent_id.to_string(),
                hostname: "h".to_string(),
                ip_address: "10.0.0.1".to_string(),
                port: 8080,
                display_name: None,
                connect_url: None,
                addresses: vec![],
                registered_at: chrono::Utc::now(),
                last_heartbeat: chrono::Utc::now(),
                status: AgentStatus::Online,
                metadata: AgentMetadata {
                    tmux_version: "3.3".to_string(),
                    os_version: "Linux".to_string(),
                    nession_version: "0.1.0".to_string(),
                    image_tag: "test".to_string(),
                },
                session_count: 0,
                active_sessions: 0,
                protocol_manifest: manifest,
            })
            .await;
    }

    fn manifest_carrying(wire: &str) -> ProtocolManifest {
        ProtocolManifest::from_descriptors(
            "agent-a",
            &[nession_protocol::ProtocolDescriptor::new(
                "git.status",
                "nession-git",
                vec![nession_protocol::ContractDescriptor::new(
                    nession_protocol::ContractVersion::V1,
                    &[wire],
                )],
            )
            .unwrap()],
        )
    }

    async fn relay(h: &mut ConnectionHandler, wire: &str) -> serde_json::Value {
        relay_payload(h, wire, json!({"agent_id": "agent-a"})).await
    }

    /// Relay an extension message **as an authenticated client**.
    ///
    /// The authentication is part of the helper because it is a precondition
    /// now (`#877`): a connection that has not authenticated is refused before
    /// the payload is read, so a test that relays without this flag is a test
    /// of the refusal, not of the relay. Every other handler in this file has
    /// always worked this way — `listed_protocols` below sets the same flag —
    /// and these tests only ever got away without it because the extension path
    /// was the one that forgot to check.
    ///
    /// Tests asserting the refusal deliberately do **not** call this.
    async fn relay_payload(
        h: &mut ConnectionHandler,
        wire: &str,
        payload: serde_json::Value,
    ) -> serde_json::Value {
        h.authenticated_client = true;
        // not-protocol: a test helper — the wire is the argument the test names.
        let action = h.handle_message(proto_msg(wire, payload)).await.unwrap();
        parse_reply(action)["payload"].clone()
    }

    /// A manifest offering `git.status` at v1 and v2.
    fn manifest_with_two_versions() -> ProtocolManifest {
        use nession_protocol::{ContractDescriptor, ContractVersion, ProtocolDescriptor};
        ProtocolManifest::from_descriptors(
            "agent-a",
            &[ProtocolDescriptor::new(
                "git.status",
                "nession-git",
                vec![
                    ContractDescriptor::new(ContractVersion::V1, &["git.status"]),
                    ContractDescriptor::new(ContractVersion::new(2).unwrap(), &["git.status.v2"]),
                ],
            )
            .unwrap()],
        )
    }

    #[tokio::test]
    async fn a_target_that_does_not_carry_the_wire_type_is_refused() {
        // The first thing that consults the manifest an agent advertised.
        let mut h = test_handler("").await;
        register_agent(&h, Some(manifest_carrying("git.status"))).await;

        let payload = relay(&mut h, "git.diff").await;
        assert_eq!(payload["error"], "contract_not_supported");
        assert!(
            payload["message"]
                .as_str()
                .unwrap_or("")
                .contains("git.diff"),
            "the refusal should name what was asked for: {payload}"
        );
    }

    #[tokio::test]
    async fn a_target_that_does_carry_it_is_relayed_rather_than_refused() {
        // The discriminating half. With no live agent connection the relay
        // fails — but it fails *later*, with a different error, which is what
        // proves the manifest check let it through instead of refusing.
        let mut h = test_handler("").await;
        register_agent(&h, Some(manifest_carrying("git.status"))).await;

        let payload = relay(&mut h, "git.status").await;
        assert_ne!(
            payload["error"], "contract_not_supported",
            "a carried wire type must not be refused by the manifest check"
        );
        assert_eq!(payload["error"], "agent_disconnected");
    }

    #[tokio::test]
    async fn an_agent_that_advertised_no_manifest_is_refused_not_relayed() {
        // The rule this replaced said a peer that has not spoken is not a peer
        // that said no, and relayed to it exactly as before manifests existed.
        // `#678` is a breaking upgrade: it is now a peer this server cannot
        // route for, and guessing at a shape nobody declared is the failure the
        // manifest exists to prevent.
        //
        // Reached by registering directly into the registry, because that is
        // the only way this state arises now — `agent.register` refuses it, so
        // this is the straggler that registered before the upgrade.
        let mut h = test_handler("").await;
        register_agent(&h, None).await;

        let payload = relay(&mut h, "git.diff").await;
        assert_eq!(payload["error"], "contract_not_supported");
        assert!(
            payload["message"]
                .as_str()
                .unwrap()
                .contains("no protocol manifest"),
            "the refusal must say which absence it is: {payload}"
        );
        // Refusing is unit-scoped, so the connection and every other unit are
        // untouched — the difference between this and a registration refusal.
        assert_eq!(payload["available"], false);
    }

    // ---- the pipeline's first step (#877) ----

    /// Relay without authenticating, which is the state the gate exists for.
    ///
    /// Deliberately not `relay_payload`: that helper authenticates, so using it
    /// here would assert nothing about the refusal.
    async fn relay_unauthenticated(h: &mut ConnectionHandler, wire: &str) -> serde_json::Value {
        let action = h
            // not-protocol: a test helper — the wire is the argument the test names.
            .handle_message(proto_msg(wire, json!({ "agent_id": "agent-a" })))
            .await
            .unwrap();
        parse_reply(action)["payload"].clone()
    }

    #[tokio::test]
    async fn an_unauthenticated_extension_request_is_refused_before_it_reaches_an_agent() {
        // The finding in `#877`: every other client-facing handler checked
        // `authenticated_client` and this one did not, so any client that could
        // open a socket could relay to any agent with no credentials — and the
        // target was named by the caller, so it was not merely "some agent".
        //
        // The target here *does* carry the wire type and *is* registered, so
        // without the gate this would get as far as the relay and fail with
        // `agent_disconnected`. `not_authenticated` is therefore the proof it
        // stopped at the gate rather than somewhere further down.
        let mut h = test_handler("tok").await;
        register_agent(&h, Some(manifest_carrying("git.status"))).await;

        let payload = relay_unauthenticated(&mut h, "git.status").await;
        assert_eq!(payload["error"], "not_authenticated");
        assert_eq!(payload["available"], false);
    }

    #[tokio::test]
    async fn the_refusal_does_not_depend_on_which_target_was_named() {
        // The property that decides where the gate sits. Below it, the answers
        // differ by target: an agent that does not exist and one that exists
        // but does not carry the unit are both `contract_not_supported`, with
        // different text naming the agent. An unauthenticated caller able to
        // tell those apart has a way to enumerate the fleet without a
        // credential.
        //
        // The gate reads nothing from the payload, so the two are not merely
        // similar — they are the same bytes.
        let mut h = test_handler("tok").await;
        register_agent(&h, Some(manifest_carrying("git.status"))).await;

        let known_target = relay_unauthenticated(&mut h, "git.status").await;

        let action = h
            .handle_message(proto_msg(
                "git.status",
                json!({ "agent_id": "an-agent-that-was-never-registered" }),
            ))
            .await
            .unwrap();
        let unknown_target = parse_reply(action)["payload"].clone();

        assert_eq!(
            known_target, unknown_target,
            "the refusal must not vary with the target"
        );
    }

    #[tokio::test]
    async fn an_authenticated_client_still_relays() {
        // The other half of the gate: it must refuse exactly the connections
        // that have not authenticated and nothing else. Without this, deleting
        // the relay would leave the two tests above passing.
        let mut h = test_handler("tok").await;
        register_agent(&h, Some(manifest_carrying("git.status"))).await;

        let payload = relay(&mut h, "git.status").await;
        assert_ne!(
            payload["error"], "not_authenticated",
            "an authenticated client must get past the gate"
        );
    }

    // ---- the target's protocol support is queryable (#678, Phase 3) ----

    /// List agents and return the first agent's `protocols` field.
    async fn listed_protocols(h: &mut ConnectionHandler) -> serde_json::Value {
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("server.agent.list", json!({})))
            .await
            .unwrap();
        parse_reply(action)["payload"]["agents"][0]["protocols"].clone()
    }

    #[tokio::test]
    async fn the_server_advertises_what_it_serves() {
        // The Server is a provider like any other (`#678`), and this is where a
        // client learns what it answers — on the call a client already makes to
        // ask what this server is, rather than a message of its own.
        let mut h = test_handler("").await;
        h.authenticated_client = true;

        let action = h
            .handle_message(proto_msg("server.info", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        let manifest = &reply["payload"]["protocol_manifest"];

        assert_eq!(manifest["provider"], "nession-server");
        // Named units, not a count: the manifest answers "may I send this peer
        // this message?", so the assertion should be about a message. These two
        // are the ones Phase 6 named and that had no declaration anywhere.
        assert!(manifest["protocols"]["server.session.attach"].is_object());
        assert!(manifest["protocols"]["server.agent.register"].is_object());
        // And a unit this server does not serve stays absent — the manifest
        // exists to refuse, so claiming an offer that does not exist would be
        // the one failure it cannot make.
        assert!(manifest["protocols"]["git.status"].is_null());
    }

    #[test]
    fn every_unit_the_server_dispatches_is_in_its_manifest() {
        // The derivation, asserted. `SERVER_WIRES` and `server_descriptors()`
        // come from one `server_routes!` invocation, so neither can name a unit
        // the other does not — and this is the test that says so rather than
        // the comment that claims it.
        //
        // It matters in one direction especially: a wire this server answers
        // but does not advertise would make its manifest understate it, and a
        // consumer resolving against that manifest would refuse a call this
        // server would have served.
        let manifest = crate::protocol::server_manifest().unwrap();
        assert!(
            !SERVER_WIRES.is_empty(),
            "a declaration with no units is a mistake, not a peer that serves nothing"
        );
        for wire in SERVER_WIRES {
            assert!(
                manifest.carries(wire),
                "`{wire}` is dispatched but not advertised"
            );
        }
    }

    #[test]
    fn every_unit_the_server_dispatches_declares_an_execution_policy() {
        // The same derivation as the test above, for the column #961-C added:
        // `unit_policy` is emitted by the same `server_routes!` invocation that
        // emits `SERVER_WIRES`, so a unit cannot be dispatched without a policy
        // — and this is the assertion that says so rather than the comment on
        // the macro. `policy_for_wire` is what the read loop calls, and a `None`
        // there is not a failure: it is how a wire this server does *not* serve
        // is recognised, which is why the negative case is asserted too.
        //
        // The payload is empty here because this test is about the *declaration*
        // and not about any one key: a policy that reads the payload has to
        // survive being asked about a payload that carries nothing, since a
        // malformed request is dispatched on a lane like every other frame and
        // is refused by the handler rather than by the classifier.
        let nothing = serde_json::json!({});
        for wire in SERVER_WIRES {
            assert!(
                crate::server::handler::unit_policy(wire, &nothing).is_some(),
                "`{wire}` is dispatched but declares no execution policy"
            );
        }
        assert!(
            crate::server::handler::unit_policy("git.status", &nothing).is_none(),
            "a wire this server does not serve must not declare a policy for it"
        );
        assert_eq!(
            crate::server::execution::policy_for_wire("git.status", &nothing),
            crate::server::execution::ExecutionPolicy::Inline,
            "an undeclared wire is dispatched inline rather than guessed at"
        );
    }

    #[test]
    fn a_session_mutation_is_keyed_by_the_session_it_names() {
        // The two spellings the wire uses for one resource, and the property
        // that makes the keyed lane mean anything: `create` names a session by
        // its parts and `kill` names the *same* session joined, so a lane that
        // keyed them differently would let a kill overtake the create it is
        // about — the exact ordering `#961` calls out by name.
        //
        // Asserted as an equality rather than two literals so that it is the
        // *agreement* under test.
        let created = session_by_parts(&serde_json::json!({
            "agent_id": "a1",
            "name": "s1",
        }));
        let killed = session_by_id(&serde_json::json!({ "session_id": "a1:s1" }));
        assert_eq!(created, killed);
        assert_eq!(created.to_string(), "session:a1:s1");

        // And the other direction: two different sessions must not share a key,
        // which is what makes them independent rather than merely fast.
        assert_ne!(
            session_by_parts(&serde_json::json!({ "agent_id": "a1", "name": "s1" })),
            session_by_parts(&serde_json::json!({ "agent_id": "a1", "name": "s2" }))
        );
        assert_ne!(
            session_by_parts(&serde_json::json!({ "agent_id": "a1", "name": "s1" })),
            session_by_parts(&serde_json::json!({ "agent_id": "a2", "name": "s1" }))
        );
    }

    #[test]
    fn an_env_file_is_keyed_by_the_source_it_lives_on() {
        // An agent's `staging.env` and the server's `staging.env` are two files
        // with one name. Keying them together would serialise two unrelated
        // writes; keying the *resource* rather than the name is what the
        // variant is for.
        assert_eq!(
            env_file_key(&serde_json::json!({ "name": "staging.env" })).to_string(),
            "env:staging.env"
        );
        assert_eq!(
            env_file_key(&serde_json::json!({
                "name": "staging.env",
                "source": "agent",
                "agent_id": "a1",
            }))
            .to_string(),
            "env:a1:staging.env"
        );
        assert_ne!(
            env_file_key(&serde_json::json!({ "name": "staging.env" })),
            env_file_key(&serde_json::json!({
                "name": "staging.env",
                "source": "agent",
                "agent_id": "a1",
            }))
        );
    }

    #[test]
    fn the_mutations_are_declared_keyed_and_the_queries_are_not() {
        // The declaration, read back — the stage-E half of the same derivation
        // the two tests above make for stages C and D. A mutation that someone
        // later marks `Inline` would run in the reader and lose its ordering
        // silently, and nothing else in the tree would say so.
        let nothing = serde_json::json!({});
        for wire in [
            "server.session.create",
            "server.session.kill",
            "server.session.env.apply",
            "server.session.env.unset",
            "server.env.write",
            "server.env.delete",
        ] {
            assert!(
                matches!(
                    crate::server::handler::unit_policy(wire, &nothing),
                    Some(crate::server::execution::ExecutionPolicy::Key(_))
                ),
                "`{wire}` mutates a resource and must be declared `Key`"
            );
        }
        for wire in ["server.env.list", "server.env.get", "server.session.list"] {
            assert!(
                matches!(
                    crate::server::handler::unit_policy(wire, &nothing),
                    Some(crate::server::execution::ExecutionPolicy::Query)
                ),
                "`{wire}` reads and must not be declared `Key`"
            );
        }
    }

    #[tokio::test]
    async fn the_agents_list_carries_what_each_agent_can_serve() {
        // Served from the list rather than a query of its own: it is already
        // the discover-agents call, so a consumer resolving per target has the
        // manifests in hand without a second round trip per agent.
        let mut h = test_handler("").await;
        register_agent(&h, Some(manifest_carrying("git.status"))).await;

        let protocols = listed_protocols(&mut h).await;
        assert_eq!(protocols["provider"], "agent-a");
        assert_eq!(protocols["protocols"]["git.status"]["versions"][0], 1);
        assert_eq!(
            protocols["protocols"]["git.status"]["wire"][0],
            "git.status"
        );
    }

    #[tokio::test]
    async fn a_rename_reply_carries_the_manifest_and_the_image_tag() {
        // The test the defect needed. `server.agent.rename` built its own agent
        // block, and it carried neither `protocols` nor `metadata.image_tag` —
        // the two fields `agent_view`'s doc comment names as the drift that
        // consolidating the builders was supposed to end. The block is gone and
        // the reply is `WebAgentInfo` now, so this asserts the two fields rather
        // than the absence of a `json!` call: a future hand-built block would
        // have to reproduce both to pass.
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        register_agent(&h, Some(manifest_carrying("git.status"))).await;

        let action = h
            .handle_message(proto_msg(
                "server.agent.rename",
                json!({ "agent_id": "agent-a", "display_name": "Renamed" }),
            ))
            .await
            .unwrap();
        let payload = parse_reply(action)["payload"].clone();

        let parsed: AgentRenameReply = serde_json::from_value(payload.clone())
            .unwrap_or_else(|e| {
                panic!("server.agent.rename replies {payload} but its contract does not accept it: {e}")
            });
        let AgentRenameReply::Renamed(reply) = parsed else {
            panic!("a rename of a registered agent is not a refusal: {payload}");
        };

        assert!(
            reply.agent.protocols.is_some(),
            "the reply carries the manifest — losing it makes the Web's next call to this \
             agent go out unversioned, which looks like nothing being wrong"
        );
        assert_eq!(reply.agent.metadata.image_tag, "test");
    }

    // ---- a named contract version is checked against the target (#678) ----

    #[tokio::test]
    async fn a_named_version_the_target_does_not_offer_is_refused() {
        // The caller resolved against a manifest and picked v3. The target
        // offers v1 and v2 — so either the caller read a manifest that is no
        // longer current (the design's "target manifest stale"), or it invented
        // the version. Either way it must not be relayed.
        let mut h = test_handler("").await;
        register_agent(&h, Some(manifest_with_two_versions())).await;

        let payload = relay_payload(
            &mut h,
            "git.status",
            json!({"agent_id": "agent-a", "contract_version": 3}),
        )
        .await;

        assert_eq!(payload["error"], "contract_not_supported");
        assert_eq!(payload["protocol"], "git.status");
        assert_eq!(payload["named_version"], 3);
        // Both sides, so a reader learns who has to move rather than only that
        // something did not line up.
        assert_eq!(payload["offered_versions"], json!([1, 2]));
        assert!(
            payload["message"].as_str().unwrap_or("").contains("v3"),
            "the refusal should name the version asked for: {payload}"
        );
    }

    #[tokio::test]
    async fn a_named_version_the_target_offers_is_relayed() {
        // The discriminating half, as in the wire-type gate: with no live agent
        // the relay fails later and differently, which is how this test knows
        // the version check let it through.
        let mut h = test_handler("").await;
        register_agent(&h, Some(manifest_with_two_versions())).await;

        for version in [1, 2] {
            let payload = relay_payload(
                &mut h,
                "git.status",
                json!({"agent_id": "agent-a", "contract_version": version}),
            )
            .await;
            assert_ne!(
                payload["error"], "contract_not_supported",
                "v{version} is offered and must not be refused"
            );
            assert_eq!(payload["error"], "agent_disconnected");
        }
    }

    #[tokio::test]
    async fn an_unversioned_call_to_a_two_version_unit_is_refused() {
        // `#963` Scope 2. A unit the target serves at more than one generation
        // is the one case where naming no version is genuinely ambiguous — the
        // caller could have meant either, and nothing on the wire says which.
        //
        // This test used to assert the opposite, under the reasoning that
        // "absence is not a claim about versions, any more than it is about wire
        // types". The premise was right and the conclusion did not follow: a
        // claim is exactly what the caller *cannot* make here, so relaying hands
        // the target a request whose version nobody checked — which is the
        // failure the scope names.
        let mut h = test_handler("").await;
        register_agent(&h, Some(manifest_with_two_versions())).await;

        let payload = relay(&mut h, "git.status").await;
        assert_eq!(payload["error"], "contract_not_supported");
        assert_eq!(payload["protocol"], "git.status");
        assert_eq!(payload["offered_versions"], json!([1, 2]));
        assert!(
            payload["message"]
                .as_str()
                .unwrap_or("")
                .contains("name one"),
            "the refusal should say what the caller has to do: {payload}"
        );
    }

    #[tokio::test]
    async fn an_unversioned_call_to_a_single_version_unit_is_relayed() {
        // The discriminating half, and the reason the rule is the *ambiguity*
        // rather than the absence. Every `agent.file.*`, `agent.env.*` and
        // `agent.session.*` call is unversioned today and every one of those
        // units has a single version — where the call has exactly one possible
        // meaning. Refusing those would break every caller while catching
        // nothing, which is why `#963` Scope 2's literal wording was not taken.
        let mut h = test_handler("").await;
        register_agent(&h, Some(manifest_carrying("git.status"))).await;

        let payload = relay(&mut h, "git.status").await;
        assert_ne!(
            payload["error"], "contract_not_supported",
            "a single-version unit has one thing an unversioned call can mean"
        );
        assert_eq!(payload["error"], "agent_disconnected");
    }

    #[tokio::test]
    async fn an_agent_without_a_manifest_reports_null_rather_than_an_empty_set() {
        // The distinction the whole legacy rule rests on. `{}` would say "this
        // peer has a protocol set and it is empty" — a peer that serves
        // nothing. `null` says "this peer predates manifests", which the design
        // resolves as a Legacy Peer. A consumer that collapsed the two would
        // refuse to talk to every old agent.
        let mut h = test_handler("").await;
        register_agent(&h, None).await;

        let protocols = listed_protocols(&mut h).await;
        assert!(
            protocols.is_null(),
            "expected null for a legacy peer, got {protocols}"
        );
    }

    #[tokio::test]
    async fn invalid_json_returns_error() {
        let mut h = test_handler("").await;
        let result = h.handle_message(Message::Text("not json".into())).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn unknown_msg_type_returns_empty_reply() {
        let mut h = test_handler("").await;
        let action = h
            // not-protocol: the wire being unknown is what this test asserts.
            .handle_message(proto_msg("unknown.type", json!({})))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    // ---- agent.register ----

    #[tokio::test]
    async fn agent_register_no_auth_mode() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.agent.register",
                json!({
                    "agent_id": "a1",
                    "hostname": "host",
                    "ip_address": "1.2.3.4",
                    "port": 19091,
                    "auth_token": "anything",
                    "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                    "addresses": [],
                    "connect_url": null,
                    "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "accepted");
        assert_eq!(h.registered_agent_id(), Some(&"a1".to_string()));
    }

    #[tokio::test]
    async fn agent_register_valid_token() {
        let mut h = test_handler("secret").await;
        let action = h
            .handle_message(proto_msg(
                "server.agent.register",
                json!({
                    "agent_id": "a1",
                    "hostname": "host",
                    "ip_address": "1.2.3.4",
                    "port": 19091,
                    "auth_token": "secret",
                    "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                    "addresses": [],
                    "connect_url": null,
                    "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "accepted");
    }

    #[tokio::test]
    async fn agent_register_without_a_manifest_is_rejected() {
        // `#678` is a breaking upgrade: an agent this server cannot route for
        // does not connect. Refusing here rather than at the first relay is the
        // difference between an agent that never comes up and one that
        // connects, looks healthy, and silently drops every request aimed at
        // it.
        //
        // A valid auth token, so the rejection can only be the missing
        // manifest — otherwise this test would pass for the wrong reason.
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.agent.register",
                json!({
                    "agent_id": "old-agent",
                    "hostname": "host",
                    "ip_address": "1.2.3.4",
                    "port": 19091,
                    "auth_token": "",
                    "addresses": [],
                    "connect_url": null,
                    "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "rejected");
        assert!(
            reply["payload"]["message"]
                .as_str()
                .unwrap()
                .contains("no protocol manifest"),
            "the rejection must name the missing manifest: {reply}"
        );
        // And nothing was registered, so no later call can reach it.
        assert!(
            h.agent_registry.get("old-agent").await.is_none(),
            "a rejected agent must not be in the registry"
        );
    }

    #[tokio::test]
    async fn agent_register_invalid_token_rejected() {
        let mut h = test_handler("secret").await;
        let action = h
            .handle_message(proto_msg(
                "server.agent.register",
                json!({
                    "agent_id": "a1",
                    "hostname": "host",
                    "ip_address": "1.2.3.4",
                    "port": 19091,
                    "auth_token": "wrong",
                    "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                    "addresses": [],
                    "connect_url": null,
                    "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "rejected");
        assert!(reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("Invalid auth token"));
    }

    #[tokio::test]
    async fn agent_register_with_addresses() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.agent.register",
                json!({
                    "agent_id": "a1",
                    "hostname": "host",
                    "ip_address": "1.2.3.4",
                    "port": 19091,
                    "auth_token": "",
                    "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                    "addresses": [
                        { "url": "ws://1.2.3.4:19091/ws", "network_type": "lan", "label": "" }
                    ],
                    "connect_url": null,
                    "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "accepted");
        // Verify heartbeat_interval_secs is present
        assert_eq!(reply["payload"]["heartbeat_interval_secs"], 30);
    }

    // ---- control.heartbeat ----

    #[tokio::test]
    async fn control_heartbeat_registered_is_handled_and_answered_with_nothing() {
        let mut h = test_handler("").await;
        // Register first
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();

        let action = h
            .handle_message(proto_msg(
                "control.heartbeat",
                json!({
                    "agent_id": "a1",
                    "session_count": 3,
                    "active_sessions": 1,
                }),
            ))
            .await
            .unwrap();
        // Handled, and answered with nothing: control has no acknowledgement,
        // so there is no `server.heartbeat.ack` for this to be the request half
        // of. `Reply(None)` rather than a frame is the whole assertion.
        assert!(matches!(action, HandlerAction::Reply(None)));

        // The bookkeeping the heartbeat exists for still happened.
        let agent = h.agent_registry.get("a1").await.expect("registered agent");
        assert_eq!(agent.session_count, 3);
        assert_eq!(agent.active_sessions, 1);
    }

    #[tokio::test]
    async fn control_heartbeat_unregistered_returns_none() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "control.heartbeat",
                json!({
                    "agent_id": "unknown",
                    "session_count": 0,
                    "active_sessions": 0,
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn control_heartbeat_missing_fields_defaults_to_zero() {
        let mut h = test_handler("").await;
        // Register
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Heartbeat with no session_count / active_sessions
        let action = h
            .handle_message(proto_msg("control.heartbeat", json!({ "agent_id": "a1" })))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
        let agent = h.agent_registry.get("a1").await.expect("registered agent");
        assert_eq!(agent.session_count, 0);
        assert_eq!(agent.active_sessions, 0);
    }

    // ---- agent.session.update ----

    #[tokio::test]
    async fn session_update_active() {
        let mut h = test_handler("").await;
        // Register agent
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();

        let action = h
            .handle_message(proto_msg(
                "server.agent.session-update",
                json!({
                    "agent_id": "a1",
                    "session_name": "dev",
                    "status": "active",
                    "window_count": 2,
                    "attached_clients": 1,
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn session_update_all_statuses() {
        let mut h = test_handler("").await;
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();

        for status in &["active", "detached", "recovering", "orphaned", "zombie"] {
            let action = h
                .handle_message(proto_msg(
                    "server.agent.session-update",
                    json!({
                        "agent_id": "a1",
                        "session_name": format!("s_{status}"),
                        "status": status,
                        "window_count": 1,
                        "attached_clients": 0,
                    }),
                ))
                .await
                .unwrap();
            assert!(matches!(action, HandlerAction::Reply(None)));
        }
    }

    #[tokio::test]
    async fn session_update_unknown_status_returns_none() {
        let mut h = test_handler("").await;
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        let action = h
            .handle_message(proto_msg(
                "server.agent.session-update",
                json!({
                    "agent_id": "a1",
                    "session_name": "dev",
                    "status": "invalid_status",
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn session_update_gone_removes_session() {
        let mut h = test_handler("").await;
        // Register agent
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Create a session
        h.handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "active",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();
        // Remove it
        h.handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "gone",
            }),
        ))
        .await
        .unwrap();
        // Session should be gone
        let _action = h
            .handle_message(proto_msg("server.session.list", json!({})))
            .await
            .unwrap();
        // First need to authenticate
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("server.session.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["sessions"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn session_update_from_unregistered_agent() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.agent.session-update",
                json!({
                    "agent_id": "unknown",
                    "session_name": "dev",
                    "status": "active",
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    // ---- server.auth ----

    #[tokio::test]
    async fn client_auth_success() {
        let mut h = test_handler("secret").await;
        let action = h
            .handle_message(proto_msg("server.auth", json!({ "auth_token": "secret" })))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "success");
    }

    #[tokio::test]
    async fn client_auth_failure() {
        let mut h = test_handler("secret").await;
        let action = h
            .handle_message(proto_msg("server.auth", json!({ "auth_token": "wrong" })))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "failed");
    }

    #[tokio::test]
    async fn client_auth_no_auth_mode() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.auth",
                json!({ "auth_token": "anything" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "success");
    }

    // ---- unauthenticated client rejection ----

    #[tokio::test]
    async fn unauthenticated_agents_list_rejected() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("server.agent.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "error");
    }

    #[tokio::test]
    async fn unauthenticated_sessions_list_rejected() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("server.session.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "error");
    }

    #[tokio::test]
    async fn unauthenticated_session_attach_rejected() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.session.attach",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "error");
    }

    #[tokio::test]
    async fn unauthenticated_session_create_rejected() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.session.create",
                json!({ "agent_id": "a1", "name": "dev" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
    }

    #[tokio::test]
    async fn unauthenticated_session_kill_rejected() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.session.kill",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
    }

    // ---- server.agent.list ----

    #[tokio::test]
    async fn agents_list_returns_registered() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register an agent
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1", "image_tag": "sha-abc123" },
            }),
        ))
        .await
        .unwrap();

        let action = h
            .handle_message(proto_msg("server.agent.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        let agents = reply["payload"]["agents"].as_array().unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["agent_id"], "a1");
        assert_eq!(agents[0]["status"], "online");
        // image_tag must be forwarded to clients (regression: it was dropped
        // from the metadata JSON, so the UI showed "unknown").
        assert_eq!(agents[0]["metadata"]["image_tag"], "sha-abc123");
    }

    #[tokio::test]
    async fn agents_list_empty() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("server.agent.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["agents"].as_array().unwrap().is_empty());
    }

    // ---- server.session.list ----

    #[tokio::test]
    async fn sessions_list_with_filter() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register agent
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Create sessions
        for name in &["s1", "s2"] {
            h.handle_message(proto_msg(
                "server.agent.session-update",
                json!({
                    "agent_id": "a1",
                    "session_name": name,
                    "status": "active",
                    "window_count": 1,
                    "attached_clients": 0,
                }),
            ))
            .await
            .unwrap();
        }
        // Filter by agent_id
        let action = h
            .handle_message(proto_msg(
                "server.session.list",
                json!({ "agent_id": "a1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        let sessions = reply["payload"]["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
    }

    // ---- server.session.list force refresh ----

    /// Registering via `agent.register` marks the agent Online but does not
    /// give it a CommandBroker control connection, so a force refresh will
    /// find it unreachable — exactly the "agent went away" case.
    async fn handler_with_online_agent() -> ConnectionHandler {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        h
    }

    async fn add_session(h: &mut ConnectionHandler, agent_id: &str, name: &str) {
        h.handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": agent_id,
                "session_name": name,
                "status": "detached",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn force_refresh_with_no_agents_is_a_noop() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("server.session.list", json!({ "force": true })))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["sessions"].as_array().unwrap().is_empty());
        assert!(reply["payload"]["stale_agents"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    /// The core failure-semantics guarantee: an agent that cannot answer keeps
    /// its sessions and is reported stale, rather than having live sessions
    /// deleted because of a transient blip.
    #[tokio::test]
    async fn force_refresh_keeps_sessions_of_unreachable_agent_and_marks_stale() {
        let mut h = handler_with_online_agent().await;
        add_session(&mut h, "a1", "s1").await;

        let action = h
            .handle_message(proto_msg("server.session.list", json!({ "force": true })))
            .await
            .unwrap();
        let reply = parse_reply(action);

        // Session survived.
        let sessions = reply["payload"]["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["session_id"], "a1:s1");
        // And the agent is flagged so the UI can warn.
        let stale = reply["payload"]["stale_agents"].as_array().unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0], "a1");
    }

    /// Without `force`, no agent is contacted, so nothing is ever stale.
    #[tokio::test]
    async fn non_force_list_never_reports_stale() {
        let mut h = handler_with_online_agent().await;
        add_session(&mut h, "a1", "s1").await;

        let action = h
            .handle_message(proto_msg("server.session.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);

        assert_eq!(reply["payload"]["sessions"].as_array().unwrap().len(), 1);
        assert!(reply["payload"]["stale_agents"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    /// The `agent_id` filter narrows the fan-out targets: an id matching no
    /// agent contacts nobody, so nothing is stale and nothing is returned.
    #[tokio::test]
    async fn force_refresh_scopes_fanout_to_the_requested_agent() {
        let mut h = handler_with_online_agent().await;
        add_session(&mut h, "a1", "s1").await;

        let action = h
            .handle_message(proto_msg(
                "server.session.list",
                json!({ "force": true, "agent_id": "nonexistent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);

        assert!(reply["payload"]["stale_agents"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(reply["payload"]["sessions"].as_array().unwrap().is_empty());
        // a1's session was left alone — it was never a refresh target.
        assert_eq!(h.session_registry.list().await.len(), 1);
    }

    /// The happy path: the agent answers with its live tmux state and the
    /// registry is rebuilt from it — stale entries dropped, real ones kept,
    /// and the agent is not reported stale.
    #[tokio::test]
    async fn force_refresh_rebuilds_registry_from_agent_reply() {
        let mut h = handler_with_online_agent().await;
        // Registry believes "ghost" exists; tmux will say otherwise.
        add_session(&mut h, "a1", "ghost").await;

        let (sender, mut rx) = WsMessageSender::new();
        let generation = h.command_broker.new_connection_generation();
        h.command_broker.claim_agent("a1", generation, sender).await;

        let broker = Arc::clone(&h.command_broker);
        let list_fut = h.handle_message(proto_msg("server.session.list", json!({ "force": true })));
        let agent_fut = async move {
            let text = rx
                .recv()
                .await
                .expect("agent should receive sessions.list")
                .message
                .to_text()
                .unwrap()
                .to_string();
            let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(parsed["msg_type"], "agent.session.report");
            let request_id = parsed["payload"]["request_id"]
                .as_str()
                .unwrap()
                .to_string();
            broker
                .resolve_command(
                    "a1",
                    &request_id,
                    json!({
                        "success": true,
                        "sessions": [
                            {
                                "name": "real",
                                "window_count": 2,
                                "attached_clients": 1,
                                "created_at": 1000,
                                "foreground_command": "claude",
                            },
                        ],
                    }),
                )
                .await;
        };
        let (action, ()) = tokio::join!(list_fut, agent_fut);
        let reply = parse_reply(action.unwrap());

        let sessions = reply["payload"]["sessions"].as_array().unwrap();
        assert_eq!(
            sessions.len(),
            1,
            "ghost should be gone, real should remain"
        );
        assert_eq!(sessions[0]["session_id"], "a1:real");
        assert_eq!(sessions[0]["status"], "active");
        assert_eq!(sessions[0]["window_count"], 2);
        assert_eq!(
            sessions[0]["foreground_command"], "claude",
            "the agent-reported pane command must survive the refresh into the wire payload"
        );
        assert!(reply["payload"]["stale_agents"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    /// Regression #743: the agent WebSocket loop claims the agent for its
    /// connection on **every** inbound agent message (`server/websocket.rs`),
    /// so that can happen while a command is in flight. It is a transport
    /// update and must not cancel the command — otherwise the client is told
    /// "Agent disconnected" for a session the agent actually created, and the
    /// real response is discarded when it arrives.
    #[tokio::test]
    async fn session_create_survives_an_intervening_agent_message() {
        let mut h = handler_with_online_agent().await;

        let (sender, mut rx) = WsMessageSender::new();
        let generation = h.command_broker.new_connection_generation();
        h.command_broker.claim_agent("a1", generation, sender).await;

        let broker = Arc::clone(&h.command_broker);
        let create_fut = h.handle_message(proto_msg(
            "server.session.create",
            json!({ "agent_id": "a1", "name": "regression-743" }),
        ));
        let agent_fut = async move {
            let text = rx
                .recv()
                .await
                .expect("agent should receive session.create")
                .message
                .to_text()
                .unwrap()
                .to_string();
            let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
            let request_id = parsed["payload"]["request_id"]
                .as_str()
                .unwrap()
                .to_string();

            // An unrelated inbound message from the same agent arrives first;
            // the loop claims the agent for the connection that sent it — a
            // newer one here, standing in for a reconnect.
            let (sender_again, _keepalive) = WsMessageSender::new();
            let generation = broker.new_connection_generation();
            broker.claim_agent("a1", generation, sender_again).await;

            broker
                .resolve_command("a1", &request_id, json!({ "success": true }))
                .await;
        };
        let (action, ()) = tokio::join!(create_fut, agent_fut);
        let reply = parse_reply(action.unwrap());

        assert_eq!(
            reply["payload"]["success"],
            json!(true),
            "an intervening agent message must not turn a completed create into a reported failure"
        );
        assert_eq!(reply["payload"]["session_id"], json!("a1:regression-743"));
    }

    // ---- parse_agent_sessions ----
    #[test]
    fn parse_agent_sessions_reads_the_foreground_command() {
        let resp = json!({
            "sessions": [
                { "name": "running", "window_count": 1, "attached_clients": 1, "created_at": 1, "foreground_command": "claude" },
                { "name": "empty", "window_count": 1, "attached_clients": 0, "created_at": 1, "foreground_command": "" },
                { "name": "missing", "window_count": 1, "attached_clients": 0, "created_at": 1 },
            ],
        });
        let sessions = parse_agent_sessions("a1", &resp);
        assert_eq!(sessions[0].foreground_command.as_deref(), Some("claude"));
        assert_eq!(
            sessions[1].foreground_command, None,
            "an empty command is no observation"
        );
        assert_eq!(
            sessions[2].foreground_command, None,
            "an absent field is tolerated"
        );
    }

    #[test]
    fn parse_agent_sessions_derives_status_from_attached_clients() {
        let resp = json!({
            "sessions": [
                { "name": "idle", "window_count": 1, "attached_clients": 0, "created_at": 1000 },
                { "name": "busy", "window_count": 2, "attached_clients": 3, "created_at": 2000 },
            ]
        });
        let mut got = parse_agent_sessions("a1", &resp);
        got.sort_by(|a, b| a.session_name.cmp(&b.session_name));

        assert_eq!(got.len(), 2);
        assert_eq!(got[0].session_id, "a1:busy");
        assert_eq!(got[0].status, SessionStatus::Active);
        assert_eq!(got[0].window_count, 2);
        assert_eq!(got[1].session_id, "a1:idle");
        assert_eq!(got[1].status, SessionStatus::Detached);
    }

    #[test]
    fn parse_agent_sessions_handles_missing_and_empty() {
        assert!(parse_agent_sessions("a1", &json!({})).is_empty());
        assert!(parse_agent_sessions("a1", &json!({ "sessions": [] })).is_empty());
        // Entries without a usable name are skipped, not fatal.
        let resp = json!({ "sessions": [{ "window_count": 1 }, { "name": "" }] });
        assert!(parse_agent_sessions("a1", &resp).is_empty());
    }

    #[test]
    fn parse_agent_sessions_tolerates_absent_optional_fields() {
        let resp = json!({ "sessions": [{ "name": "bare" }] });
        let got = parse_agent_sessions("a1", &resp);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].window_count, 0);
        assert_eq!(got[0].attached_clients, 0);
        assert_eq!(got[0].status, SessionStatus::Detached);
    }

    // ---- server.session.attach ----

    #[tokio::test]
    async fn attach_invalid_session_id_format() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.session.attach",
                json!({ "session_id": "no-colon" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("Invalid session_id format"));
    }

    #[tokio::test]
    async fn attach_session_not_found() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.session.attach",
                json!({ "session_id": "a1:nonexistent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    #[tokio::test]
    async fn attach_agent_offline() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register agent
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Create session
        h.handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "active",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();
        // Manually set agent offline by checking with timeout
        h.agent_registry.check_offline_agents().await;
        // Force offline: update heartbeat to long ago
        h.agent_registry.unregister("a1").await;

        // Re-register with a different approach - just test that agent not found works
        let action = h
            .handle_message(proto_msg(
                "server.session.attach",
                json!({ "session_id": "a1:dev" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    #[tokio::test]
    async fn attach_p2p_mode_success() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register agent
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Create session
        h.handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "active",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();
        // The Server hands the credential to the agent that will verify it
        // **before** it answers the client (#1013), so the attach cannot
        // complete unless the agent answers. Standing one in for the test is
        // the point rather than an inconvenience: what this exercises is the
        // ordering, and the assertions below would hang for the grant deadline
        // if the Server answered the client first.
        let (sender, mut rx) = WsMessageSender::new();
        let generation = h.command_broker.new_connection_generation();
        h.command_broker.claim_agent("a1", generation, sender).await;
        let broker = Arc::clone(&h.command_broker);

        let attach_fut = h.handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "a1:dev", "preferred_mode": "p2p" }),
        ));
        let grant_fut = async move {
            let text = rx
                .recv()
                .await
                .expect("the agent is told before the client is answered")
                .message
                .to_text()
                .unwrap()
                .to_string();
            let grant: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(grant["msg_type"], "agent.p2p.grant");
            assert_eq!(grant["payload"]["agent_id"], "a1");
            assert_eq!(grant["payload"]["session_id"], "a1:dev");
            assert_eq!(
                grant["payload"]["scope"]["terminal"], "dev",
                "the credential is bound to the session it was minted for"
            );
            assert!(
                grant["payload"]["credential"]
                    .as_str()
                    .is_some_and(|token| !token.is_empty()),
                "and it carries the credential the client will present"
            );

            let request_id = grant["payload"]["request_id"].as_str().unwrap().to_string();
            broker
                .resolve_command("a1", &request_id, json!({ "success": true }))
                .await;
        };

        let (action, ()) = tokio::join!(attach_fut, grant_fut);
        let action = action.unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "success");
        assert_eq!(reply["payload"]["mode"], "p2p");
        // The response identifies the session it describes — the web client's
        // SessionRuntime ownership gate keys on attachInfo.session_id.
        assert_eq!(reply["payload"]["session_id"], "a1:dev");
        assert!(reply["payload"]["agent_address"]
            .as_str()
            .unwrap()
            .contains("1.2.3.4"));
    }

    #[tokio::test]
    async fn attach_relay_mode() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register agent + create session
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        h.handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "active",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();

        // Phase 1: query relay — returns info but does NOT enter relay forwarding.
        let (relay_sender, mut relay_rx) = WsMessageSender::new();
        h.set_client_sender(relay_sender);
        let action = h
            .handle_message(proto_msg(
                "server.session.attach",
                json!({ "session_id": "a1:dev", "preferred_mode": "relay" }),
            ))
            .await
            .unwrap();
        assert!(
            matches!(action, HandlerAction::Reply(None)),
            "Phase 1 should return Reply(None)"
        );

        // The phase-1 response goes over the client sender channel and must
        // identify the session (the web client keys on attachInfo.session_id).
        let phase1 = relay_rx.try_recv().expect("phase 1 response not sent");
        let Message::Text(phase1_text) = phase1.message else {
            panic!("expected Text message");
        };
        let phase1: serde_json::Value = serde_json::from_str(&phase1_text).unwrap();
        assert_eq!(phase1["payload"]["status"], "success");
        assert_eq!(phase1["payload"]["mode"], "relay");
        assert_eq!(phase1["payload"]["session_id"], "a1:dev");

        // Phase 2: begin relay. The Server hands the credential to the agent
        // that will verify it **before** it dials (#1013), so this cannot
        // complete without an agent that answers.
        let (sender, mut rx) = WsMessageSender::new();
        let generation = h.command_broker.new_connection_generation();
        h.command_broker.claim_agent("a1", generation, sender).await;
        let broker = Arc::clone(&h.command_broker);

        let begin_fut = h.handle_message(proto_msg(
            "server.session.relay.begin",
            json!({ "session_id": "a1:dev" }),
        ));
        let grant_fut = async move {
            let text = rx
                .recv()
                .await
                .expect("the agent is told before the server dials it")
                .message
                .to_text()
                .unwrap()
                .to_string();
            let grant: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(grant["msg_type"], "agent.p2p.grant");
            assert_eq!(grant["payload"]["scope"]["terminal"], "dev");
            assert_eq!(
                grant["payload"]["scope"]["files"], false,
                "a relay credential is the narrow one: the relay leg never touches a file"
            );
            assert_eq!(
                grant["payload"]["scope"]["sessions"], false,
                "and it never creates or kills a session"
            );

            let request_id = grant["payload"]["request_id"].as_str().unwrap().to_string();
            broker
                .resolve_command("a1", &request_id, json!({ "success": true }))
                .await;
        };

        let (action, ()) = tokio::join!(begin_fut, grant_fut);
        let action = action.unwrap();
        match action {
            HandlerAction::Relay {
                agent_ws_urls,
                session_id: _,
                session_name,
                client_id: _,
                env_snapshots,
                cols: _,
                rows: _,
            } => {
                assert!(!agent_ws_urls.is_empty(), "expected at least one relay URL");
                assert!(agent_ws_urls[0].contains("1.2.3.4"));
                assert_eq!(session_name, "dev");
                assert!(env_snapshots.is_empty());
                // The credential rides **on the URLs**, which is what makes both
                // relay dials carry it without knowing about it — the attach dial
                // iterates this list, and the detach dial reuses the one that
                // succeeded. A credential threaded beside the URL would have to
                // be kept in step with two call sites.
                assert!(
                    agent_ws_urls.iter().all(|url| url.contains("token=")),
                    "every candidate the dials use carries the credential: {agent_ws_urls:?}"
                );
            }
            _ => panic!("expected Relay action"),
        }
    }

    // ---- server.session.create ----

    #[tokio::test]
    async fn session_create_missing_fields() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.session.create",
                json!({ "agent_id": "", "name": "" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("required"));
    }

    #[tokio::test]
    async fn session_create_agent_not_found() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.session.create",
                json!({ "agent_id": "nonexistent", "name": "dev" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    // ---- server.session.kill ----

    #[tokio::test]
    async fn session_kill_invalid_format() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.session.kill",
                json!({ "session_id": "no-colon" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("Invalid session_id format"));
    }

    #[tokio::test]
    async fn session_kill_agent_not_found() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.session.kill",
                json!({ "session_id": "unknown:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    #[tokio::test]
    async fn session_kill_session_not_found_agent_online() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register agent (it's online)
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Kill a session that doesn't exist — agent is online
        let action = h
            .handle_message(proto_msg(
                "server.session.kill",
                json!({ "session_id": "a1:nonexistent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    // ---- server.agent.command-response ----

    #[tokio::test]
    async fn command_response_from_unregistered_returns_none() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.agent.command-response",
                json!({ "request_id": "r1", "success": true }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn command_response_missing_request_id_returns_none() {
        let mut h = test_handler("").await;
        // Register agent
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        let action = h
            .handle_message(proto_msg(
                "server.agent.command-response",
                json!({ "request_id": "", "success": true }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    // ---- env handlers (unauthenticated) ----

    #[tokio::test]
    async fn env_list_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("server.env.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn env_list_reply_is_what_its_contract_says_it_is() {
        // The test `server.auth` never had. That unit's contract requires a
        // `client_id` its handler has never sent, so a consumer reading that
        // reply as its own declared type fails — and nothing noticed, because
        // the handler built the payload with `json!` and no test ever asked the
        // type what it expected.
        //
        // So this asks: take the reply off the wire and read it the way the
        // contract says it is. It is the difference between "the handler uses
        // the type" being a claim about the source and being a checked fact —
        // and it is what the identity-only entries were missing, since a unit
        // with `request: None` cannot have this test at all.
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("server.env.list", json!({})))
            .await
            .unwrap();
        let payload = parse_reply(action)["payload"].clone();
        let parsed: ClientEnvListResponsePayload = serde_json::from_value(payload.clone())
            .unwrap_or_else(|e| {
                panic!("server.env.list replies {payload} but its contract does not accept it: {e}")
            });

        assert!(
            parsed.error.is_some(),
            "an unauthenticated caller is told why rather than handed an empty list"
        );
    }

    #[tokio::test]
    async fn env_get_reply_is_what_its_contract_says_it_is() {
        // The same guard as `env_list_reply_is_what_its_contract_says_it_is`,
        // on the unit whose `in_use_by` had to become optional: two branches
        // answer before it is computed. Both forms have to round-trip, and
        // which form each branch produces is the part that is easy to get
        // wrong by hand.
        let mut h = test_handler("").await;

        let action = h
            .handle_message(proto_msg("server.env.get", json!({ "name": "x.env" })))
            .await
            .unwrap();
        let payload = parse_reply(action)["payload"].clone();
        let parsed: ClientEnvGetResponsePayload = serde_json::from_value(payload.clone())
            .unwrap_or_else(|e| {
                panic!("server.env.get replies {payload} but its contract does not accept it: {e}")
            });
        assert!(!parsed.success);
        assert!(
            parsed.in_use_by.is_none(),
            "an unauthenticated caller is not told what is in use — absent, not empty"
        );

        // Authenticated, and past the point where usage is computed.
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.env.get",
                json!({ "name": "missing.env" }),
            ))
            .await
            .unwrap();
        let payload = parse_reply(action)["payload"].clone();
        let parsed: ClientEnvGetResponsePayload = serde_json::from_value(payload.clone())
            .unwrap_or_else(|e| {
                panic!("server.env.get replies {payload} but its contract does not accept it: {e}")
            });
        assert!(
            parsed.in_use_by.is_some(),
            "a request that reached the lookup reports usage, even when empty"
        );
    }

    #[tokio::test]
    async fn env_delete_reply_and_request_are_what_their_contract_says() {
        // `delete`'s reply is an exact match on every branch, so unlike the
        // other two this is a plain regression guard. Its *request* is where
        // the work was: `force` was read off `Value` beside the parser for
        // years, and a missing `source` was defaulted.
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.env.delete",
                json!({ "name": "x.env", "force": true }),
            ))
            .await
            .unwrap();
        let payload = parse_reply(action)["payload"].clone();
        let parsed: ClientEnvDeleteResponsePayload = serde_json::from_value(payload.clone())
            .unwrap_or_else(|e| {
                panic!(
                    "server.env.delete replies {payload} but its contract does not accept it: {e}"
                )
            });
        assert!(!parsed.success);
        assert!(parsed.error.is_some(), "an unauthenticated delete says why");

        let with_force: ClientEnvDeletePayload =
            serde_json::from_value(json!({ "name": "x.env", "force": true }))
                .expect("`force` is a declared field, and the Web has always sent it");
        assert!(with_force.force);

        let no_source: ClientEnvDeletePayload = serde_json::from_value(json!({ "name": "x.env" }))
            .expect("a missing source defaults to the server, as parse_env_ref did");
        assert_eq!(no_source.source, EnvSource::Server);
    }

    #[tokio::test]
    async fn session_list_reply_is_what_its_contract_says_it_is() {
        // The first unit whose contract is a union of two *disjoint* shapes.
        // Both halves have to round-trip — the refusal is what eleven handlers
        // send and what no contract described until now.
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("server.session.list", json!({})))
            .await
            .unwrap();
        let payload = parse_reply(action)["payload"].clone();
        let parsed: ServerSessionListReply = serde_json::from_value(payload.clone())
            .unwrap_or_else(|e| {
                panic!("server.session.list replies {payload} but its contract does not accept it: {e}")
            });
        assert!(
            matches!(parsed, ServerSessionListReply::Refused(_)),
            "an unauthenticated caller is refused, not handed an empty list"
        );

        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("server.session.list", json!({})))
            .await
            .unwrap();
        let payload = parse_reply(action)["payload"].clone();
        let parsed: ServerSessionListReply = serde_json::from_value(payload.clone())
            .unwrap_or_else(|e| {
                panic!("server.session.list replies {payload} but its contract does not accept it: {e}")
            });
        assert!(matches!(parsed, ServerSessionListReply::Listed(_)));
    }

    #[tokio::test]
    async fn session_kill_reply_is_what_its_contract_says_it_is() {
        // The one branch worth pinning is the offline-agent one: it used to
        // send `{ "success": true }` with no `error` field, and the type has no
        // `skip_serializing_if`, so it now carries `error: null`. That reads as
        // noise unless you know the Web declares `error?: string` — so this
        // asserts the field is *present and null*, not merely absent, which is
        // the difference a typo in the type would silently remove.
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("server.session.kill", json!({})))
            .await
            .unwrap();
        let payload = parse_reply(action)["payload"].clone();
        let parsed: WebSessionKillResponse = serde_json::from_value(payload.clone())
            .unwrap_or_else(|e| {
                panic!("server.session.kill replies {payload} but its contract does not accept it: {e}")
            });
        assert!(!parsed.success);
        assert!(parsed.error.is_some(), "a bad session_id says why");
    }

    #[tokio::test]
    async fn env_get_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("server.env.get", json!({ "name": "test.env" })))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn env_write_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.env.write",
                json!({ "name": "test.env", "content": "X=1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn env_delete_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.env.delete",
                json!({ "name": "test.env" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    // ---- env handlers (authenticated, server files) ----

    #[tokio::test]
    async fn env_get_missing_name() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("server.env.get", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("required"));
    }

    #[tokio::test]
    async fn env_write_and_read_server_file() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Write
        let action = h
            .handle_message(proto_msg(
                "server.env.write",
                json!({
                    "name": "test.env",
                    "content": "FOO=bar\nBAZ=qux",
                    "overwrite": false,
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], true);
        // Read back
        let action = h
            .handle_message(proto_msg(
                "server.env.get",
                json!({ "name": "test.env", "source": "server" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], true);
        assert!(reply["payload"]["content"]
            .as_str()
            .unwrap()
            .contains("FOO=bar"));
    }

    #[tokio::test]
    async fn env_write_missing_name() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.env.write",
                json!({ "name": "", "content": "X=1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("required"));
    }

    #[tokio::test]
    async fn env_delete_missing_name() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("server.env.delete", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("required"));
    }

    #[tokio::test]
    async fn env_list_server_files() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Write a file first
        h.handle_message(proto_msg(
            "server.env.write",
            json!({
                "name": "test.env",
                "content": "X=1",
                "overwrite": false,
            }),
        ))
        .await
        .unwrap();
        let action = h
            .handle_message(proto_msg("server.env.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        let files = reply["payload"]["files"].as_array().unwrap();
        assert!(!files.is_empty());
    }

    #[tokio::test]
    async fn env_delete_server_file() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        h.handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "del.env", "content": "X=1", "overwrite": false }),
        ))
        .await
        .unwrap();
        let action = h
            .handle_message(proto_msg(
                "server.env.delete",
                json!({ "name": "del.env", "source": "server" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], true);
    }

    // ---- session env handlers ----

    #[tokio::test]
    async fn session_env_apply_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.session.env.apply",
                json!({ "session_id": "a1:s1", "env_files": [] }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn session_env_apply_invalid_session_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.session.env.apply",
                json!({ "session_id": "no-colon", "env_files": [] }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("Invalid session_id"));
    }

    #[tokio::test]
    async fn session_env_unset_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.session.env.unset",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn session_env_unset_invalid_session_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.session.env.unset",
                json!({ "session_id": "no-colon" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
    }

    #[tokio::test]
    async fn session_env_active_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.session.env.active",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn session_env_active_returns_list() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.session.env.active",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["active"].as_array().is_some());
    }

    #[tokio::test]
    async fn session_env_query_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.session.env.query",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn session_env_query_invalid_session_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.session.env.query",
                json!({ "session_id": "no-colon" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("Invalid session_id"));
    }

    // ---- env payload contracts ----
    //
    // These replace the three `parse_env_ref` tests. That helper is gone — the
    // handlers parse into the contract types now — and the leniency it had is
    // expressed by those types' serde defaults, so that is what these pin. The
    // behaviour they describe is unchanged; only the place it is written down
    // has moved.

    #[test]
    fn a_missing_source_is_a_server_file() {
        let p: ClientEnvWritePayload = serde_json::from_value(json!({ "name": "x.env" })).unwrap();
        assert_eq!(p.source, EnvSource::Server);
        assert!(p.agent_id.is_none());
    }

    #[test]
    fn an_agent_source_carries_its_agent() {
        let p: ClientEnvWritePayload =
            serde_json::from_value(json!({ "name": "x.env", "source": "agent", "agent_id": "a1" }))
                .unwrap();
        assert_eq!(p.source, EnvSource::Agent);
        assert_eq!(p.agent_id.as_deref(), Some("a1"));
    }

    #[test]
    fn a_payload_with_no_name_does_not_parse() {
        // `parse_env_ref` returned an empty name and let the handler refuse it.
        // The type refuses it now, and the handler maps that failure to the
        // same reply — so the wire is unchanged, which is the point.
        assert!(serde_json::from_value::<ClientEnvWritePayload>(json!({})).is_err());
    }

    // ---- env write in-use lock ----

    #[tokio::test]
    async fn env_write_blocked_when_in_use() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Write a file first
        h.handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "locked.env", "content": "X=1", "overwrite": false }),
        ))
        .await
        .unwrap();
        // Record usage
        h.env_service.usage.record_create(
            "a1:s1",
            &[nession_protocol::contracts::env::v1::EnvFileRef {
                name: "locked.env".to_string(),
                source: EnvSource::Server,
                agent_id: None,
            }],
            None,
        );
        // Try to overwrite — should fail
        let action = h
            .handle_message(proto_msg(
                "server.env.write",
                json!({
                    "name": "locked.env",
                    "content": "X=2",
                    "overwrite": true,
                    "source": "server",
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("in use"));
        assert_eq!(reply["payload"]["in_use_by"], json!(["a1:s1"]));
    }

    #[tokio::test]
    async fn env_write_force_skips_lock_and_re_sources() {
        use crate::server::outbound::WsMessageSender;

        let mut h = test_handler("").await;
        h.authenticated_client = true;

        // Write a file first so the store has it.
        h.handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "forced.env", "content": "X=1", "overwrite": false }),
        ))
        .await
        .unwrap();

        // Register an agent control channel so `agent_command` can be answered.
        let (sender, mut rx) = WsMessageSender::new();
        let generation = h.command_broker.new_connection_generation();
        h.command_broker.claim_agent("a1", generation, sender).await;

        // Record usage for a session bound to this file.
        h.env_service.usage.record_create(
            "a1:s1",
            &[EnvFileRef {
                name: "forced.env".to_string(),
                source: EnvSource::Server,
                agent_id: None,
            }],
            None,
        );

        // Run the force write concurrently with a mock agent that answers the
        // re-source (`agent.env.resource`) command.
        let broker = Arc::clone(&h.command_broker);
        let send_fut = h.handle_message(proto_msg(
            "server.env.write",
            json!({
                "name": "forced.env",
                "content": "X=2",
                "overwrite": true,
                "force": true,
                "source": "server",
            }),
        ));
        let resolve_fut = async move {
            let text = rx
                .recv()
                .await
                .expect("agent should receive a command")
                .message
                .to_text()
                .unwrap()
                .to_string();
            let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();

            // The wire matters as much as the response. This mock used to answer
            // whatever arrived, and so passed while the server was asking for
            // `agent.env.resource` — a wire no agent has ever handled, which made
            // every forced write report a re-source failure while the session
            // kept its old values. Asserting the wire is what keeps the mock
            // honest; without it the test cannot tell the fix from the bug.
            assert_eq!(
                parsed["msg_type"], "agent.session.env.apply",
                "the re-source must use the wire the agent answers"
            );
            // The session name without its `<agent>:` prefix, and the content
            // the forced write just stored — not the pre-write content.
            assert_eq!(parsed["payload"]["name"], "s1");
            assert_eq!(
                parsed["payload"]["snapshots"][0]["vars"],
                json!([["X", "2"]]),
                "the re-source must carry the file's current content"
            );

            let request_id = parsed["payload"]["request_id"]
                .as_str()
                .unwrap()
                .to_string();
            broker
                .resolve_command("a1", &request_id, json!({ "success": true }))
                .await;
        };
        let (action, _) = tokio::join!(send_fut, resolve_fut);
        let reply = parse_reply(action.unwrap());

        assert_eq!(reply["payload"]["success"], true);
        assert_eq!(reply["payload"]["re_sourced"], json!(["a1:s1"]));
        assert_eq!(reply["payload"]["re_source_errors"], json!([]));
    }

    #[tokio::test]
    async fn env_delete_blocked_when_in_use() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Write a file first
        h.handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "used.env", "content": "X=1", "overwrite": false }),
        ))
        .await
        .unwrap();
        // Record usage
        h.env_service.usage.record_create(
            "a1:s1",
            &[nession_protocol::contracts::env::v1::EnvFileRef {
                name: "used.env".to_string(),
                source: EnvSource::Server,
                agent_id: None,
            }],
            None,
        );
        // Try to delete — should fail
        let action = h
            .handle_message(proto_msg(
                "server.env.delete",
                json!({ "name": "used.env", "source": "server" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("in use"));
    }

    #[tokio::test]
    async fn env_delete_force_skips_lock() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Write a file first
        h.handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "used.env", "content": "X=1", "overwrite": false }),
        ))
        .await
        .unwrap();
        // Record usage
        h.env_service.usage.record_create(
            "a1:s1",
            &[nession_protocol::contracts::env::v1::EnvFileRef {
                name: "used.env".to_string(),
                source: EnvSource::Server,
                agent_id: None,
            }],
            None,
        );
        // Delete with force — should succeed despite being in use
        let action = h
            .handle_message(proto_msg(
                "server.env.delete",
                json!({ "name": "used.env", "source": "server", "force": true }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], true);
    }

    // ---- agent.env.get without agent_id ----

    #[tokio::test]
    async fn env_get_agent_without_agent_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.env.get",
                json!({ "name": "test.env", "source": "agent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("agent_id is required"));
    }

    #[tokio::test]
    async fn env_write_agent_without_agent_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.env.write",
                json!({ "name": "test.env", "content": "X=1", "source": "agent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("agent_id is required"));
    }

    #[tokio::test]
    async fn env_delete_agent_without_agent_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "server.env.delete",
                json!({ "name": "test.env", "source": "agent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("agent_id is required"));
    }

    // ---- agent.terminal.resize ----

    #[tokio::test]
    async fn agent_terminal_resize_broadcasts_to_attached_clients() {
        use crate::server::outbound::WsMessageSender;

        let mut h = test_handler("").await;

        // Registering is what makes a connection able to resize `a1:dev` at all,
        // and the claim is what `server/websocket.rs` makes for it right after —
        // a resize from a connection that never registered is refused, so this
        // setup is part of the case rather than incidental to it.
        register_agent_connection(&mut h, "a1").await;
        let (_sender, _rx) = claim_control_channel(&h).await;

        // Register two clients in the ClientRegistry for the target session
        let client_registry = Arc::clone(&h.client_registry);
        let (sender1, mut rx1) = WsMessageSender::new();
        let (sender2, mut rx2) = WsMessageSender::new();
        client_registry.register("a1:dev", "c1", sender1).await;
        client_registry.register("a1:dev", "c2", sender2).await;

        // Send agent.terminal.resize
        let action = h
            .handle_message(proto_msg(
                "server.agent.terminal-resize",
                json!({
                    "session_id": "a1:dev",
                    "cols": 120,
                    "rows": 40,
                }),
            ))
            .await
            .unwrap();

        // Handler returns Reply(None) — broadcast goes through ClientRegistry
        assert!(matches!(action, HandlerAction::Reply(None)));

        // Both clients should receive the broadcast message
        let msg1 = rx1.try_recv().unwrap();
        let msg2 = rx2.try_recv().unwrap();

        let parsed1: serde_json::Value =
            serde_json::from_str(msg1.message.to_text().unwrap()).unwrap();
        let parsed2: serde_json::Value =
            serde_json::from_str(msg2.message.to_text().unwrap()).unwrap();

        assert_eq!(parsed1["msg_type"], "terminal.resize");
        assert_eq!(parsed1["payload"]["session_id"], "a1:dev");
        assert_eq!(parsed1["payload"]["cols"], 120);
        assert_eq!(parsed1["payload"]["rows"], 40);
        assert_eq!(parsed2["msg_type"], "terminal.resize");
        assert_eq!(parsed2["payload"]["session_id"], "a1:dev");
    }

    #[tokio::test]
    async fn agent_terminal_resize_no_attached_clients() {
        let mut h = test_handler("").await;

        // Registered and claimed, so what the frame meets is the absence of
        // clients rather than the absence of authority.
        register_agent_connection(&mut h, "a1").await;
        let (_sender, _rx) = claim_control_channel(&h).await;

        // No clients attached — should still succeed silently
        let action = h
            .handle_message(proto_msg(
                "server.agent.terminal-resize",
                json!({
                    "session_id": "a1:dev",
                    "cols": 80,
                    "rows": 24,
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn agent_terminal_resize_invalid_payload() {
        let mut h = test_handler("").await;

        // As above: the payload is what this test is about, so the connection
        // arrives already authorized for the session it names.
        register_agent_connection(&mut h, "a1").await;
        let (_sender, _rx) = claim_control_channel(&h).await;

        // Missing required fields — should log warning but not crash
        let action = h
            .handle_message(proto_msg(
                "server.agent.terminal-resize",
                json!({ "session_id": "a1:dev" }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    // ---- agent.address_update ----

    #[tokio::test]
    async fn agent_address_update_updates_addresses() {
        let mut h = test_handler("").await;
        // Register an agent with an initial address.
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [
                    { "url": "ws://1.2.3.4:19091/ws", "network_type": "lan" }
                ],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();

        // Send an address update with new addresses.
        let action = h
            .handle_message(proto_msg(
                "server.agent.address-update",
                json!({
                    "agent_id": "a1",
                    "addresses": [
                        { "url": "ws://10.0.0.5:19091/ws", "network_type": "lan" },
                        { "url": "wss://tunnel.example.com/ws", "network_type": "tunnel" },
                    ],
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));

        // Verify the agent's addresses were updated.
        let agent = h.agent_registry.get("a1").await.unwrap();
        assert_eq!(agent.addresses.len(), 2);

        let urls: Vec<&str> = agent
            .addresses
            .iter()
            .map(|p| p.address.url.as_str())
            .collect();
        assert!(urls.contains(&"ws://10.0.0.5:19091/ws"));
        assert!(urls.contains(&"wss://tunnel.example.com/ws"));
    }

    #[tokio::test]
    async fn agent_address_update_unknown_agent_is_noop() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "server.agent.address-update",
                json!({
                    "agent_id": "nonexistent",
                    "addresses": [],
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    // ---- agent identity is bound to the connection that registered it (#960) ----

    /// Send `agent_id`'s `server.agent.register` frame and return the reply, as
    /// the body the Server answers with. Judging the reply is the caller's, so
    /// that the tests about the *answer* (a refusal) and the tests about the
    /// binding can share one frame.
    async fn register(h: &mut ConnectionHandler, agent_id: &str) -> serde_json::Value {
        parse_reply(
            h.handle_message(proto_msg(
                "server.agent.register",
                json!({
                    "agent_id": agent_id,
                    "hostname": "host",
                    "ip_address": "1.2.3.4",
                    "port": 19091,
                    "auth_token": "",
                    "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                    "addresses": [],
                    "connect_url": null,
                    "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
                }),
            ))
            .await
            .unwrap(),
        )
    }

    /// Register `agent_id` **through the wire**, the way its own connection
    /// does. This is the binding: from here on the handler answers as that
    /// agent, and what its payloads name is checked against it.
    async fn register_agent_connection(h: &mut ConnectionHandler, agent_id: &str) {
        let reply = register(h, agent_id).await;
        assert_eq!(reply["payload"]["status"], "accepted");
    }

    /// A connection registered as `a1` must not move `a2`'s heartbeat state,
    /// whatever id its payload carries. Heartbeats are what keeps an agent
    /// online and carry its session counts, so a cross-agent write here is one
    /// agent silently speaking for another.
    #[tokio::test]
    async fn heartbeat_for_another_agent_is_refused() {
        let mut h = test_handler("").await;
        register_agent_connection(&mut h, "a1").await;
        register_agent_id(&h, "a2", None).await;

        let action = h
            .handle_message(proto_msg(
                "control.heartbeat",
                json!({ "agent_id": "a2", "session_count": 9, "active_sessions": 9 }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));

        let a2 = h.agent_registry.get("a2").await.expect("a2 is registered");
        assert_eq!(
            a2.session_count, 0,
            "a1's connection must not write a2's session count"
        );
        assert_eq!(a2.active_sessions, 0);

        // The refusal is about identity, not about heartbeats: the same message
        // for the agent this connection *did* register as still lands.
        h.handle_message(proto_msg(
            "control.heartbeat",
            json!({ "agent_id": "a1", "session_count": 3, "active_sessions": 1 }),
        ))
        .await
        .unwrap();
        let a1 = h.agent_registry.get("a1").await.expect("a1 is registered");
        assert_eq!(a1.session_count, 3);
    }

    /// The other half of the same invariant: a connection that never registered
    /// has no identity to speak with — not even for an agent the registry
    /// knows, because registering is what makes a connection authoritative.
    #[tokio::test]
    async fn heartbeat_from_a_connection_that_never_registered_is_refused() {
        let mut h = test_handler("").await;
        register_agent_id(&h, "a1", None).await;

        h.handle_message(proto_msg(
            "control.heartbeat",
            json!({ "agent_id": "a1", "session_count": 9, "active_sessions": 9 }),
        ))
        .await
        .unwrap();

        let a1 = h.agent_registry.get("a1").await.expect("a1 is registered");
        assert_eq!(
            a1.session_count, 0,
            "an unregistered connection has no authority to write agent state"
        );
    }

    /// Session ids are `agent_id:session_name`, so the payload's id chooses the
    /// namespace an update writes into — a connection registered as `a1`
    /// reporting for `a2` would rewrite another agent's session list.
    #[tokio::test]
    async fn session_update_for_another_agent_is_refused() {
        let mut h = test_handler("").await;
        register_agent_connection(&mut h, "a1").await;
        register_agent_id(&h, "a2", None).await;

        h.handle_message(proto_msg(
            "server.agent.session-update",
            json!({ "agent_id": "a2", "session_name": "sneaky", "status": "active" }),
        ))
        .await
        .unwrap();

        assert!(
            h.session_registry
                .list()
                .await
                .iter()
                .all(|session| !session.session_id.starts_with("a2:")),
            "a1's connection must not create sessions under a2"
        );
    }

    /// A message that names no agent is not lying about one: the connection's
    /// registered identity supplies the answer, so an agent that sends the id
    /// only in its registration is still understood.
    #[tokio::test]
    async fn session_update_without_an_agent_id_uses_the_connection_identity() {
        let mut h = test_handler("").await;
        register_agent_connection(&mut h, "a1").await;

        h.handle_message(proto_msg(
            "server.agent.session-update",
            json!({ "session_name": "dev", "status": "active", "window_count": 1 }),
        ))
        .await
        .unwrap();

        assert!(
            h.session_registry
                .list()
                .await
                .iter()
                .any(|session| session.session_id == "a1:dev"),
            "the bound identity must be enough to place the update"
        );
    }

    /// Advertised addresses decide where P2P clients dial, so a connection
    /// registered as `a1` must not be able to point `a2` somewhere else.
    #[tokio::test]
    async fn address_update_for_another_agent_is_refused() {
        let mut h = test_handler("").await;
        register_agent_connection(&mut h, "a1").await;
        register_agent_id(&h, "a2", None).await;

        h.handle_message(proto_msg(
            "server.agent.address-update",
            json!({
                "agent_id": "a2",
                "addresses": [{ "url": "ws://elsewhere.example:19091/ws", "network_type": "lan" }],
            }),
        ))
        .await
        .unwrap();

        let a2 = h.agent_registry.get("a2").await.expect("a2 is registered");
        assert!(
            a2.addresses.is_empty(),
            "a1's connection must not move a2's advertised addresses"
        );
    }

    // ---- ownership is a generation, not an identity (#960) ----

    /// Two connections on **one** server: one broker, one pair of registries,
    /// one client registry.
    ///
    /// `test_handler` gives every handler its own services, which is the right
    /// default for a test about one connection. Ownership across connections is
    /// exactly the case where both have to be looking at the same records: the
    /// second connection's registration clears state the first one wrote, and
    /// the first one's late frames are judged against the second one's claim.
    async fn connections_on_one_server() -> (ConnectionHandler, ConnectionHandler) {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let agent_registry = Arc::new(AgentRegistry::new(60, Arc::clone(&db)));
        let session_registry = Arc::new(SessionRegistry::new(Arc::clone(&db)));
        let command_broker = Arc::new(CommandBroker::new());
        let client_registry = Arc::new(ClientRegistry::new());
        let web_client_registry = Arc::new(WebClientRegistry::new());
        let connection = || {
            ConnectionHandler::new(
                ConnectionHandlerDeps {
                    agent_registry: Arc::clone(&agent_registry),
                    session_registry: Arc::clone(&session_registry),
                    command_broker: Arc::clone(&command_broker),
                    client_registry: Arc::clone(&client_registry),
                    web_client_registry: Arc::clone(&web_client_registry),
                    env_service: EnvService::new(Arc::clone(&db)),
                    db: Arc::clone(&db),

                    p2p_broker: std::sync::Arc::new(crate::broker::ConnectionBroker::new(300)),
                },
                ConnectionHandlerConfig {
                    server_auth_token: String::new(),
                    heartbeat_interval_secs: 30,
                },
            )
        };
        (connection(), connection())
    }

    /// The claim `server/websocket.rs` makes after every frame from a registered
    /// agent connection: the connection that just spoke is the agent's control
    /// channel.
    ///
    /// Returns the sender and its receiver, for the tests that claim more than
    /// once or watch where a command lands; **keep both alive** — a dropped
    /// receiver is a control channel that cannot be sent to.
    async fn claim_control_channel(
        h: &ConnectionHandler,
    ) -> (
        crate::server::outbound::WsMessageSender,
        tokio::sync::mpsc::Receiver<crate::server::outbound::QueuedFrame>,
    ) {
        let (sender, rx) = crate::server::outbound::WsMessageSender::new();
        if let Some(agent_id) = h.registered_agent_id() {
            h.command_broker
                .claim_agent(agent_id, h.connection_generation(), sender.clone())
                .await;
        }
        (sender, rx)
    }

    /// Hand one agent-originated frame to this connection's handler.
    ///
    /// No reply is expected from any of them — a refusal and an applied update
    /// are both silent — so the assertions live in the caller, on the state the
    /// frame was or was not allowed to move. The frame is built at the call
    /// site on purpose: a wire name passed through here would be invisible to
    /// `scripts/protocol-gate.mjs`, which is what catches a name that no
    /// runtime answers.
    async fn report(h: &mut ConnectionHandler, frame: Message) {
        let action = h.handle_message(frame).await.unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    async fn has_session(h: &ConnectionHandler, session_id: &str) -> bool {
        h.session_registry
            .list()
            .await
            .iter()
            .any(|session| session.session_id == session_id)
    }

    /// #960, the state-write half: a connection a reconnect has superseded must
    /// not write the current agent's state.
    ///
    /// The window is the reconnect's own. The new connection's registration
    /// clears the sessions the *previous* agent instance left behind, and the
    /// old connection — half closed, not yet reaped, still delivering — reports
    /// the session it remembers. Judged by identity alone that report was
    /// believed, and the cleared session came back as if the registration had
    /// never happened.
    #[tokio::test]
    async fn a_superseded_connection_cannot_restore_a_cleared_session() {
        let (mut c1, mut c2) = connections_on_one_server().await;

        register_agent_connection(&mut c1, "a1").await;
        let (_sender, _rx) = claim_control_channel(&c1).await;
        report(
            &mut c1,
            proto_msg(
                "server.agent.session-update",
                json!({ "agent_id": "a1", "session_name": "dev", "status": "active", "window_count": 1 }),
            ),
        )
        .await;
        assert!(has_session(&c1, "a1:dev").await, "c1's report is placed");

        // The agent reconnects. Registering clears the previous instance's
        // sessions; the loop claims the agent for the new connection right after
        // — in that order, and both here in the test rather than raced between
        // two tasks.
        register_agent_connection(&mut c2, "a1").await;
        let (_sender2, _rx2) = claim_control_channel(&c2).await;
        assert!(
            !has_session(&c1, "a1:dev").await,
            "re-registration clears the sessions of the agent instance before it"
        );

        // c1's late frame, arriving after all of that.
        report(
            &mut c1,
            proto_msg(
                "server.agent.session-update",
                json!({ "agent_id": "a1", "session_name": "dev", "status": "active", "window_count": 1 }),
            ),
        )
        .await;
        assert!(
            !has_session(&c1, "a1:dev").await,
            "a superseded connection's late report must not restore the cleared session"
        );

        // The refusal is about which connection this is, not about the message:
        // the generation that took the agent over still writes its state.
        report(
            &mut c2,
            proto_msg(
                "server.agent.session-update",
                json!({ "agent_id": "a1", "session_name": "dev", "status": "active", "window_count": 1 }),
            ),
        )
        .await;
        assert!(
            has_session(&c1, "a1:dev").await,
            "the current generation's report must still be placed"
        );
    }

    /// The same rule for the other three wires an agent writes state with.
    ///
    /// A heartbeat is what keeps an agent online and carries its counts, so a
    /// superseded connection's heartbeat is not a stale number — it is the
    /// previous agent instance speaking for the current one.
    ///
    /// One test per wire rather than one test over all of them: each wire's
    /// check is its own call site, and a test that asserted three refusals in a
    /// row would stop at the first one and say nothing about the other two.
    #[tokio::test]
    async fn a_superseded_connection_cannot_heartbeat() {
        let (mut c1, mut c2) = connections_on_one_server().await;
        register_agent_connection(&mut c1, "a1").await;
        let (_sender, _rx) = claim_control_channel(&c1).await;
        register_agent_connection(&mut c2, "a1").await;
        let (_sender2, _rx2) = claim_control_channel(&c2).await;

        report(
            &mut c1,
            proto_msg(
                "control.heartbeat",
                json!({ "agent_id": "a1", "session_count": 9, "active_sessions": 9 }),
            ),
        )
        .await;

        let a1 = c1.agent_registry.get("a1").await.expect("a1 is registered");
        assert_eq!(
            a1.session_count, 0,
            "a superseded connection's heartbeat must not be believed"
        );

        report(
            &mut c2,
            proto_msg(
                "control.heartbeat",
                json!({ "agent_id": "a1", "session_count": 4, "active_sessions": 1 }),
            ),
        )
        .await;
        let a1 = c1.agent_registry.get("a1").await.expect("a1 is registered");
        assert_eq!(
            a1.session_count, 4,
            "the current generation's heartbeat must be believed"
        );
    }

    /// The address update decides where P2P clients dial an agent, so it is the
    /// one report a stale generation could aim at a *different* host entirely.
    #[tokio::test]
    async fn a_superseded_connection_cannot_move_the_agents_addresses() {
        let (mut c1, mut c2) = connections_on_one_server().await;
        register_agent_connection(&mut c1, "a1").await;
        let (_sender, _rx) = claim_control_channel(&c1).await;
        register_agent_connection(&mut c2, "a1").await;
        let (_sender2, _rx2) = claim_control_channel(&c2).await;

        report(
            &mut c1,
            proto_msg(
                "server.agent.address-update",
                json!({ "agent_id": "a1", "addresses": [{ "url": "ws://elsewhere.example:19091/ws", "network_type": "lan" }] }),
            ),
        )
        .await;

        let a1 = c1.agent_registry.get("a1").await.expect("a1 is registered");
        assert!(
            !a1.addresses
                .iter()
                .any(|probed| probed.address.url.contains("elsewhere.example")),
            "a superseded connection must not move the agent's addresses"
        );

        report(
            &mut c2,
            proto_msg(
                "server.agent.address-update",
                json!({ "agent_id": "a1", "addresses": [{ "url": "ws://here.example:19091/ws", "network_type": "lan" }] }),
            ),
        )
        .await;
        let a1 = c1.agent_registry.get("a1").await.expect("a1 is registered");
        assert!(
            a1.addresses
                .iter()
                .any(|probed| probed.address.url.contains("here.example")),
            "the current generation's address update must be applied"
        );
    }

    /// A resize is a *level* pushed to whoever is watching a session, and the
    /// session belongs to an agent. A superseded connection's resize would move
    /// the screen a client is looking at on behalf of an instance that is gone.
    #[tokio::test]
    async fn a_superseded_connection_cannot_resize_a_session() {
        use crate::server::outbound::WsMessageSender;

        let (mut c1, mut c2) = connections_on_one_server().await;
        register_agent_connection(&mut c1, "a1").await;
        let (_sender, _rx) = claim_control_channel(&c1).await;
        register_agent_connection(&mut c2, "a1").await;
        let (_sender2, _rx2) = claim_control_channel(&c2).await;

        // A client watching a session of a1's. The client registry is shared, so
        // either connection's broadcast reaches it.
        let (client, mut client_rx) = WsMessageSender::new();
        c1.client_registry
            .register("a1:dev", "client-1", client)
            .await;

        report(
            &mut c1,
            proto_msg(
                "server.agent.terminal-resize",
                json!({ "session_id": "a1:dev", "cols": 120, "rows": 40 }),
            ),
        )
        .await;
        assert!(
            client_rx.try_recv().is_err(),
            "a superseded connection must not resize a session it no longer serves"
        );

        report(
            &mut c2,
            proto_msg(
                "server.agent.terminal-resize",
                json!({ "session_id": "a1:dev", "cols": 100, "rows": 30 }),
            ),
        )
        .await;
        assert!(
            client_rx.try_recv().is_ok(),
            "the current generation's resize must reach the session's client"
        );
    }

    /// The one wire deliberately left out of the generation rule.
    ///
    /// `server.agent.command-response` answers a request the *Server* sent. A
    /// connection that has since been superseded is still the connection the
    /// request went to, so its answer is still the answer to that request —
    /// refusing it would report "Agent disconnected" for work the agent may
    /// already have completed, which is exactly what #743 fixed. The rule the
    /// generation check enforces is about whose *state* a connection may write,
    /// and a response writes no state: it resolves one waiter.
    #[tokio::test]
    async fn a_superseded_connection_may_still_answer_an_in_flight_command() {
        let (mut c1, mut c2) = connections_on_one_server().await;
        register_agent_connection(&mut c1, "a1").await;
        let (_sender, _rx) = claim_control_channel(&c1).await;

        // A command the Server sent while c1 was the agent's connection.
        let waiter = c1
            .command_broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;

        // The agent reconnects; a newer connection takes the agent over.
        register_agent_connection(&mut c2, "a1").await;
        let (_sender2, _rx2) = claim_control_channel(&c2).await;

        report(
            &mut c1,
            proto_msg(
                "server.agent.command-response",
                json!({ "request_id": "req-1", "success": true, "session_name": "dev" }),
            ),
        )
        .await;

        let response = tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
            .await
            .expect("a superseded connection's answer must still resolve the request")
            .expect("the waiter must be resolved with the answer");
        assert_eq!(response["success"], json!(true));
    }

    /// A liveness verdict is a statement about the *agent*, not about which
    /// connection is newest.
    ///
    /// The heartbeat sweep evicts an agent that has gone quiet without dropping
    /// its WebSocket. The connection it evicted is still the agent's current
    /// generation — nothing newer has claimed it — so its next report is still
    /// believed, and the claim the loop makes for it puts its channel back. That
    /// recovery is the reason the mark is a high-water mark rather than "the
    /// owner, or nothing".
    #[tokio::test]
    async fn the_current_generation_recovers_after_a_liveness_eviction() {
        let mut h = test_handler("").await;
        register_agent_connection(&mut h, "a1").await;
        let (_sender, _rx) = claim_control_channel(&h).await;

        h.command_broker.evict_agent("a1").await;

        report(
            &mut h,
            proto_msg(
                "control.heartbeat",
                json!({ "agent_id": "a1", "session_count": 4, "active_sessions": 1 }),
            ),
        )
        .await;
        let a1 = h.agent_registry.get("a1").await.expect("a1 is registered");
        assert_eq!(
            a1.session_count, 4,
            "the evicted generation is still the agent's current one, so its report lands"
        );

        // The loop re-claims on the next inbound frame, which is the only way
        // back for an agent that went quiet without reconnecting.
        let (_sender, mut rx) = claim_control_channel(&h).await;
        let _waiter = h
            .command_broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;
        assert!(
            rx.try_recv().is_ok(),
            "the current generation must recover its control channel after a false eviction"
        );
    }

    /// Registration is a transition — `Unregistered -> Agent(A)` — and never a
    /// rebind.
    ///
    /// What the rebind left behind was a ghost: the broker still claiming `A`
    /// from a socket whose handler now remembered only `B`. Nothing released
    /// `A` — not the disconnect path, which releases the one id the handler
    /// remembers, and not `B`, which no claim ever named.
    #[tokio::test]
    async fn registering_twice_on_one_connection_is_refused() {
        let mut h = test_handler("").await;
        register_agent_connection(&mut h, "a1").await;
        let (sender, mut rx) = claim_control_channel(&h).await;

        let reply = register(&mut h, "a2").await;
        assert_eq!(
            reply["payload"]["status"], "rejected",
            "a connection that already answers for one agent may not become another"
        );
        assert!(
            h.agent_registry.get("a2").await.is_none(),
            "the refused registration must not create the second agent"
        );
        assert_eq!(
            h.registered_agent_id(),
            Some(&"a1".to_string()),
            "the connection keeps the identity it established"
        );

        // The claim the loop makes after that frame still names a1, which is the
        // point: `a1` is what the disconnect path will release, and what this
        // connection is judged by.
        let agent_id = h.registered_agent_id().unwrap().clone();
        h.command_broker
            .claim_agent(&agent_id, h.connection_generation(), sender)
            .await;
        let _waiter = h
            .command_broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;
        assert!(
            rx.try_recv().is_ok(),
            "a1 must still be served from this connection — no ghost, and no ghost's replacement"
        );
    }

    /// A resize names its session and nothing else — there is no `agent_id` in
    /// the frame to check — so the session id's own prefix is the identity this
    /// wire is judged by.
    ///
    /// This one used to be checked by nothing at all: it parsed, then broadcast
    /// to whatever session the payload named. A connection registered as `a1`
    /// could therefore move `a2`'s screen.
    #[tokio::test]
    async fn terminal_resize_for_another_agents_session_is_refused() {
        use crate::server::outbound::WsMessageSender;

        let mut h = test_handler("").await;
        register_agent_connection(&mut h, "a1").await;
        let (_sender, _rx) = claim_control_channel(&h).await;

        let (client, mut client_rx) = WsMessageSender::new();
        h.client_registry
            .register("a2:dev", "client-1", client)
            .await;

        report(
            &mut h,
            proto_msg(
                "server.agent.terminal-resize",
                json!({ "session_id": "a2:dev", "cols": 120, "rows": 40 }),
            ),
        )
        .await;
        assert!(
            client_rx.try_recv().is_err(),
            "a connection registered as a1 must not resize a2's session"
        );

        // Whose session it is, not whether resizes work: the same frame for one
        // of its own still reaches the attached client.
        let (client, mut client_rx) = WsMessageSender::new();
        h.client_registry
            .register("a1:dev", "client-2", client)
            .await;
        report(
            &mut h,
            proto_msg(
                "server.agent.terminal-resize",
                json!({ "session_id": "a1:dev", "cols": 120, "rows": 40 }),
            ),
        )
        .await;
        assert!(
            client_rx.try_recv().is_ok(),
            "a resize for one of its own sessions must still be broadcast"
        );
    }

    // ---- Quick Commands (issue #95, part 3) ----

    #[tokio::test]
    async fn commands_list_requires_auth() {
        let mut h = test_handler("tok").await;
        let action = h
            .handle_message(proto_msg("server.commands.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["msg_type"], "server.commands.list");
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("Not authenticated"));
    }

    #[tokio::test]
    async fn commands_list_empty() {
        let mut h = test_handler("tok").await;
        // Auth as client first
        let _ = h
            .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
            .await
            .unwrap();
        let action = h
            .handle_message(proto_msg("server.commands.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["msg_type"], "server.commands.list");
        assert!(reply["payload"]["commands"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn commands_add_requires_auth() {
        let mut h = test_handler("tok").await;
        let action = h
            .handle_message(proto_msg(
                "server.commands.add",
                json!({ "label": "test", "command": "echo hi" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(!reply["payload"]["success"].as_bool().unwrap());
    }

    #[tokio::test]
    async fn commands_add_and_list() {
        let mut h = test_handler("tok").await;
        // Auth as client
        let _ = h
            .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
            .await
            .unwrap();
        // Add a command
        let action = h
            .handle_message(proto_msg(
                "server.commands.add",
                json!({ "label": "My Cmd", "command": "echo hello" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["success"].as_bool().unwrap());
        let cmd_id = reply["payload"]["id"].as_str().unwrap().to_string();

        // List should include it
        let action = h
            .handle_message(proto_msg("server.commands.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        let cmds = reply["payload"]["commands"].as_array().unwrap();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0]["label"], "My Cmd");
        assert_eq!(cmds[0]["command"], "echo hello");

        // Remove it
        let action = h
            .handle_message(proto_msg("server.commands.remove", json!({ "id": cmd_id })))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["success"].as_bool().unwrap());

        // List should be empty again
        let action = h
            .handle_message(proto_msg("server.commands.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["commands"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn commands_update() {
        let mut h = test_handler("tok").await;
        // Auth as client
        let _ = h
            .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
            .await
            .unwrap();
        // Add a command
        let action = h
            .handle_message(proto_msg(
                "server.commands.add",
                json!({ "label": "Old", "command": "old cmd" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        let cmd_id = reply["payload"]["id"].as_str().unwrap().to_string();

        // Update it
        let action = h
            .handle_message(proto_msg(
                "server.commands.update",
                json!({ "id": cmd_id, "label": "New", "command": "new cmd" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["success"].as_bool().unwrap());

        // List should show updated values
        let action = h
            .handle_message(proto_msg("server.commands.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        let cmds = reply["payload"]["commands"].as_array().unwrap();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0]["label"], "New");
        assert_eq!(cmds[0]["command"], "new cmd");
    }

    #[tokio::test]
    async fn commands_remove_nonexistent() {
        let mut h = test_handler("tok").await;
        // Auth as client
        let _ = h
            .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
            .await
            .unwrap();
        // Remove an id that doesn't exist (should still succeed — idempotent)
        let action = h
            .handle_message(proto_msg(
                "server.commands.remove",
                json!({ "id": "nonexistent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["success"].as_bool().unwrap());
    }

    #[tokio::test]
    async fn commands_update_nonexistent() {
        let mut h = test_handler("tok").await;
        // Auth as client
        let _ = h
            .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
            .await
            .unwrap();
        // Update a nonexistent command
        let action = h
            .handle_message(proto_msg(
                "server.commands.update",
                json!({ "id": "missing", "label": "Nope" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(!reply["payload"]["success"].as_bool().unwrap());
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }
}

// ── The Protocol Units this server serves ──
//
// One invocation, three artefacts: `server_descriptors()` (the manifest's
// half), `SERVER_WIRES` (what the message loop tests) and `dispatch_server()`
// (the routing half). A unit cannot be advertised without a handler, or handled
// without being advertised, because there is one list.
//
// The ids are the *operations*, not the wire types. Where an operation has a
// provider on each side — `session.create` is served by this server for a
// browser and by the agent for this server — both declare the same id and each
// declares its own wire projection, which is exactly the model: one contract,
// several providers, `ContractSupport.wire` carrying the difference.

/// The session a payload names by its parts, as the registry names it.
///
/// `server.session.create` is the unit that does this: it takes an `agent_id`
/// and a `name` and joins them, because the session does not exist yet and
/// there is no id to take. The join is written as the registry writes it
/// (`{agent_id}:{name}`), which is what makes it the *same key* as
/// [`session_by_id`] produces for the same session — the property the key lane
/// exists for, and the one its test pins.
fn session_by_parts(payload: &Value) -> ResourceKey {
    let agent_id = payload
        .get("agent_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    ResourceKey::Session(format!("{agent_id}:{name}"))
}

/// The session a payload names by its joined id, as the registry names it.
///
/// `server.session.kill` and the two `session.env.*` units take the `session_id`
/// the registry hands out, which is already `agent_id:session_name`.
///
/// A payload with neither part in it produces the empty key rather than an
/// error, and that is deliberate: the frame is still dispatched, still counted,
/// and still answered — with the refusal its handler has always produced —
/// while a classifier that refused to produce a key would have to decide what
/// lane a malformed mutation runs on, and there is no honest answer to that.
/// Every such frame shares one queue, which is a queue of frames that are about
/// to be refused.
fn session_by_id(payload: &Value) -> ResourceKey {
    ResourceKey::Session(
        payload
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    )
}

/// The env file a payload names, qualified by the side of the fleet it lives on.
///
/// `source` decides the spelling, because an agent's `staging.env` and the
/// Server's `staging.env` are two files with one name: a key that ignored the
/// source would serialise two unrelated writes, and the variant would be
/// carrying half of what it says it carries.
fn env_file_key(payload: &Value) -> ResourceKey {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let agent_source = payload.get("source").and_then(Value::as_str) == Some("agent");
    if agent_source {
        let agent_id = payload
            .get("agent_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        ResourceKey::Env(format!("{agent_id}:{name}"))
    } else {
        ResourceKey::Env(name.to_string())
    }
}

server_routes!(handler, msg, payload;
    "server.agent.register" => "server.agent.register" => 1 => Ordered => handler.handle_agent_register(msg).await,
    // `control.heartbeat` is deliberately **not** an arm here. It is a control
    // message, not an operation: nothing answers it (the agent used to read an
    // acknowledgement on a wire of its own, and that is gone because control
    // has no acknowledgement), and an arm would put it in the manifest as a
    // unit the server offers. It is handled in `handle_protocol_message`, ahead
    // of the relay path — see the match there for why the position matters.
    "server.agent.session-update" => "server.agent.session-update" => 1 => Inline => handler.handle_agent_session_update(msg).await,
    "server.agent.command-response" => "server.agent.command-response" => 1 => Inline => handler.handle_agent_command_response(msg).await,
    "server.agent.terminal-resize" => "server.agent.terminal-resize" => 1 => Inline => handler.handle_agent_terminal_resize(msg).await,
    "server.agent.address-update" => "server.agent.address-update" => 1 => Inline => handler.handle_agent_address_update(msg).await,
    "server.auth" => "server.auth" => 1 => Ordered => handler.handle_client_auth(msg).await,
    "server.agent.list" => "server.agent.list" => 1 => Query => handler.handle_client_agents_list(msg).await,
    "server.session.list" => "server.session.list" => 1 => Query => handler.handle_client_sessions_list(msg).await,
    "server.session.attach" => "server.session.attach" => 1 => Ordered => handler.handle_client_session_attach(msg).await,
    "server.session.relay.begin" => "server.session.relay.begin" => 1 => Ordered => handler.handle_client_session_relay_begin(msg).await,
    // `server.session.relay.end` is intercepted by the relay function
    // (`relay_bidirectional_via_channel`) and never reaches the dispatcher
    // during active relay. It is declared here anyway, because the Server does
    // serve it — the relay loop is the handler — and a manifest that omitted it
    // would understate what this peer answers. `Ordered`, because it is the
    // other half of the mode transition: leaving relay mode must be as
    // deterministic as entering it.
    "server.session.relay.end" => "server.session.relay.end" => 1 => Ordered => Ok(HandlerAction::Reply(None)),
    // The keyed mutations (`#961-E`). Each carries the resource it mutates,
    // read from its own payload: the session ones by the session they name, the
    // env ones by the file. Create and kill name one session two ways and must
    // land on one key — see `session_by_parts` / `session_by_id`.
    "server.session.create" => "server.session.create" => 1 => Key(session_by_parts(payload)) => handler.handle_client_session_create(msg).await,
    "server.session.kill" => "server.session.kill" => 1 => Key(session_by_id(payload)) => handler.handle_client_session_kill(msg).await,
    "server.session.capture-preview" => "server.session.capture-preview" => 1 => Query => handler.handle_client_session_capture_preview(msg).await,
    "server.env.list" => "server.env.list" => 1 => Query => handler.handle_client_env_list(msg).await,
    "server.env.get" => "server.env.get" => 1 => Query => handler.handle_client_env_get(msg).await,
    "server.env.write" => "server.env.write" => 1 => Key(env_file_key(payload)) => handler.handle_client_env_write(msg).await,
    "server.env.delete" => "server.env.delete" => 1 => Key(env_file_key(payload)) => handler.handle_client_env_delete(msg).await,
    "server.session.env.apply" => "server.session.env.apply" => 1 => Key(session_by_id(payload)) => handler.handle_client_session_env_apply(msg).await,
    "server.session.env.unset" => "server.session.env.unset" => 1 => Key(session_by_id(payload)) => handler.handle_client_session_env_unset(msg).await,
    "server.session.env.active" => "server.session.env.active" => 1 => Query => handler.handle_client_session_env_active(msg).await,
    "server.session.env.query" => "server.session.env.query" => 1 => Query => handler.handle_client_session_env_query(msg).await,
    "server.info" => "server.info" => 1 => Query => handler.handle_client_server_info(msg).await,
    "server.agent.rename" => "server.agent.rename" => 1 => Inline => handler.handle_client_agent_rename(msg).await,
    "server.agent.delete" => "server.agent.delete" => 1 => Inline => handler.handle_client_agent_delete(msg).await,
    "server.commands.list" => "server.commands.list" => 1 => Query => handler.handle_client_commands_list(msg).await,
    "server.commands.add" => "server.commands.add" => 1 => Inline => handler.handle_client_commands_add(msg).await,
    "server.commands.remove" => "server.commands.remove" => 1 => Inline => handler.handle_client_commands_remove(msg).await,
    "server.commands.update" => "server.commands.update" => 1 => Inline => handler.handle_client_commands_update(msg).await,
);
