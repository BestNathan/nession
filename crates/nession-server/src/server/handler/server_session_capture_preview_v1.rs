//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{info, warn, json, ConnectionHandler, ProtocolMessage, HandlerAction, reply_json, ClientSessionCapturePreviewPayload, AgentStatus, Duration};

impl ConnectionHandler {
    /// Handle `server.session.capture-preview` — capture tmux scrollback from
    /// a session on its agent and relay the base64-encoded ANSI back to the client.
    pub(super) async fn handle_client_session_capture_preview(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        info!(
            "handle_client_session_capture_preview: called with msg_id={}",
            msg.id
        );

        if !self.authenticated_client {
            warn!("handle_client_session_capture_preview: client not authenticated");
            return Ok(reply_json(
                &msg.id,
                "server.session.capture-preview",
                json!({ "error": "Not authenticated" }),
            ));
        }

        // Typed at the contract boundary — the *request* only. This unit's
        // replies stay hand-built on purpose: five of them are the Server's own
        // refusals, and the sixth relays whatever the agent answered. The
        // Server does not read a provider's payload shape, so there is no
        // Nession-owned response type to build (see `docs/architecture/protocol.md`
        // on the relay).
        let ClientSessionCapturePreviewPayload { session_id, lines } =
            serde_json::from_value(msg.payload).unwrap_or_else(|_| {
                ClientSessionCapturePreviewPayload {
                    session_id: String::new(),
                    lines: 2000,
                }
            });
        let session_id = session_id.as_str();

        info!(
            "handle_client_session_capture_preview: session_id={}, lines={}",
            session_id, lines
        );

        let (agent_id, session_name) = match session_id.split_once(':') {
            Some((aid, sname)) => (aid.to_string(), sname.to_string()),
            None => {
                warn!(
                    "handle_client_session_capture_preview: invalid session_id format: {}",
                    session_id
                );
                return Ok(reply_json(
                    &msg.id,
                    "server.session.capture-preview",
                    json!({ "error": "Invalid session_id format. Expected 'agent_id:session_name'" }),
                ));
            }
        };

        info!(
            "handle_client_session_capture_preview: agent_id={}, session_name={}",
            agent_id, session_name
        );

        // Check agent is online
        let agent = self.agent_registry.get(&agent_id).await;
        match agent {
            Some(a) if a.status != AgentStatus::Online => {
                warn!(
                    "handle_client_session_capture_preview: agent {} is offline",
                    agent_id
                );
                return Ok(reply_json(
                    &msg.id,
                    "server.session.capture-preview",
                    json!({ "error": format!("Agent '{}' is offline", agent_id) }),
                ));
            }
            None => {
                warn!(
                    "handle_client_session_capture_preview: agent {} not found in registry",
                    agent_id
                );
                return Ok(reply_json(
                    &msg.id,
                    "server.session.capture-preview",
                    json!({ "error": format!("Agent '{}' not found", agent_id) }),
                ));
            }
            Some(_) => {
                info!(
                    "handle_client_session_capture_preview: agent {} is online",
                    agent_id
                );
            }
        }

        // Relay to agent with 15s timeout (capture can be slow for large lines)
        let payload = json!({
            "session_name": session_name,
            "lines": lines,
        });
        info!("handle_client_session_capture_preview: calling agent_command_with_timeout for agent {}", agent_id);
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.session.capture-preview",
                payload,
                Duration::from_secs(15),
            )
            .await
        {
            Ok(response) => {
                info!(
                    "handle_client_session_capture_preview: got response from agent {}",
                    agent_id
                );
                Ok(reply_json(
                    &msg.id,
                    "server.session.capture-preview",
                    response,
                ))
            }
            Err(e) => {
                warn!("handle_client_session_capture_preview: agent_command_with_timeout failed for agent {}: {}", agent_id, e);
                Ok(reply_json(
                    &msg.id,
                    "server.session.capture-preview",
                    json!({ "error": e }),
                ))
            }
        }
    }
}
