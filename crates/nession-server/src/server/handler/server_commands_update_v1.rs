//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::*;

impl ConnectionHandler {
    pub(super) async fn handle_client_commands_update(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "server.commands.update",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let payload = msg.payload;
        let id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        if id.is_empty() {
            return Ok(reply_json(
                &msg.id,
                "server.commands.update",
                json!({ "success": false, "error": "id is required" }),
            ));
        }
        let label = payload.get("label").and_then(|v| v.as_str());
        let command = payload.get("command").and_then(|v| v.as_str());
        let raw = payload.get("raw").and_then(serde_json::Value::as_bool);

        match self.db.update_quick_command(&id, label, command, raw).await {
            Ok(true) => {
                self.web_client_registry.broadcast_commands_changed().await;
                Ok(reply_json(
                    &msg.id,
                    "server.commands.update",
                    json!({ "success": true }),
                ))
            }
            Ok(false) => Ok(reply_json(
                &msg.id,
                "server.commands.update",
                json!({ "success": false, "error": "Command not found" }),
            )),
            Err(e) => Ok(reply_json(
                &msg.id,
                "server.commands.update",
                json!({ "success": false, "error": e.to_string() }),
            )),
        }
    }
}
