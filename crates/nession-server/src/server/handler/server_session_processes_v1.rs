//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, reply_json, warn, AgentStatus, ClientSessionProcessesPayload, ConnectionHandler,
    Duration, HandlerAction, ProcessSnapshot, ProtocolMessage, ServerSessionProcessesReply,
    SessionProcessesResponse, SessionRefusal,
};

/// A process snapshot may walk a process table and sample two CPU windows; it
/// is slower than a scrollback capture but must still answer a user waiting on
/// the Agent Workspace.
const PROCESS_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);

impl ConnectionHandler {
    /// Handle `server.session.processes` — relay a read-only process snapshot
    /// from the Session's Agent.
    ///
    /// The Server authorizes the browser and forwards only the Session name.
    /// It does not enumerate processes, does not see host-wide data, and does
    /// not cache a snapshot: every answer is the Agent's observation at the
    /// moment it was asked.
    pub(super) async fn handle_client_session_processes(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            warn!("Unauthenticated client requested a process snapshot");
            return Ok(refused(&msg.id, "Not authenticated"));
        }

        let ClientSessionProcessesPayload { session_id } = serde_json::from_value(msg.payload)
            .unwrap_or_else(|_| ClientSessionProcessesPayload {
                session_id: String::new(),
            });

        let Some((agent_id, session_name)) = session_id.split_once(':') else {
            return Ok(refused(
                &msg.id,
                "Invalid session_id format. Expected 'agent_id:session_name'",
            ));
        };
        if session_name.is_empty() {
            return Ok(refused(&msg.id, "Session name is empty"));
        }

        match self.agent_registry.get(agent_id).await {
            Some(agent) if agent.status != AgentStatus::Online => {
                return Ok(refused(&msg.id, &format!("Agent '{agent_id}' is offline")));
            }
            None => {
                return Ok(refused(&msg.id, &format!("Agent '{agent_id}' not found")));
            }
            Some(_) => {}
        }

        info!(
            "Requesting a process snapshot: agent_id={}, session_name={}",
            agent_id, session_name
        );
        match self
            .agent_command_with_timeout(
                agent_id,
                "agent.session.processes",
                json!({ "session_name": session_name }),
                PROCESS_SNAPSHOT_TIMEOUT,
            )
            .await
        {
            Ok(response)
                if response.get("success").and_then(serde_json::Value::as_bool) == Some(true) =>
            {
                let snapshot = match response.get("snapshot").cloned() {
                    Some(value) => match serde_json::from_value::<ProcessSnapshot>(value) {
                        Ok(snapshot) => Some(snapshot),
                        Err(error) => {
                            // A provider whose payload does not match the
                            // contract is a real defect, not an empty answer.
                            warn!("Agent returned an unreadable process snapshot: {error}");
                            None
                        }
                    },
                    None => {
                        warn!("Agent process response carried no snapshot");
                        None
                    }
                };
                match snapshot {
                    Some(snapshot) => Ok(reply_json(
                        &msg.id,
                        "server.session.processes",
                        serde_json::to_value(ServerSessionProcessesReply::Snapshot(
                            SessionProcessesResponse { snapshot },
                        ))
                        .unwrap_or_else(
                            |_| json!({ "status": "error", "message": "Serialization failed" }),
                        ),
                    )),
                    None => Ok(refused(
                        &msg.id,
                        "Agent returned an unreadable process snapshot",
                    )),
                }
            }
            Ok(response) => {
                let message = response
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent could not read the session's processes");
                Ok(refused(&msg.id, message))
            }
            Err(error) => Ok(refused(&msg.id, &error)),
        }
    }
}

/// The one refusal shape this unit sends.
fn refused(id: &str, message: &str) -> HandlerAction {
    reply_json(
        id,
        "server.session.processes",
        serde_json::to_value(ServerSessionProcessesReply::Refused(SessionRefusal {
            status: "error".to_string(),
            message: message.to_string(),
        }))
        .unwrap_or_else(|_| json!({ "status": "error", "message": "refused" })),
    )
}
