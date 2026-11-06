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
        // A failed read is a failed read, not an empty collection (#2784).
        // The cause belongs in the log; the reply says only that the list is
        // unavailable, so the Web can offer its retry state instead of
        // claiming the user has no saved commands.
        let commands = match self.db.list_quick_commands().await {
            Ok(commands) => commands,
            Err(e) => {
                tracing::error!("Failed to read saved commands: {e:#}");
                return Ok(reply_json(
                    &msg.id,
                    "server.commands.list",
                    json!({
                        "commands": [],
                        "error": "Saved commands could not be loaded",
                    }),
                ));
            }
        };
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
