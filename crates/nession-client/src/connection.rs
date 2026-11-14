//! The connection: transport, the `server.auth` handshake, and correlation.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nession_protocol::contracts::client::v1::{AuthResponsePayload, ClientAuthPayload};
use nession_protocol::Message;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tracing::debug;

use crate::error::ClientError;
use crate::unit::{proto_msg, UnitRequest};
use crate::wire;

/// The concrete socket this client speaks on.
///
/// Exported because a consumer hands it to its own terminal: `nession-cli`'s
/// `WebSocketTransport` wraps exactly this type. Hiding it behind an opaque
/// handle would force that crate to change for no gain, and terminal I/O is
/// deliberately not this boundary's concern — moving it here is one of #1015's
/// stated non-goals.
pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How long one typed call waits for its reply.
///
/// Kept equal to the Web's `MessageRouter` on purpose: two consumers of one
/// Server should not disagree about when the same call has failed.
///
/// A unit that legitimately takes longer than this must not simply inherit it —
/// see [`ClientConnection::request_within`].
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// How to reach a Server, and as whom.
#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub server_url: String,
    pub auth_token: String,
    pub request_timeout: Duration,
}

impl ClientConfig {
    /// A config with [`DEFAULT_REQUEST_TIMEOUT`].
    pub fn new(server_url: impl Into<String>, auth_token: impl Into<String>) -> Self {
        Self {
            server_url: server_url.into(),
            auth_token: auth_token.into(),
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
        }
    }
}

/// An authenticated connection to the Server.
///
/// There is no `authenticated` flag, and that is the point. [`Self::connect`]
/// returns a value only once the handshake has succeeded, so "a connection that
/// has not authenticated" is not a state a caller can hold. The consumer this
/// replaces carried a `bool` plus three `bail!("Not authenticated")` guards,
/// which is the same invariant written three times and enforced none of them at
/// the type level.
pub struct ClientConnection {
    /// Shared with [`crate::units`], whose one-way `relay.begin` both writes a
    /// frame and reads the frames that precede the Server's receipt.
    pub(crate) ws: WsStream,
    config: ClientConfig,
    /// The next request id. See [`Self::next_id`] for why this is a counter and
    /// not a clock.
    seq: u64,
}

impl ClientConnection {
    /// Connect and authenticate. Returns only once the Server has accepted us.
    ///
    /// The handshake runs through the same [`Self::request`] every other call
    /// uses, so there is one correlation implementation rather than a second
    /// one for auth — which is how the consumer this replaces ended up with six
    /// copies of the same send-and-read.
    pub async fn connect(config: ClientConfig) -> Result<Self, ClientError> {
        let ws = open_ws(&config.server_url).await?;
        let mut connection = Self { ws, config, seq: 0 };

        let client_id = uuid::Uuid::new_v4().to_string();
        let reply: AuthResponsePayload = connection
            .request(proto_msg(
                wire::SERVER_AUTH,
                ClientAuthPayload {
                    auth_token: connection.config.auth_token.clone().into(),
                    client_id: Some(client_id),
                },
            ))
            .await?;

        if reply.status != "success" {
            // The Server's own sentence travels: "invalid token" and "token
            // expired" call for different next actions from whoever is reading.
            return Err(ClientError::Auth {
                message: reply.message,
            });
        }

        debug!("Authenticated with the server");
        Ok(connection)
    }

    /// Send one request and wait for its reply, within
    /// [`ClientConfig::request_timeout`].
    pub async fn request<P: UnitRequest>(
        &mut self,
        request: Message<P>,
    ) -> Result<P::Reply, ClientError> {
        // Copy the bound out first: `self` is borrowed mutably below.
        let timeout = self.config.request_timeout;
        self.request_within(request, timeout).await
    }

    /// Send one request and wait for its reply, within an explicit bound.
    ///
    /// Use this instead of [`Self::request`] when the Server's own handling may
    /// outlast the default. The case that exists today is `server.session.create`,
    /// which waits up to 30 seconds for the agent and then answers with its own
    /// refusal — a 15-second client bound would give up first and report a
    /// failure for a session the Server is about to create.
    ///
    /// Correlation is by `id` alone. An envelope whose `id` is not ours is
    /// **skipped**, not an error: a Server may push at any time (`server.agents.changed`
    /// among others), and the consumer this replaces treated the first such push
    /// as a hard failure of the call in flight. Frames that are not protocol
    /// envelopes at all are reported — there is no `id` to skip them by, and on
    /// this socket they mean something is wrong.
    pub async fn request_within<P: UnitRequest>(
        &mut self,
        request: Message<P>,
        timeout: Duration,
    ) -> Result<P::Reply, ClientError> {
        let wire_name = request.msg_type.clone();
        let (_, payload) = request_envelope(&mut self.ws, &mut self.seq, request, timeout).await?;
        serde_json::from_value(payload).map_err(|source| ClientError::Reply {
            wire: wire_name,
            source,
        })
    }

    /// Hand the socket to a caller that will take it over — relay-mode terminal
    /// I/O.
    ///
    /// A move, and deliberately the whole socket rather than halves: nothing
    /// else holds it, so there is no `SplitSink::reunite` and no second
    /// connection type. That is a consequence of [`Self::request`] owning the
    /// socket and reading from it in place, rather than spawning a reader task.
    pub fn into_relay_transport(self) -> WsStream {
        self.ws
    }

