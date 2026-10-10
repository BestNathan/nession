//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    json, session_env_query_reply, ClientSessionEnvQueryPayload, ConnectionHandler, HandlerAction,
    ProtocolMessage, SessionEnvQueryResponse,
};

impl ConnectionHandler {
    /// Handle `server.session.env.query` — ask the agent which env files are
    /// currently sourced (applied to its process environment).
    pub(super) async fn handle_client_session_env_query(
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
}
