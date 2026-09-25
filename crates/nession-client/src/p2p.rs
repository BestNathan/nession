//! The agent-facing data path.
//!
//! Everything here is about a socket to an **agent**, which is a different thing
//! from the Server connection the rest of this crate speaks on. Two facts keep
//! that difference honest, and both are the reason this module is small:
//!
//! * **It is a data path, not a management path.** An agent socket carries the
//!   terminal. Session management goes through the Server (`server.session.*`),
//!   which is what gives it authentication, authorization, target resolution and
//!   routing. A consumer that opens an agent socket to run commands has built a
//!   second control plane that bypasses all four — which is what #1015 removed
//!   from the CLI, and why the direct helpers that remain are in the CLI with a
//!   deletion date on them rather than in here.
//!
//! * **It is the one place a P2P credential will go.** #1013 puts a
//!   server-issued scoped credential on every agent connection. With a single
//!   constructor that is one signature to change and one place it can be
//!   forgotten; a second way in elsewhere in the tree is a way in that does not
//!   carry it.
//!
//! `nession-cli` re-exports nothing from this module's callers' perspective: it
//! calls [`P2pConnection::connect`], immediately takes the socket with
//! [`P2pConnection::into_stream`], and gives it to its own terminal. Terminal I/O
//! stays in the CLI — moving it here is a stated non-goal of #1015.

use nession_protocol::contracts::session::v1::ClientAttachPayload;
use nession_protocol::Message;

use crate::connection::{open_ws, WsStream};
use crate::error::ClientError;
use crate::unit::proto_msg;
use crate::wire;

/// A socket to an agent, for terminal I/O.
///
/// See the module docs for why this exists at all when it wraps one function.
pub struct P2pConnection {
    ws: WsStream,
}

impl P2pConnection {
    /// Connect to an agent at one of the addresses an attach reply advertised.
    ///
    /// The address comes from the Server, never from [`crate::ClientConnection`]'s
    /// caller reassembling one: the attach reply carries a probe-annotated list
    /// for exactly this, and `agent_address` as the legacy single-endpoint
    /// fallback. Reassembling `ip_address:port` from an agent listing is how the
    /// consumer this replaces ended up unable to reach an agent advertised only
    /// over TLS.
    ///
    /// **#1013 changes this signature** to take the server-issued credential.
    pub async fn connect(url: &str) -> Result<Self, ClientError> {
        Ok(Self {
            ws: open_ws(url).await?,
        })
    }

    /// The socket, once the caller has finished with this type's guarantees.
    ///
    /// Named for what it returns rather than `into_inner`, so a reader can see
    /// that the result is a bare socket with nothing attached to it.
    pub fn into_stream(self) -> WsStream {
        self.ws
    }
}

/// Build the `agent.attach` frame.
///
/// Public because attach is sent on **two** transports — a fresh agent socket in
/// P2P mode, and the Server connection in relay mode — and only one of them is a
/// [`P2pConnection`]. Building it in one place is what stops the two from
/// drifting into different attach payloads, which they had: the two call sites
/// this replaces each constructed their own, and only one of them read the
/// session name off the reply.
///
/// The frame is **not awaited**. The contract declares this unit's reply and the
/// agent sends one, but what follows an attach on the socket is terminal
/// traffic: a consumer that read the reply here would then have to hand the same
/// socket to a terminal, and a stream has one reader. The terminal takes it from
/// the caller's next line.
pub fn attach_frame(session_name: &str, cols: u16, rows: u16) -> Message<ClientAttachPayload> {
    proto_msg(
        wire::AGENT_ATTACH,
        ClientAttachPayload {
            session_name: session_name.to_string(),
            width: cols,
            height: rows,
            env_snapshots: Vec::new(),
        },
    )
}
