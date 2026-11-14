//! `server.workspace.delete` — explicit managed Workspace deletion (#3407).
//!
//! Only the Agent decides whether a Workspace is deletable (managed, unmounted
//! and unreferenced). The Server authorizes the Session target and relays the
//! decision.

use super::{
    info, json, reply_json, warn, ConnectionHandler, Duration, HandlerAction, ProtocolMessage,
};
use nession_protocol::contracts::workspace::v1::{
    is_valid_workspace_id, ClientWorkspaceDeletePayload, WorkspaceDeleteResponse,
};

const WORKSPACE_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

impl ConnectionHandler {
    pub(super) async fn handle_client_workspace_delete(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let id = msg.id.clone();
        let refusal = |message: &str| {
            reply_json(
                &id,
                "server.workspace.delete",
                serde_json::to_value(WorkspaceDeleteResponse {
                    success: false,
                    error: Some(message.to_string()),
                })
                .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
            )
        };
        if !self.authenticated_client {
            return Ok(refusal("Not authenticated"));
        }
        let Ok(payload) = serde_json::from_value::<ClientWorkspaceDeletePayload>(msg.payload)
        else {
            return Ok(refusal("session_id and workspace_id are required"));
        };
        if payload.session_id.is_empty() {
            return Ok(refusal("session_id is required"));
        }
        if !is_valid_workspace_id(&payload.workspace_id) {
            return Ok(refusal(
                "workspace_id is not a valid managed Workspace identity",
            ));
        }
        let (agent_id, session_name) = match self.sandbox_session_target(&payload.session_id).await
        {
            Ok(target) => target,
            Err(error) => return Ok(refusal(&error)),
        };
        info!(
            "Deleting a managed Workspace: agent_id={agent_id}, session_name={session_name}, workspace_id={}",
            payload.workspace_id
        );
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.workspace.delete",
                json!({ "workspace_id": payload.workspace_id }),
                WORKSPACE_COMMAND_TIMEOUT,
            )
            .await
        {
            Ok(response)
                if response.get("success").and_then(serde_json::Value::as_bool) == Some(true) =>
            {
                Ok(reply_json(
                    &id,
                    "server.workspace.delete",
                    serde_json::to_value(WorkspaceDeleteResponse {
                        success: true,
                        error: None,
                    })
                    .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
                ))
            }
            Ok(response) => {
                let message = response
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent could not delete the Workspace");
                Ok(refusal(message))
            }
            Err(error) => {
                warn!("Workspace delete failed: {error}");
                Ok(refusal(&error))
            }
        }
    }
}
