//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, session_kill_reply, AgentStatus, ClientSessionKillPayload, ConnectionHandler,
    Duration, HandlerAction, ProtocolMessage, WebSessionKillResponse,
};

impl ConnectionHandler {
    /// Handle `server.session.kill` — kill a session on its agent.
    ///
    /// `expected_instance_id` (#4302) is the optional caller-observed
    /// incarnation precondition: present, the Server forwards it to the Agent
    /// that owns the termination and propagates the Agent's classified refusal
    /// (`conflict` for a same-name replacement); absent, the legacy Web/CLI
    /// name-addressed kill is unchanged.
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
                    error_kind: None,
                },
            ));
        }

        // A missing or non-string `session_id` parses to nothing and lands on
        // the same "Invalid session_id format" reply the empty-string path
        // already produced, so that behaviour is unchanged.
        let Ok(ClientSessionKillPayload {
            session_id,
            expected_instance_id,
        }) = serde_json::from_value::<ClientSessionKillPayload>(msg.payload)
        else {
            return Ok(session_kill_reply(
                &msg.id,
                WebSessionKillResponse {
                    success: false,
                    error: Some(
                        "Invalid session_id format. Expected 'agent_id:session_name'".to_string(),
                    ),
                    error_kind: None,
                },
            ));
        };
        let session_id = session_id.as_str();
        let guarded = expected_instance_id.is_some();

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
                        error_kind: None,
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
                    // A guarded kill cannot verify the incarnation on an
                    // offline Agent, so it refuses truthfully instead of
                    // inheriting the legacy "consider it gone" success (#4302).
                    if guarded {
                        return Ok(session_kill_reply(
                            &msg.id,
                            WebSessionKillResponse {
                                success: false,
                                error: Some(format!(
                                    "Agent '{agent_id}' is offline; the Session's instance \
                                     identity cannot be verified"
                                )),
                                error_kind: Some("unavailable".to_string()),
                            },
                        ));
                    }
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
                            error_kind: None,
                        },
                    ));
                }
                Some(_) => {
                    return Ok(session_kill_reply(
                        &msg.id,
                        WebSessionKillResponse {
                            success: false,
                            error: Some(format!("Session '{session_id}' not found")),
                            error_kind: guarded.then(|| "not_found".to_string()),
                        },
                    ));
                }
                None => {
                    return Ok(session_kill_reply(
                        &msg.id,
                        WebSessionKillResponse {
                            success: false,
                            error: Some(format!("Agent '{agent_id}' not found")),
                            error_kind: guarded.then(|| "not_found".to_string()),
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

        let command = match expected_instance_id.as_deref() {
            Some(expected) => json!({
                "request_id": request_id,
                "name": session_name,
                "expected_instance_id": expected,
            }),
            None => json!({
                "request_id": request_id,
                "name": session_name,
            }),
        };
        let rx = self
            .command_broker
            .send_command(&agent_id, "agent.session.kill", &request_id, command)
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
                // The Agent's guarded refusal carries its classification; a
                // legacy name-only refusal has none and the reply keeps none.
                let error_kind = response
                    .get("error_kind")
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string);

                if success {
                    self.session_registry.remove(session_id).await;
                    // The Session is gone; its binding is no longer live state.
                    self.env_service.clear_session_state(session_id).await;
                }

                Ok(session_kill_reply(
                    &msg.id,
                    WebSessionKillResponse {
                        success,
                        error,
                        error_kind,
                    },
                ))
            }
            Ok(Err(_)) => Ok(session_kill_reply(
                &msg.id,
                WebSessionKillResponse {
                    success: false,
                    error: Some("Agent disconnected".to_string()),
                    // The kill may or may not have run; the outcome is
                    // indeterminate, never a silent retry (#3704, #4302).
                    error_kind: Some("unavailable".to_string()),
                },
            )),
            Err(_) => {
                // The caller's deadline settles the pending entry (#4434,
                // SC-03): a late reply must not be delivered to a request
                // whose caller has already been answered.
                self.command_broker
                    .expire_pending(&agent_id, &request_id)
                    .await;
                Ok(session_kill_reply(
                    &msg.id,
                    WebSessionKillResponse {
                        success: false,
                        error: Some("Timeout waiting for agent response".to_string()),
                        error_kind: Some("timeout".to_string()),
                    },
                ))
            }
        }
    }
}
