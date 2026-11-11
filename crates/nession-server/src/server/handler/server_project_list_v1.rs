//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::project::project_json;
use super::{json, reply_json, ConnectionHandler, HandlerAction, ProtocolMessage};

impl ConnectionHandler {
    /// `server.project.list` — every Project, independent of Session state.
    ///
    /// A failed read reports `error` with an empty list rather than pretending
    /// the user has no Projects, the same distinction `server.commands.list`
    /// made (#2784).
    pub(super) async fn handle_client_project_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "server.project.list",
                json!({ "projects": [], "error": "Not authenticated" }),
            ));
        }
        let rows = match self.db.list_projects().await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::error!("Failed to read projects: {e:#}");
                return Ok(reply_json(
                    &msg.id,
                    "server.project.list",
                    json!({ "projects": [], "error": "Projects could not be loaded" }),
                ));
            }
        };
        let projects: Vec<serde_json::Value> = rows.iter().map(project_json).collect();
        Ok(reply_json(
            &msg.id,
            "server.project.list",
            json!({ "projects": projects }),
        ))
    }
}
