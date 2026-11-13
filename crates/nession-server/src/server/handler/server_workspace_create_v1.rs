//! `server.workspace.create` — idempotent managed Workspace get-or-create
//! (#3407).
//!
//! The Agent owns name uniqueness, the stable id, the durable directory and
//! the race-safe allocation. The Server only authorizes the Session target and
//! relays the request.

use super::{
    info, json, reply_json, warn, ConnectionHandler, Duration, HandlerAction, ProtocolMessage,
};
use nession_protocol::contracts::workspace::v1::{
    validate_workspace_name, validate_workspace_namespace, AgentWorkspaceDescriptor,
    ClientWorkspaceCreatePayload, WorkspaceCreateResponse,
};

const WORKSPACE_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

impl ConnectionHandler {
    pub(super) async fn handle_client_workspace_create(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let id = msg.id.clone();
        let refusal = |message: &str| {
            reply_json(
                &id,
                "server.workspace.create",
                serde_json::to_value(WorkspaceCreateResponse {
                    success: false,
                    error: Some(message.to_string()),
                    workspace: None,
                })
                .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
            )
        };
        if !self.authenticated_client {
            return Ok(refusal("Not authenticated"));
        }
        let Ok(payload) = serde_json::from_value::<ClientWorkspaceCreatePayload>(msg.payload)
        else {
            return Ok(refusal("session_id and name are required"));
        };
        if payload.session_id.is_empty() {
            return Ok(refusal("session_id is required"));
        }
        if let Err(error) = validate_workspace_name(&payload.name) {
            return Ok(refusal(&error));
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
            "Resolving a managed Workspace: agent_id={agent_id}, session_name={session_name}, name={}",
            payload.name
        );
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.workspace.create",
                json!({
                    "name": payload.name,
                    "namespace": payload.namespace,
                    "auto_created": payload.auto_created,
                }),
                WORKSPACE_COMMAND_TIMEOUT,
            )
            .await
        {
            Ok(response)
                if response.get("success").and_then(serde_json::Value::as_bool) == Some(true) =>
            {
                let workspace = response.get("workspace").cloned().and_then(|value| {
                    serde_json::from_value::<AgentWorkspaceDescriptor>(value).ok()
                });
                match workspace {
                    Some(workspace) => {
                        if let Err(error) = workspace.validate() {
                            warn!("Agent returned an invalid Workspace descriptor: {error}");
                            return Ok(refusal("Agent returned an invalid Workspace descriptor"));
                        }
                        Ok(reply_json(
                            &id,
                            "server.workspace.create",
                            serde_json::to_value(WorkspaceCreateResponse {
                                success: true,
                                error: None,
                                workspace: Some(workspace),
                            })
                            .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
                        ))
                    }
                    None => {
                        warn!("Agent returned no Workspace for a successful create");
                        Ok(refusal(
                            "Agent returned no Workspace for a successful create",
                        ))
                    }
                }
            }
            Ok(response) => {
                let message = response
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent could not resolve the Workspace");
                Ok(refusal(message))
            }
            Err(error) => Ok(refusal(&error)),
        }
    }
}
