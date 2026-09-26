//! The units this consumer speaks, one typed method each.
//!
//! A method here is three lines: name the wire, build the contract's request,
//! hand both to [`ClientConnection::request`]. That is the shape the whole
//! boundary exists to make possible — what it replaces spent thirty to ninety
//! lines per unit building an envelope by hand, sending it, reading one frame,
//! comparing the `id`, and then walking the reply with `.get(…)` chains.

use std::time::Duration;

use nession_protocol::contracts::agent::v1::{AgentListPayload, AgentListReply};
use nession_protocol::contracts::client::v1::{AuthResponsePayload, ClientAuthPayload};
use nession_protocol::contracts::session::v1::{
    ClientSessionAttachPayload, ClientSessionAttachReply, ClientSessionCreatePayload,
    ClientSessionCreateResponsePayload, ClientSessionKillPayload, ClientSessionKillResponsePayload,
    ServerSessionListPayload, ServerSessionListReply,
};

use crate::connection::ClientConnection;
use crate::error::ClientError;
use crate::unit::{proto_msg, UnitRequest};
use crate::wire;

// ── Which reply answers which request ────────────────────────────────────────
//
// The declared pairing *is* the compile-time protection #1015 asks for: a
// renamed or removed reply type breaks this impl, and therefore breaks every
// method that returns it. Nothing else in the crate records it.

impl UnitRequest for ClientAuthPayload {
    type Reply = AuthResponsePayload;
}

impl UnitRequest for AgentListPayload {
    type Reply = AgentListReply;
}

impl UnitRequest for ServerSessionListPayload {
    type Reply = ServerSessionListReply;
}

impl UnitRequest for ClientSessionAttachPayload {
    type Reply = ClientSessionAttachReply;
}

impl UnitRequest for ClientSessionCreatePayload {
    type Reply = ClientSessionCreateResponsePayload;
}

impl UnitRequest for ClientSessionKillPayload {
    type Reply = ClientSessionKillResponsePayload;
}

/// How long to wait for a session create.
///
/// **Longer than the Server's own bound on purpose.** The Server waits up to 30
/// seconds for the Agent and then answers *its* refusal; a client bound that
/// expires first turns "the agent is slow" into a transport timeout reported by
/// the wrong side, and tells the user nothing the Server was about to tell them.
/// Five seconds of headroom is for the round trip either side of that wait.
///
/// Not a field on `ClientConfig`: this is a property of what the unit does, not
/// a preference, and the default there is the one for units that answer promptly.
const SESSION_CREATE_TIMEOUT: Duration = Duration::from_secs(35);

/// Which transport an attach prefers.
///
/// A narrowing of the contract's `preferred_mode: String`, not a replacement:
/// the contract keeps it a string so a future mode does not need a contract
/// version, and this enum is what stops a consumer passing a mode the Server
/// will not recognise. The contract documents `"auto"` as resolved *by the
/// client* — it asks for `p2p` and falls back to `relay` — so `auto` is not a
/// value that ever reaches the wire, and it is not a variant here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachMode {
    P2p,
    Relay,
}

impl AttachMode {
    fn as_contract(self) -> &'static str {
        match self {
            Self::P2p => "p2p",
            Self::Relay => "relay",
        }
    }
}

impl ClientConnection {
    /// `server.agent.list` — every agent the Server knows about, or its refusal.
    ///
    /// Returns the contract's union rather than mapping the refusal into an
    /// error, so the caller sees the Server's own `message` and decides what a
    /// refusal means for it.
    pub async fn list_agents(&mut self) -> Result<AgentListReply, ClientError> {
        self.request(proto_msg(wire::SERVER_AGENT_LIST, AgentListPayload {}))
            .await
    }

