//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{info, json, ConnectionHandler, ProtocolMessage, HandlerAction, session_kill_reply, WebSessionKillResponse, ClientSessionKillPayload, AgentStatus, Duration};

impl ConnectionHandler {
    /// Handle `server.session.kill` — kill a session on its agent.
    pub(super) async fn handle_client_session_kill(
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
}
