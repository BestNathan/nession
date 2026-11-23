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
//! The credential is the Agent's durable Agent Token, presented as the first
//! `client.auth` frame — never a token this client invents and never the
//! Server Token. The same verifier guards the terminal data path.
//!
//! Every method correlates by request id and raises the Agent's own refusal as
//! [`ClientError::AgentRefused`]; a refusal is a delivered answer, not a
//! transport failure.

use std::time::Duration;

use nession_protocol::contracts::mcp::v1::{McpToolCallPayload, McpToolCallReply};
use nession_protocol::contracts::session::v1::{
    AgentSessionListPayload, SessionCreatePayload, SessionCreateResponse, SessionInitialMetadata,
    SessionKillPayload, SessionKillResponse, SessionListResponse, SessionMetadataGetPayload,
    SessionMetadataPatchPayload, SessionMetadataResponse,
};
use nession_protocol::Message;
use serde_json::Value;

use crate::connection::{
    authenticate_agent, open_ws, request_envelope, WsStream, DEFAULT_REQUEST_TIMEOUT,
};
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
    /// Dial an Agent's management socket with its durable Agent Token.
    pub async fn connect(endpoint: &str, agent_token: &str) -> Result<Self, ClientError> {
        let mut ws = open_ws(endpoint).await?;
        let mut seq = 0;
        authenticate_agent(&mut ws, &mut seq, agent_token, None).await?;
        Ok(Self { ws, seq })
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

    /// `agent.session.metadata.get` — one Session's work context (#4007).
    pub async fn get_session_metadata(
        &mut self,
        name: &str,
    ) -> Result<SessionMetadataResponse, ClientError> {
        let payload = self
            .request(
                proto_msg(
                    wire::AGENT_SESSION_METADATA_GET,
                    SessionMetadataGetPayload {
                        name: name.to_string(),
                    },
                ),
                DEFAULT_REQUEST_TIMEOUT,
            )
            .await?;
        serde_json::from_value(payload).map_err(|source| ClientError::Reply {
            wire: wire::AGENT_SESSION_METADATA_GET.to_string(),
            source,
        })
    }

    /// `agent.session.metadata.patch` — partial update at the Agent owner.
    pub async fn patch_session_metadata(
        &mut self,
        payload: SessionMetadataPatchPayload,
    ) -> Result<SessionMetadataResponse, ClientError> {
        let reply = self
            .request(
                proto_msg(wire::AGENT_SESSION_METADATA_PATCH, payload),
                DEFAULT_REQUEST_TIMEOUT,
            )
            .await?;
        serde_json::from_value(reply).map_err(|source| ClientError::Reply {
            wire: wire::AGENT_SESSION_METADATA_PATCH.to_string(),
            source,
        })
    }

    /// `agent.mcp.tool.call` — one Extension-contributed Tool call on the
    /// direct Agent connection (`#3778`).
    ///
    /// The Agent validates that the named target is itself and executes
    /// through the same composed catalog its embedded MCP endpoint serves.
    pub async fn call_mcp_tool(
        &mut self,
        agent_id: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<McpToolCallReply, ClientError> {
        let payload = self
            .request(
                proto_msg(
                    wire::AGENT_MCP_TOOL_CALL,
                    McpToolCallPayload {
                        agent_id: agent_id.to_string(),
                        tool: tool.to_string(),
                        arguments,
                    },
                ),
                DEFAULT_REQUEST_TIMEOUT,
            )
            .await?;
        serde_json::from_value(payload).map_err(|source| ClientError::Reply {
            wire: wire::AGENT_MCP_TOOL_CALL.to_string(),
            source,
        })
    }

    /// `agent.session.create` — create a tmux Session on the Agent.
    ///
    /// `initial_metadata` is the optional creation-time work context (#4081);
    /// the Agent validates it before any Session side effect and commits it
    /// with the create.
    pub async fn create_session(
        &mut self,
        name: &str,
        working_dir: Option<&str>,
        initial_metadata: Option<SessionInitialMetadata>,
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
                        initial_metadata,
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