    /// `server.session.list` — sessions, optionally scoped to one agent.
    ///
    /// Always answers from the registry (`force: false`). Asking every online
    /// agent for its live sessions is slower and answers a staleness question
    /// no consumer of this boundary has asked.
    pub async fn list_sessions(
        &mut self,
        agent_id: Option<&str>,
    ) -> Result<ServerSessionListReply, ClientError> {
        self.request(proto_msg(
            wire::SERVER_SESSION_LIST,
            ServerSessionListPayload {
                agent_id: agent_id.map(str::to_owned),
                force: false,
            },
        ))
        .await
    }

    /// `server.session.attach` — ask the Server how to reach a session.
    ///
    /// Returns the **contract's** reply, not a narrowed copy, and that is
    /// deliberate: the success arm carries `addresses: Vec<ProbedAddress>`
    /// alongside the legacy single `agent_address`, and the consumer this
    /// replaces read only the legacy field — which is what made it unable to
    /// reach an agent advertised solely over TLS. Collapsing the reply here
    /// would put that limitation in the shared boundary, where every future
    /// consumer inherits it.
    ///
    /// The refusal is the union's other arm, for the same reason as
    /// [`Self::list_agents`]: a delivered answer is not a transport failure,
    /// and the Server's sentence is the thing worth handing on.
    pub async fn request_attach(
        &mut self,
        session_id: &str,
        mode: AttachMode,
    ) -> Result<ClientSessionAttachReply, ClientError> {
        self.request(proto_msg(
            wire::SERVER_SESSION_ATTACH,
            ClientSessionAttachPayload {
                session_id: session_id.to_string(),
                preferred_mode: mode.as_contract().to_string(),
                env_snapshots: Vec::new(),
                relay_url: None,
            },
        ))
        .await
    }

    /// `server.session.create` — create a session on one agent.
    ///
    /// The Server resolves the agent, checks it is online, forwards the create,
    /// registers the session, and answers. That resolution is the whole reason
    /// this goes through the Server rather than to the agent: the consumer this
    /// replaces asked for the agent list on one connection, **closed it**, and
    /// then dialled the agent directly on another — the authenticate →
    /// authorize → resolve → route path the Server exists to be, run at home.
    ///
    /// No size, and no `env_files`. Neither is an oversight.
    ///
    /// **The size is not on this wire.** The Agent creates every session at a
    /// fixed starting size and lets the first attach resize it
    /// (`TmuxManager::create_session` takes the parameters and ignores them, by
    /// the sizing decision of 2026-08-15). A `width` on this payload would
    /// therefore be a field nothing honours — the same defect stage 4 of #1013
    /// exists to remove from `ClientAuthPayload`. Measured end to end before
    /// writing this: a session created at `--width 111` came up at 200, which is
    /// `SESSION_WIDTH`, on both the direct-agent path this replaced and this one.
    ///
    /// `env_files` *is* on the wire and the Server reads it, but nothing on this
    /// side of the boundary sources env files yet, and a parameter no caller
    /// passes is a guess about a shape. Adding it later is a signature change
    /// with exactly one caller to update.
    pub async fn create_session(
        &mut self,
        agent_id: &str,
        name: &str,
    ) -> Result<ClientSessionCreateResponsePayload, ClientError> {
        self.request_within(
            proto_msg(
                wire::SERVER_SESSION_CREATE,
                ClientSessionCreatePayload {
                    agent_id: agent_id.to_string(),
                    name: name.to_string(),
                    env_files: Vec::new(),
                },
            ),
            SESSION_CREATE_TIMEOUT,
        )
        .await
    }

    /// `server.session.kill` — kill one session.
    ///
    /// The Server answers `success: false` with its own reason for every case it
    /// can name — an unknown session, a session on an offline agent — so the
    /// reply is returned whole rather than mapped into an error here, the same
    /// way the list and attach replies are.
    pub async fn kill_session(
        &mut self,
        session_id: &str,
    ) -> Result<ClientSessionKillResponsePayload, ClientError> {
        self.request(proto_msg(
            wire::SERVER_SESSION_KILL,
            ClientSessionKillPayload {
                session_id: session_id.to_string(),
            },
        ))
        .await
    }
}
