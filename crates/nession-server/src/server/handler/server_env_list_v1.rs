//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    env_list_reply, json, warn, AgentStatus, ClientEnvListPayload, ClientEnvListResponsePayload,
    ConnectionHandler, HandlerAction, ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.env.list` — aggregate server env files with those from
    /// every online agent (EC6: same filename on both shows twice with badges).
    pub(super) async fn handle_client_env_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary, erased only at the dispatcher. Both
        // halves of this unit live in `contracts::env::v1`, and the agent's
        // half of the same protocol (`agent.env.list`) already declares them —
        // this handler read and wrote `Value` while they sat there unused.
        let ClientEnvListPayload {} = serde_json::from_value(msg.payload)?;

        if !self.authenticated_client {
            return Ok(env_list_reply(
                &msg.id,
                ClientEnvListResponsePayload {
                    files: Vec::new(),
                    error: Some("Not authenticated".to_string()),
                },
            ));
        }

        let mut files = self.env_service.store.list().await.unwrap_or_default();

        // Query each online agent for its local files.
        for agent in self.agent_registry.list().await {
            if agent.status != AgentStatus::Online {
                continue;
            }
            match self
                .agent_command(&agent.agent_id, "agent.env.list", json!({}))
                .await
            {
                Ok(resp) => {
                    if let Some(arr) = resp.get("files").and_then(|v| v.as_array()) {
                        for f in arr {
                            if let Ok(info) = serde_json::from_value::<
                                nession_protocol::contracts::env::v1::EnvFileInfo,
                            >(f.clone())
                            {
                                files.push(info);
                            }
                        }
                    }
                }
                Err(e) => warn!("env.list from agent {} failed: {}", agent.agent_id, e),
            }
        }

        Ok(env_list_reply(
            &msg.id,
            ClientEnvListResponsePayload { files, error: None },
        ))
    }
}
