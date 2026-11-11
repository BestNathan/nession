//! A management socket to **one explicitly named Agent** (`#565`).
//!
//! This is deliberately separate from [`crate::P2pConnection`]:
//!
//! * `P2pConnection` is the terminal **data** path. It is opened from a
//!   Server-issued, session-scoped credential and is handed to a terminal.
//! * `AgentConnection` is a **management** path for the `agent.session.*`
//!   units. It exists because MCP's `nession_agent_*` tools answer for an
//!   explicitly named node, and two hosting modes have no Server-minted path
//!   that can answer that question directly: a standalone MCP host talks to a
//!   standalone Agent's operator token, and Server-embedded MCP needs an
//!   Agent's own truth rather than the Server registry.
//!
//! The credential is the Agent's configured operator token
//! (`CredentialScope::for_standalone`), never a token this client invents and
//! never a Server P2P credential. It goes into the URL through the same
//! canonical `agent_url_with_credential` helper every Agent dial uses.
//!
//! Every method correlates by request id and raises the Agent's own refusal as
//! [`ClientError::AgentRefused`]; a refusal is a delivered answer, not a
//! transport failure.

use std::time::Duration;

use nession_protocol::contracts::p2p::agent_url_with_credential;
use nession_protocol::contracts::session::v1::{
    AgentSessionListPayload, SessionCreatePayload, SessionCreateResponse, SessionKillPayload,
    SessionKillResponse, SessionListResponse,
};
use nession_protocol::Message;
use serde_json::Value;

use crate::connection::{open_ws, request_envelope, WsStream, DEFAULT_REQUEST_TIMEOUT};
use crate::error::ClientError;
use crate::unit::proto_msg;
use crate::wire;

/// A Session create can wait on tmux; give it more room than a prompt query.
const CREATE_TIMEOUT: Duration = Duration::from_secs(35);

/// An authenticated management connection to one Agent.
pub struct AgentConnection {
    ws: WsStream,
    seq: u64,
}

impl AgentConnection {
    /// Dial an Agent's management socket with its operator credential.
    pub async fn connect(endpoint: &str, credential: &str) -> Result<Self, ClientError> {
        let url = agent_url_with_credential(endpoint, credential);
        Ok(Self {
            ws: open_ws(&url).await?,
            seq: 0,
        })
    }

    /// Send one unit and return its delivered payload.
    ///
    /// The Agent answers success with `msg_type: "ok"` and failure with
    /// `msg_type: "error"`; both are correlated by id for us, so a frame whose
    /// id is not ours is skipped by [`request_envelope`] rather than mistaken
    /// for this call's answer.
    ///
    /// Takes the built envelope rather than a wire name so every call site
    /// names its wire through [`proto_msg`] with a `wire::` constant — the
    /// shape `scripts/protocol-gate.mjs` resolves to a provider.
    async fn request<P: serde::Serialize>(
        &mut self,
        request: Message<P>,
        timeout: Duration,
    ) -> Result<Value, ClientError> {
        let wire_name = request.msg_type.clone();
        let (msg_type, payload) =
            request_envelope(&mut self.ws, &mut self.seq, request, timeout).await?;

        if msg_type == "error" {
            let code = payload
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .to_string();
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the agent refused the request")
                .to_string();
            return Err(ClientError::AgentRefused {
                wire: wire_name,
                code,
                message,
            });
        }
        if msg_type != "ok" {
            return Err(ClientError::UnexpectedReply {
                wire: wire_name,
                got: msg_type,
            });
        }
        Ok(payload)
    }

    /// `agent.session.list` — the Agent's real tmux Sessions.
    pub async fn list_sessions(&mut self) -> Result<SessionListResponse, ClientError> {
        let payload = self
            .request(
                proto_msg(wire::AGENT_SESSION_LIST, AgentSessionListPayload {}),
                DEFAULT_REQUEST_TIMEOUT,
            )
            .await?;
        serde_json::from_value(payload).map_err(|source| ClientError::Reply {
            wire: wire::AGENT_SESSION_LIST.to_string(),
            source,
        })
    }

    /// `agent.session.create` — create a tmux Session on the Agent.
    pub async fn create_session(
        &mut self,
        name: &str,
        working_dir: Option<&str>,
    ) -> Result<SessionCreateResponse, ClientError> {
        let payload = self
            .request(
                proto_msg(
                    wire::AGENT_SESSION_CREATE,
                    SessionCreatePayload {
                        name: name.to_string(),
                        // The Agent owns the creation width (#2487): `terminal_cols:
                        // None` makes it use its own configured value, and the
                        // legacy width/height are placeholders it ignores.
                        width: 80,
                        height: 24,
                        working_dir: working_dir.map(str::to_owned),
                        env_snapshots: Vec::new(),
                        binding_profiles: Vec::new(),
                        binding_revision: None,
                        terminal_cols: None,
                        // #565's node tool has no Sandbox parameter; omitting
                        // the policy lets the Agent apply its configured
                        // default (#2681).
                        sandbox: None,
                        managed: None,
                    },
                ),
                CREATE_TIMEOUT,
            )
            .await?;
        serde_json::from_value(payload).map_err(|source| ClientError::Reply {
            wire: wire::AGENT_SESSION_CREATE.to_string(),
            source,
        })
    }

    /// `agent.session.kill` — kill a tmux Session on the Agent.
    pub async fn kill_session(&mut self, name: &str) -> Result<SessionKillResponse, ClientError> {
        let payload = self
            .request(
                proto_msg(
                    wire::AGENT_SESSION_KILL,
                    SessionKillPayload {
                        name: name.to_string(),
                    },
                ),
                DEFAULT_REQUEST_TIMEOUT,
            )
            .await?;
        serde_json::from_value(payload).map_err(|source| ClientError::Reply {
            wire: wire::AGENT_SESSION_KILL.to_string(),
            source,
        })
    }

    /// Close the socket.
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
