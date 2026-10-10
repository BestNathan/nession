//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    env_del_reply, json, ClientEnvDeletePayload, ClientEnvDeleteResponsePayload, ConnectionHandler,
    EnvSource, HandlerAction, ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.env.delete` — delete an env file (blocked if in use).
    pub(super) async fn handle_client_env_delete(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. `force` used to be read off the
        // payload beside the parser because the contract did not name it,
        // though the Web has always sent it.
        if !self.authenticated_client {
            return Ok(env_del_reply(
                &msg.id,
                ClientEnvDeleteResponsePayload {
                    success: false,
                    error: Some("Not authenticated".to_string()),
                },
            ));
        }
        let Ok(ClientEnvDeletePayload {
            name,
            source,
            agent_id,
            force,
        }) = serde_json::from_value(msg.payload)
        else {
            return Ok(env_del_reply(
                &msg.id,
                ClientEnvDeleteResponsePayload {
                    success: false,
                    error: Some("name is required".to_string()),
                },
            ));
        };
        if name.is_empty() {
            return Ok(env_del_reply(
                &msg.id,
                ClientEnvDeleteResponsePayload {
                    success: false,
                    error: Some("name is required".to_string()),
                },
            ));
        }

        // In-use lock: refuse to delete a file bound to a running session
        // unless `force` is set (the file is gone, so no re-source is needed).
        if !force {
            let in_use = self
                .env_service
                .usage
                .sessions_using(&name, source, agent_id.as_deref());
            if !in_use.is_empty() {
                return Ok(env_del_reply(
                    &msg.id,
                    ClientEnvDeleteResponsePayload {
                        success: false,
                        error: Some(format!(
                            "This file is in use by session(s): {}. Stop the session or detach before deleting.",
                            in_use.join(", ")
                        )),
                    },
                ));
            }
        }

        let outcome = match source {
            EnvSource::Server => self
                .env_service
                .store
                .delete(&name)
                .await
                .map_err(|e| e.to_string()),
            EnvSource::Agent => match &agent_id {
                Some(aid) => self
                    .agent_command(aid, "agent.env.delete", json!({ "name": name }))
                    .await
                    .and_then(|resp| {
                        if resp.get("success").and_then(serde_json::Value::as_bool) == Some(true) {
                            Ok(())
                        } else {
                            Err(resp
                                .get("error")
                                .and_then(|v| v.as_str())
                                .unwrap_or("delete failed")
                                .to_string())
                        }
                    }),
                None => Err("agent_id is required for agent files".to_string()),
            },
        };

        match outcome {
            Ok(()) => Ok(env_del_reply(
                &msg.id,
                ClientEnvDeleteResponsePayload {
                    success: true,
                    error: None,
                },
            )),
            Err(e) => Ok(env_del_reply(
                &msg.id,
                ClientEnvDeleteResponsePayload {
                    success: false,
                    error: Some(e),
                },
            )),
        }
    }
}
