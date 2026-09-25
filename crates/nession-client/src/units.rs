//! The units this consumer speaks, one typed method each.
//!
//! A method here is three lines: name the wire, build the contract's request,
//! hand both to [`ClientConnection::request`]. That is the shape the whole
//! boundary exists to make possible — what it replaces spent thirty to ninety
//! lines per unit building an envelope by hand, sending it, reading one frame,
//! comparing the `id`, and then walking the reply with `.get(…)` chains.

use nession_protocol::contracts::agent::v1::{AgentListPayload, AgentListReply};
use nession_protocol::contracts::client::v1::{AuthResponsePayload, ClientAuthPayload};
use nession_protocol::contracts::session::v1::{
    ClientSessionAttachPayload, ClientSessionAttachReply, ServerSessionListPayload,
    ServerSessionListReply,
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
}
