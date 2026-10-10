//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{json, ConnectionHandler, ProtocolMessage, HandlerAction, reply_json};

impl ConnectionHandler {
    pub(super) async fn handle_client_commands_add(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "server.commands.add",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let payload = msg.payload;
        let label = payload
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        let command = payload
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        let raw = payload
            .get("raw")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        if label.is_empty() || command.is_empty() {
            return Ok(reply_json(
                &msg.id,
                "server.commands.add",
                json!({ "success": false, "error": "Label and command are required" }),
            ));
        }

        let id = format!("user-{}", uuid::Uuid::new_v4());
        let now = chrono::Utc::now().timestamp();
        let row = crate::db::QuickCommandRow {
            id: id.clone(),
            label,
            command,
            raw,
            sort_order: 0,
            created_at: now,
        };
        if let Err(e) = self.db.upsert_quick_command(&row).await {
            return Ok(reply_json(
                &msg.id,
                "server.commands.add",
                json!({ "success": false, "error": e.to_string() }),
            ));
        }
        self.web_client_registry.broadcast_commands_changed().await;
        Ok(reply_json(
            &msg.id,
            "server.commands.add",
            json!({ "success": true, "id": id }),
        ))
    }
}
