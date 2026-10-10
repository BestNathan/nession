//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{json, reply_json, ConnectionHandler, HandlerAction, ProtocolMessage};

impl ConnectionHandler {
    pub(super) async fn handle_client_commands_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "server.commands.list",
                json!({ "commands": [], "error": "Not authenticated" }),
            ));
        }
        let commands = self.db.list_quick_commands().await.unwrap_or_default();
        let items: Vec<serde_json::Value> = commands
            .into_iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "label": c.label,
                    "command": c.command,
                    "raw": c.raw,
                    "sort_order": c.sort_order,
                    "created_at": c.created_at,
                })
            })
            .collect();
        Ok(reply_json(
            &msg.id,
            "server.commands.list",
            json!({ "commands": items }),
        ))
    }
}
