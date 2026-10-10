//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{json, ConnectionHandler, ProtocolMessage, HandlerAction, session_env_reply, ClientSessionEnvResponsePayload, ClientSessionEnvUnsetPayload, reply_json};

impl ConnectionHandler {
    /// Handle `server.session.env.unset` — remove attach-time env files from a
    /// running session (on detach).
    pub(super) async fn handle_client_session_env_unset(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary, same as `env.apply`. Its one wire
        // change is on the success branch below, which used to send
        // `{success: true}` with no `warnings` at all.
        if !self.authenticated_client {
            return Ok(session_env_reply(
                &msg.id,
                "server.session.env.unset",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some("Not authenticated".to_string()),
                    warnings: Vec::new(),
                },
            ));
        }
        let ClientSessionEnvUnsetPayload {
            session_id,
            env_files: refs,
        } = serde_json::from_value(msg.payload).unwrap_or_else(|_| ClientSessionEnvUnsetPayload {
            session_id: String::new(),
            env_files: Vec::new(),
        });

        let Some((agent_id, session_name)) = session_id.split_once(':') else {
            return Ok(session_env_reply(
                &msg.id,
                "server.session.env.unset",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some("Invalid session_id".to_string()),
                    warnings: Vec::new(),
                },
            ));
        };
        let agent_id = agent_id.to_string();
        let session_name = session_name.to_string();

        // Resolve the keys to unset from the current file content. Best-effort:
        // if a file is now missing, skip it rather than failing the detach.
        let snapshots = self
            .resolve_snapshots(&agent_id, &refs)
            .await
            .unwrap_or_default();
        let keys: Vec<String> = snapshots
            .iter()
            .flat_map(|s| s.vars.iter().map(|(k, _)| k.clone()))
            .collect();

        let resp = self
            .agent_command(
                &agent_id,
                "agent.session.env.unset",
                json!({ "name": session_name, "keys": keys }),
            )
            .await;

        // Release the usage regardless of the agent's reply — the client's
        // intent to detach is authoritative for lock purposes.
        self.env_service
            .usage
            .remove_attach(&session_id, &refs, None);

        match resp {
            Ok(r) if r.get("success").and_then(serde_json::Value::as_bool) == Some(true) => {
                // The branch whose wire changes: `warnings` is always
                // serialised, so a successful unset now says `warnings: []`
                // where it previously said nothing. True — there were none.
                Ok(session_env_reply(
                    &msg.id,
                    "server.session.env.unset",
                    ClientSessionEnvResponsePayload {
                        success: true,
                        error: None,
                        warnings: Vec::new(),
                    },
                ))
            }
            Ok(r) => Ok(reply_json(
                &msg.id,
                "server.session.env.unset",
                json!({
                    "success": false,
                    "error": r.get("error").and_then(|v| v.as_str()).unwrap_or("unset failed")
                }),
            )),
            Err(e) => Ok(session_env_reply(
                &msg.id,
                "server.session.env.unset",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some(e),
                    warnings: Vec::new(),
                },
            )),
        }
    }
}
