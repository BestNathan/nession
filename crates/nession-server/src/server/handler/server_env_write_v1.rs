//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    env_write_reply, json, parse_env, ClientEnvWritePayload, ClientEnvWriteResponsePayload,
    ConnectionHandler, EnvSource, HandlerAction, ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.env.write` — create/overwrite an env file. Blocks writes
    /// to files currently in use by a running session (SC5/EC10).
    pub(super) async fn handle_client_env_write(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. Three fields used to be read off the
        // payload beside the parser — `content`, `overwrite` and `force` — and
        // only the first two were declared.
        let refusal = |error: &str| ClientEnvWriteResponsePayload {
            success: false,
            exists: false,
            error: Some(error.to_string()),
            warnings: Vec::new(),
            in_use_by: None,
            re_sourced: None,
            re_source_errors: None,
        };

        if !self.authenticated_client {
            return Ok(env_write_reply(&msg.id, refusal("Not authenticated")));
        }
        let Ok(ClientEnvWritePayload {
            name,
            source,
            agent_id,
            content,
            overwrite,
            force,
        }) = serde_json::from_value(msg.payload)
        else {
            return Ok(env_write_reply(&msg.id, refusal("name is required")));
        };

        if name.is_empty() {
            return Ok(env_write_reply(&msg.id, refusal("name is required")));
        }

        // In-use lock: an overwrite of a file bound to a running session is
        // refused with a clear message listing the sessions, unless `force` is
        // set (caller accepts the risk and re-sources the file afterwards).
        if overwrite && !force {
            let in_use = self
                .env_service
                .bindings
                .sessions_using(&name, source, agent_id.as_deref())
                .await;
            if !in_use.is_empty() {
                return Ok(env_write_reply(
                    &msg.id,
                    ClientEnvWriteResponsePayload {
                        error: Some(format!(
                            "This file is in use by session(s): {}. Stop the session or detach before editing.",
                            in_use.join(", ")
                        )),
                        in_use_by: Some(in_use),
                        ..refusal("")
                    },
                ));
            }
        }

        let warnings = parse_env(&content).warnings;

        let outcome = match source {
            EnvSource::Server => self
                .env_service
                .store
                .write(&name, &content, overwrite)
                .await
                .map_err(|e| e.to_string()),
            EnvSource::Agent => match &agent_id {
                Some(aid) => self
                    .agent_command(
                        aid,
                        "agent.env.write",
                        json!({ "name": name, "content": content, "overwrite": overwrite }),
                    )
                    .await
                    .map(|resp| {
                        // Agent returns success=true on write, exists=true when
                        // refused for lack of overwrite.
                        resp.get("success").and_then(serde_json::Value::as_bool) == Some(true)
                    }),
                None => Err("agent_id is required for agent files".to_string()),
            },
        };

        match outcome {
            Ok(true) => {
                // A profile save is not a Session mutation (#170). Bound
                // Sessions keep the revision they materialized; the explicit
                // `server.session.env.binding.reapply` is what advances one.
                // The response keeps the old fields for the shipped Web client,
                // always empty because nothing was re-sourced.
                Ok(env_write_reply(
                    &msg.id,
                    ClientEnvWriteResponsePayload {
                        success: true,
                        exists: false,
                        error: None,
                        warnings,
                        in_use_by: None,
                        re_sourced: Some(Vec::new()),
                        re_source_errors: Some(Vec::new()),
                    },
                ))
            }
            // Refused for existing, which carries `exists` and no error — the
            // UI prompts for confirmation rather than reporting a failure.
            Ok(false) => Ok(env_write_reply(
                &msg.id,
                ClientEnvWriteResponsePayload {
                    success: false,
                    exists: true,
                    error: None,
                    warnings: Vec::new(),
                    in_use_by: None,
                    re_sourced: None,
                    re_source_errors: None,
                },
            )),
            Err(e) => Ok(env_write_reply(&msg.id, refusal(&e))),
        }
    }
}
