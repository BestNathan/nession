//! `server.workspace.list` — the current Session Agent's managed Workspace
//! inventory (#3407).
//!
//! The Server authenticates the client, resolves the Session's Agent and
//! relays the Agent's measured inventory. It does not cache or synthesize a
//! registry of its own.

use super::{
    info, json, reply_json, warn, ConnectionHandler, Duration, HandlerAction, ProtocolMessage,
};
use nession_protocol::contracts::workspace::v1::{
    validate_workspace_namespace, AgentWorkspaceDescriptor, ClientWorkspaceListPayload,
    WorkspaceListResponse,
};

const WORKSPACE_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

impl ConnectionHandler {
    pub(super) async fn handle_client_workspace_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let id = msg.id.clone();
        let refusal = |message: &str| {
            reply_json(
                &id,
                "server.workspace.list",
                serde_json::to_value(WorkspaceListResponse {
                    success: false,
                    error: Some(message.to_string()),
                    workspaces: Vec::new(),
                })
                .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
            )
        };
        if !self.authenticated_client {
            return Ok(refusal("Not authenticated"));
        }
        let Ok(payload) = serde_json::from_value::<ClientWorkspaceListPayload>(msg.payload) else {
            return Ok(refusal("session_id is required"));
        };
        if payload.session_id.is_empty() {
            return Ok(refusal("session_id is required"));
        }
        if let Some(namespace) = &payload.namespace {
            if let Err(error) = validate_workspace_namespace(namespace) {
                return Ok(refusal(&error));
            }
        }
        let (agent_id, session_name) = match self.sandbox_session_target(&payload.session_id).await
        {
            Ok(target) => target,
            Err(error) => return Ok(refusal(&error)),
        };
        info!(
            "Requesting the Workspace inventory: agent_id={agent_id}, session_name={session_name}"
        );
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.workspace.list",
                json!({ "namespace": payload.namespace }),
                WORKSPACE_COMMAND_TIMEOUT,
            )
            .await
        {
            Ok(response)
                if response.get("success").and_then(serde_json::Value::as_bool) == Some(true) =>
            {
                let workspaces = match response.get("workspaces").cloned() {
                    Some(value) => {
                        match serde_json::from_value::<Vec<AgentWorkspaceDescriptor>>(value) {
                            Ok(workspaces) => workspaces,
                            Err(error) => {
                                warn!("Agent returned an unreadable Workspace inventory: {error}");
                                return Ok(refusal(
                                    "Agent returned an unreadable Workspace inventory",
                                ));
                            }
                        }
                    }
                    None => Vec::new(),
                };
                for workspace in &workspaces {
                    if let Err(error) = workspace.validate() {
                        warn!("Agent returned an invalid Workspace descriptor: {error}");
                        return Ok(refusal("Agent returned an invalid Workspace descriptor"));
                    }
                }
                Ok(reply_json(
                    &id,
                    "server.workspace.list",
                    serde_json::to_value(WorkspaceListResponse {
                        success: true,
                        error: None,
                        workspaces,
                    })
                    .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
                ))
            }
            Ok(response) => {
                let message = response
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent could not read the Workspace inventory");
                Ok(refusal(message))
            }
            Err(error) => Ok(refusal(&error)),
        }
    }
}
