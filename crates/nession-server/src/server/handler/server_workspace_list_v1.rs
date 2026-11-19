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
    validate_workspace_namespace, workspace_namespace_for_project, AgentWorkspaceDescriptor,
    AgentWorkspaceKind, AgentWorkspaceStatus, ClientWorkspaceListPayload, WorkspaceListResponse,
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
                let mut workspaces = match response.get("workspaces").cloned() {
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
                match self
                    .project_location_descriptors(
                        &agent_id,
                        &payload.session_id,
                        payload.namespace.as_deref(),
                    )
                    .await
                {
                    Ok(locations) => workspaces.extend(locations),
                    Err(error) => return Ok(refusal(&error)),
                }
                for workspace in &workspaces {
                    if let Err(error) = workspace.validate() {
                        warn!("Agent or Server returned an invalid Workspace descriptor: {error}");
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

    /// The Session Project's Existing Locations on the resolved Agent (#3797).
    ///
    /// The Agent inventory owns managed Workspaces only. Project Existing
    /// Locations are declarations the Server can name but the Agent does not
    /// own: they are reported as `unobserved`, never as available or leased,
    /// and deletion is never offered for them. A Project read failure refuses
    /// the whole inventory instead of presenting a partial one.
    async fn project_location_descriptors(
        &self,
        agent_id: &str,
        session_id: &str,
        namespace_filter: Option<&str>,
    ) -> Result<Vec<AgentWorkspaceDescriptor>, String> {
        let binding = self
            .db
            .get_session_project_binding(session_id)
            .await
            .map_err(|error| {
                format!("the Session's Project binding could not be read: {error:#}")
            })?;
        let Some(binding) = binding else {
            return Ok(Vec::new());
        };
        let Some(project) = self
            .db
            .get_project(&binding.project_id)
            .await
            .map_err(|error| format!("the Session's Project could not be read: {error:#}"))?
        else {
            return Ok(Vec::new());
        };
        let namespace = workspace_namespace_for_project(Some(&project.project_id));
        if let Some(filter) = namespace_filter {
            if !filter.is_empty() && filter != namespace {
                return Ok(Vec::new());
            }
        }
        Ok(project
            .locations
            .iter()
            .filter(|location| location.agent_id == agent_id)
            .enumerate()
            .map(|(index, location)| {
                let basename = std::path::Path::new(&location.path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default();
                let mut name = if basename.trim().is_empty() {
                    format!("Project Location {}", index + 1)
                } else {
                    basename.to_string()
                };
                if name == "." || name == ".." {
                    name = format!("Project Location {}", index + 1);
                }
                AgentWorkspaceDescriptor {
                    workspace_id: format!("project_location:{agent_id}:{}", location.path),
                    name,
                    namespace: namespace.clone(),
                    kind: AgentWorkspaceKind::ProjectLocation,
                    status: AgentWorkspaceStatus::Unobserved,
                    auto_created: false,
                    created_at: u64::try_from(project.created_at).unwrap_or(0),
                    last_used_at: u64::try_from(project.updated_at).unwrap_or(0),
                    updated_at: u64::try_from(project.updated_at).unwrap_or(0),
                    path: Some(location.path.clone()),
                    detail: Some(
                        "User-owned Project Existing Location; the Agent never creates, copies or deletes it."
                            .to_string(),
                    ),
                    lower_digests: Vec::new(),
                    overlay_storage: false,
                    used_bytes: None,
                    consumers: Vec::new(),
                    mounted: false,
                    lease_count: 0,
                }
            })
            .collect())
    }
}
