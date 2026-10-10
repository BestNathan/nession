//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::*;

impl ConnectionHandler {
    /// Handle `server.env.get` — read one env file's content and report which
    /// sessions currently use it (for the in-use lock).
    pub(super) async fn handle_client_env_get(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. `ClientEnvGetPayload::source` carries
        // a serde default so this accepts exactly what `parse_env_ref` accepted
        // — a request naming no source is a server file, not a refusal. A
        // payload with no `name` fails to parse and gets the same reply the
        // empty-name branch gives, so the wire is unchanged either way.
        if !self.authenticated_client {
            return Ok(env_get_reply(
                &msg.id,
                ClientEnvGetResponsePayload {
                    success: false,
                    content: None,
                    in_use_by: None,
                    error: Some("Not authenticated".to_string()),
                },
            ));
        }
        let Ok(ClientEnvGetPayload {
            name,
            source,
            agent_id,
        }) = serde_json::from_value(msg.payload)
        else {
            return Ok(env_get_reply(
                &msg.id,
                ClientEnvGetResponsePayload {
                    success: false,
                    content: None,
                    in_use_by: None,
                    error: Some("name is required".to_string()),
                },
            ));
        };
        if name.is_empty() {
            return Ok(env_get_reply(
                &msg.id,
                ClientEnvGetResponsePayload {
                    success: false,
                    content: None,
                    in_use_by: None,
                    error: Some("name is required".to_string()),
                },
            ));
        }

        let in_use_by = self
            .env_service
            .usage
            .sessions_using(&name, source, agent_id.as_deref());

        let result = match source {
            EnvSource::Server => self
                .env_service
                .store
                .read(&name)
                .await
                .map_err(|e| e.to_string()),
            EnvSource::Agent => match &agent_id {
                Some(aid) => self
                    .agent_command(aid, "agent.env.get", json!({ "name": name }))
                    .await
                    .and_then(|resp| {
                        if resp.get("success").and_then(serde_json::Value::as_bool) == Some(true) {
                            Ok(resp
                                .get("content")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string())
                        } else {
                            Err(resp
                                .get("error")
                                .and_then(|v| v.as_str())
                                .unwrap_or("read failed")
                                .to_string())
                        }
                    }),
                None => Err("agent_id is required for agent files".to_string()),
            },
        };

        match result {
            Ok(content) => Ok(env_get_reply(
                &msg.id,
                ClientEnvGetResponsePayload {
                    success: true,
                    content: Some(content),
                    in_use_by: Some(in_use_by),
                    error: None,
                },
            )),
            Err(e) => Ok(env_get_reply(
                &msg.id,
                ClientEnvGetResponsePayload {
                    success: false,
                    content: None,
                    in_use_by: Some(in_use_by),
                    error: Some(e),
                },
            )),
        }
    }
}
