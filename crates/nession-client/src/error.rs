//! What a typed call can fail with.
//!
//! Every variant names the wire it was working on, because a consumer's caller
//! is usually several frames up and the only thing it can usefully print is
//! *which call* went wrong.
//!
//! **A refusal is not in here.** `server.agent.list` and `server.session.list`
//! answer with a contract union — the list, or the refusal — and the refusal is
//! a *successfully delivered answer*, so this type is not the right home for it.
//! Folding it in would make every variant mean one of two different things
//! (the exchange failed / the exchange succeeded and said no) and force each
//! caller to unwrap the error to reach the Server's sentence. The union is
//! returned as the contract declares it instead, and Rust's exhaustiveness
//! check is what stops a caller ignoring the refusal arm — which is strictly
//! stronger than a mapping that a caller could still forget to read.
//!
//! There is deliberately no `anyhow` here. A shared boundary is where typed
//! errors pay for themselves; callers that want a user-facing sentence attach
//! one, and `nession-cli` already does that with `.with_context(…)`.

use std::time::Duration;

/// Everything this boundary reports.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// The socket could not be opened.
    #[error("failed to connect to `{url}`: {source}")]
    Connect {
        url: String,
        source: tokio_tungstenite::tungstenite::Error,
    },

    /// The Server answered the handshake with anything but success. Carries the
    /// Server's own message, which is the sentence a user needs — "invalid
    /// token" and "token expired" call for different next actions.
    #[error("authentication failed: {message}")]
    Auth { message: String },

    /// The connection ended while a reply was outstanding.
    #[error("the server closed the connection while `{wire}` was outstanding")]
    Closed { wire: String },

    /// No matching reply arrived in time.
    ///
    /// **A caller that sees this must not assume the operation did not
    /// happen.** The request reached the Server; only the answer is missing.
    /// For an operation with an effect — `server.session.create` — the effect
    /// may well have occurred, and a retry may act twice.
    #[error("`{wire}` did not answer within {timeout:?}")]
    Timeout { wire: String, timeout: Duration },

    /// A frame arrived that is not a protocol envelope at all.
    ///
    /// Distinct from [`ClientError::Reply`]: here the envelope itself is
    /// unreadable, so there is not even an `id` to decide whether the frame was
    /// ours.
    #[error("`{wire}` was answered with a frame that is not a protocol envelope: {source}")]
    Frame {
        wire: String,
        source: serde_json::Error,
    },

    /// The reply's payload does not match the contract this call named.
    ///
    /// The interesting case is a Server and a consumer disagreeing about a
    /// version. It is reported rather than retried because no retry can fix it.
    #[error("`{wire}` was answered with a payload its contract does not accept: {source}")]
    Reply {
        wire: String,
        source: serde_json::Error,
    },

    /// The request could not be put on the socket.
    #[error("`{wire}` could not be sent: {source}")]
    Send {
        wire: String,
        source: tokio_tungstenite::tungstenite::Error,
    },

    /// The socket failed while a reply was outstanding.
    #[error("`{wire}` lost its connection: {source}")]
    Transport {
        wire: String,
        source: tokio_tungstenite::tungstenite::Error,
    },
}