    /// Close the connection.
    pub async fn close(mut self) -> Result<(), ClientError> {
        self.ws
            .close(None)
            .await
            .map_err(|source| ClientError::Send {
                wire: "close".to_string(),
                source,
            })
    }
}

/// Authenticate an Agent socket as its first protocol frame (#3440).
///
/// The Agent accepts no business frame before this succeeds. A refusal is a
/// delivered answer (`ClientError::Auth`), not a transport failure, so callers
/// stop retrying instead of treating a wrong token as an unreachable endpoint.
pub(crate) async fn authenticate_agent(
    ws: &mut WsStream,
    seq: &mut u64,
    agent_token: &str,
    ai_client_id: Option<String>,
) -> Result<AuthResponsePayload, ClientError> {
    let request = proto_msg(
        wire::CLIENT_AUTH,
        ClientAuthPayload {
            auth_token: agent_token.into(),
            client_id: ai_client_id,
        },
    );
    let (msg_type, payload) = request_envelope(ws, seq, request, DEFAULT_REQUEST_TIMEOUT).await?;
    if msg_type == "error" {
        return Err(ClientError::Auth {
            message: payload
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("the agent refused authentication")
                .to_string(),
        });
    }
    if msg_type != "ok" {
        return Err(ClientError::UnexpectedReply {
            wire: wire::CLIENT_AUTH.to_string(),
            got: msg_type,
        });
    }
    let reply: AuthResponsePayload =
        serde_json::from_value(payload).map_err(|source| ClientError::Reply {
            wire: wire::CLIENT_AUTH.to_string(),
            source,
        })?;
    if reply.status != "success" {
        return Err(ClientError::Auth {
            message: reply.message,
        });
    }
    Ok(reply)
}

/// The per-connection request id counter.
pub(crate) fn next_id(seq: &mut u64) -> String {
    *seq += 1;
    format!("client-{seq}")
}

/// Send one envelope and return the reply's wire type and payload value.
///
/// This is the correlation half of [`ClientConnection::request_within`], split
/// out because the Agent management connection needs the same
/// send-until-our-id loop but must inspect the reply's `msg_type` first: an
/// Agent answers success with `ok` and a refusal with `error`, rather than
/// echoing the request wire.
///
/// Correlation is by `id` alone. An envelope whose `id` is not ours is
/// **skipped**, not an error: a peer may push at any time (`server.agents.changed`
/// among others), and the consumer this replaces treated the first such push
/// as a hard failure of the call in flight. Frames that are not protocol
/// envelopes at all are reported — there is no `id` to skip them by, and on
/// these sockets they mean something is wrong.
pub(crate) async fn request_envelope<P: serde::Serialize>(
    ws: &mut WsStream,
    seq: &mut u64,
    mut request: Message<P>,
    timeout: Duration,
) -> Result<(String, serde_json::Value), ClientError> {
    let wire_name = request.msg_type.clone();
    let id = next_id(seq);
    request.id = id.clone();

    let encoded = serde_json::to_string(&request).map_err(|source| ClientError::Frame {
        wire: wire_name.clone(),
        source,
    })?;
    ws.send(WsMessage::Text(encoded))
        .await
        .map_err(|source| ClientError::Send {
            wire: wire_name.clone(),
            source,
        })?;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(ClientError::Timeout {
                wire: wire_name,
                timeout,
            });
        }

        let frame = match tokio::time::timeout(remaining, ws.next()).await {
            Err(_elapsed) => {
                return Err(ClientError::Timeout {
                    wire: wire_name,
                    timeout,
                })
            }
            Ok(None) => return Err(ClientError::Closed { wire: wire_name }),
            Ok(Some(Err(source))) => {
                return Err(ClientError::Transport {
                    wire: wire_name,
                    source,
                })
            }
            Ok(Some(Ok(frame))) => frame,
        };

        match frame {
            WsMessage::Text(text) => {
                let envelope: Message<serde_json::Value> =
                    serde_json::from_str(&text).map_err(|source| ClientError::Frame {
                        wire: wire_name.clone(),
                        source,
                    })?;
                if envelope.id != id {
                    debug!(
                        expected = %id,
                        got = %envelope.id,
                        msg_type = %envelope.msg_type,
                        "skipping a frame that is not this request's reply"
                    );
                    continue;
                }
                return Ok((envelope.msg_type, envelope.payload));
            }
            WsMessage::Close(_) => return Err(ClientError::Closed { wire: wire_name }),
            // Keepalives and non-text frames are transport chatter, not
            // answers. The consumer this replaces had a single-read design,
            // so a `Ping` arriving first failed the call outright.
            WsMessage::Ping(_)
            | WsMessage::Pong(_)
            | WsMessage::Binary(_)
            | WsMessage::Frame(_) => continue,
        }
    }
}

/// Open a socket at one URL. No handshake, no correlation.
///
/// This is the agent-facing *data* path — the P2P terminal socket — and it is
/// deliberately not a management path. Agent management goes through the Server
/// (`server.session.*`), which is what gives it authentication, authorization
/// and target resolution; a consumer that opens its own agent socket to run
/// commands has built a second control plane that bypasses all three.
pub async fn open_ws(url: &str) -> Result<WsStream, ClientError> {
    let (ws, _response) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|source| ClientError::Connect {
            url: url.to_string(),
            source,
        })?;
    Ok(ws)
}
