//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    agent_rename_reply, info, validate_display_name, AgentRenameFailure, AgentRenameReply,
    AgentRenameResponse, ConnectionHandler, HandlerAction, ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.agent.rename` — update an agent's display name.
    /// Accepts `agent_id` and `display_name` (string or null to clear).
    /// Returns the updated agent info on success.
    pub(super) async fn handle_client_agent_rename(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. The success branch below now goes
        // through `agent_view::agent_to_view` like `server.agent.list` does —
        // it used to build a second agent block by hand, twelve fields against
        // the builder's thirteen, and it had drifted in exactly the two ways
        // that builder's doc comment describes as fixed.
        let refusal = |error: &str| {
            AgentRenameReply::Refused(AgentRenameFailure {
                success: false,
                error: error.to_string(),
            })
        };

        if !self.authenticated_client {
            return Ok(agent_rename_reply(&msg.id, refusal("Not authenticated")));
        }

        let agent_id = msg
            .payload
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if agent_id.is_empty() {
            return Ok(agent_rename_reply(&msg.id, refusal("agent_id is required")));
        }

        // Resolve the new display_name: JSON null → clear, string → validate
        let raw: Option<String> = msg
            .payload
            .get("display_name")
            .and_then(|v| {
                if v.is_null() {
                    Some(None) // explicit null = clear
                } else {
                    v.as_str().map(|s| Some(s.to_string()))
                }
            })
            .flatten();

        let display_name = match raw {
            Some(ref s) => match validate_display_name(s) {
                Ok(Some(normalized)) => Some(normalized),
                Ok(None) => None, // empty after trim → clear
                Err(e) => {
                    return Ok(agent_rename_reply(&msg.id, refusal(&e)));
                }
            },
            None => None, // explicit null → clear
        };

        info!(
            "Rename agent {} display_name: {:?} -> {:?}",
            agent_id,
            self.agent_registry
                .get(agent_id)
                .await
                .and_then(|a| a.display_name),
            display_name
        );

        match self
            .agent_registry
            .update_display_name(agent_id, display_name.clone())
            .await
        {
            Some(updated) => Ok(agent_rename_reply(
                &msg.id,
                AgentRenameReply::Renamed(Box::new(AgentRenameResponse {
                    success: true,
                    // The one builder, which is what removes the drift this arm
                    // used to carry: `protocols` and `metadata.image_tag` were
                    // both missing from the block that was here.
                    agent: crate::server::agent_view::agent_to_view(&updated),
                })),
            )),
            None => Ok(agent_rename_reply(
                &msg.id,
                refusal(&format!("Agent '{agent_id}' not found")),
            )),
        }
    }
}
