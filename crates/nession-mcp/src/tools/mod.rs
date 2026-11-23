//! MCP baseline Session Tools plus Server-owned ENV file and Session
//! Environment Binding management.
//!
//! This module only declares the Tool modules and registers their handlers
//! with one [`ToolRegistry`]. It deliberately contains **no** `match name`
//! dispatch: a Tool's identity, schema, validation and execution live in its
//! own `<mcp_tool_name>.rs` file.

mod env_target;
pub mod nession_agent_create_session;
pub mod nession_agent_get_session_metadata;
pub mod nession_agent_kill_session;
pub mod nession_agent_list_sessions;
pub mod nession_agent_update_session_metadata;
pub mod nession_server_env_delete;
pub mod nession_server_env_get;
pub mod nession_server_env_list;
pub mod nession_server_env_write;
pub mod nession_server_list_agents;
pub mod nession_server_project_get;
pub mod nession_server_project_list;
pub mod nession_server_project_session_create;
pub mod nession_server_project_session_list;
pub mod nession_server_session_env_binding_get;
pub mod nession_server_session_env_binding_reapply;
pub mod nession_server_session_env_binding_set;

use std::sync::Arc;

use crate::registry::{RegistryError, ToolRegistry};
use crate::tool::ToolHandler;

/// The baseline Tools every host advertises.
///
/// The order is the advertised order and is stable: Server-owned discovery
/// first, then the Agent-owned Session operations. A host composes Extension
/// contributions on top of this list through [`crate::catalog::McpCatalog`];
/// this function never sees a provider.
pub fn baseline_handlers() -> Vec<Arc<dyn ToolHandler>> {
    vec![
        Arc::new(nession_server_list_agents::NessionServerListAgents) as Arc<dyn ToolHandler>,
        Arc::new(nession_server_project_list::NessionServerProjectList),
        Arc::new(nession_server_project_get::NessionServerProjectGet),
        Arc::new(nession_server_project_session_list::NessionServerProjectSessionList),
        Arc::new(nession_server_project_session_create::NessionServerProjectSessionCreate),
        Arc::new(nession_server_env_list::NessionServerEnvList),
        Arc::new(nession_server_env_get::NessionServerEnvGet),
        Arc::new(nession_server_env_write::NessionServerEnvWrite),
        Arc::new(nession_server_env_delete::NessionServerEnvDelete),
        Arc::new(nession_server_session_env_binding_get::NessionServerSessionEnvBindingGet),
        Arc::new(nession_server_session_env_binding_set::NessionServerSessionEnvBindingSet),
        Arc::new(nession_server_session_env_binding_reapply::NessionServerSessionEnvBindingReapply),
        Arc::new(nession_agent_list_sessions::NessionAgentListSessions),
        Arc::new(nession_agent_create_session::NessionAgentCreateSession),
        Arc::new(nession_agent_kill_session::NessionAgentKillSession),
        Arc::new(nession_agent_get_session_metadata::NessionAgentGetSessionMetadata),
        Arc::new(nession_agent_update_session_metadata::NessionAgentUpdateSessionMetadata),
    ]
}

/// Build the baseline-only catalog.
///
/// Hosts that compose Extension contributions build a
/// [`crate::catalog::McpCatalog`] instead; both paths register the same
/// baseline Tools in the same order.
pub fn registry() -> Result<ToolRegistry, RegistryError> {
    ToolRegistry::build(baseline_handlers())
}

/// The exact names this service advertises.
pub const TOOL_NAMES: &[&str] = &[
    "nession_server_list_agents",
    "nession_server_project_list",
    "nession_server_project_get",
    "nession_server_project_session_list",
    "nession_server_project_session_create",
    "nession_server_env_list",
    "nession_server_env_get",
    "nession_server_env_write",
    "nession_server_env_delete",
    "nession_server_session_env_binding_get",
    "nession_server_session_env_binding_set",
    "nession_server_session_env_binding_reapply",
    "nession_agent_list_sessions",
    "nession_agent_create_session",
    "nession_agent_kill_session",
    "nession_agent_get_session_metadata",
    "nession_agent_update_session_metadata",
];

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use nession_protocol::contracts::agent::v1::WebAgentsListResponse;
    use nession_protocol::contracts::project::v1::{
        ProjectGetPayload, ProjectGetResponsePayload, ProjectListResponsePayload,
    };
    use serde_json::{json, Value};

    use crate::backend::{ClusterBackend, NodeBackend};
    use crate::error::ToolError;
    use crate::tool::ToolContext;
    use crate::tools::nession_agent_create_session::SessionCreatedOutput;
    use crate::tools::nession_agent_list_sessions::SessionListOutput;
    use nession_protocol::contracts::env::v1::{
        ClientEnvDeletePayload, ClientEnvDeleteResponsePayload, ClientEnvGetPayload,
        ClientEnvGetResponsePayload, ClientEnvListResponsePayload, ClientEnvWritePayload,
        ClientEnvWriteResponsePayload, EnvFileRef, EnvSource,
    };
    use nession_protocol::contracts::session::v1::{
        ClientSessionCreatePayload, ClientSessionCreateResponsePayload,
        ClientSessionEnvBindingGetPayload, ClientSessionEnvBindingReapplyPayload,
        ClientSessionEnvBindingResponsePayload, ClientSessionEnvBindingSetPayload,
        SessionInitialMetadata, SessionKillResponse, SessionMetadataPatchPayload,
        SessionMetadataResponse, WebSessionsListResponse,
    };

    /// What one Tool call asked the backend for.
    #[derive(Debug, Clone, PartialEq)]
    pub enum Recorded {
        ListAgents,
        ListServerSessions(Option<String>, bool),
        ProjectList,
        ProjectGet(String),
        CreateProjectSession(Value),
        EnvList,
        EnvGet(String, EnvSource, Option<String>),
        EnvWrite(String, EnvSource, Option<String>, String, bool, bool),
        EnvDelete(String, EnvSource, Option<String>, bool),
        BindingGet(String),
        BindingSet(String, u64, Vec<EnvFileRef>),
        BindingReapply(String, u64),
        ListSessions(String),
        CreateSession(
            String,
            String,
            Option<String>,
            Option<SessionInitialMetadata>,
        ),
        KillSession(String, String, String),
        GetSessionMetadata(String, String),
        UpdateSessionMetadata(String, SessionMetadataPatchPayload),
    }

    /// A backend pair that records calls and answers a canned reply.
    pub struct Recording {
        pub calls: Mutex<Vec<Recorded>>,
        /// `agent.session.list`-style reply for the Node seam.
        pub node_sessions: Mutex<Value>,
        /// `server.session.list`-style reply for the Cluster seam.
        pub server_sessions: Mutex<Value>,
        pub project_list_reply: Mutex<Value>,
        pub project_get_reply: Mutex<Value>,
        /// Optional explicit create reply; `None` echoes the request's
        /// `project_id` as a confirmed association.
        pub create_project_session_reply: Mutex<Option<Value>>,
        /// Canned reply for the Agent metadata get/update seams.
        pub metadata_reply: Mutex<Value>,
    }

    impl Default for Recording {
        fn default() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                node_sessions: Mutex::new(json!({ "sessions": [], "stale_agents": [] })),
                server_sessions: Mutex::new(json!({ "sessions": [], "stale_agents": [] })),
                project_list_reply: Mutex::new(json!({ "projects": [] })),
                project_get_reply: Mutex::new(json!({
                    "success": true,
                    "project": project_fixture("project-123e4567-e89b-42d3-a456-426614174000")
                })),
                create_project_session_reply: Mutex::new(None),
                metadata_reply: Mutex::new(json!({
                    "success": true,
                    "metadata": { "revision": 0, "tags": [] },
                    "instance_id": "instance-a"
                })),
            }
        }
    }

    /// One canonical Project JSON fixture.
    pub fn project_fixture(project_id: &str) -> Value {
        json!({
            "project_id": project_id,
            "name": "Fixture Project",
            "description": "a test declaration",
            "source": { "repository_url": "https://example.com/repo.git", "ref": "main" },
            "locations": [{ "agent_id": "agent-1", "path": "/srv/project" }],
            "session_defaults": {
                "shell": "bash",
                "env_profile_ids": ["base.env"],
                "sandbox_policy_ref": "default"
            },
            "image_digest": null,
            "created_at": 1,
            "updated_at": 2
        })
    }

    impl Recording {
        pub fn calls(&self) -> Vec<Recorded> {
            self.calls.lock().expect("recording lock").clone()
        }

        pub fn set_node_sessions(&self, sessions: &[Value]) {
            *self.node_sessions.lock().expect("node sessions") =
                json!({ "sessions": sessions, "stale_agents": [] });
        }

        pub fn set_server_sessions(&self, sessions: &[Value]) {
            *self.server_sessions.lock().expect("server sessions") =
                json!({ "sessions": sessions, "stale_agents": [] });
        }

        pub fn set_project_list_reply(&self, reply: Value) {
            *self.project_list_reply.lock().expect("project list") = reply;
        }

        pub fn set_project_get_reply(&self, reply: Value) {
            *self.project_get_reply.lock().expect("project get") = reply;
        }

        pub fn set_create_project_session_reply(&self, reply: Value) {
            *self
                .create_project_session_reply
                .lock()
                .expect("create project session") = Some(reply);
        }

        pub fn set_metadata_reply(&self, reply: Value) {
            *self.metadata_reply.lock().expect("metadata reply") = reply;
        }

        fn metadata_reply(&self) -> Result<SessionMetadataResponse, ToolError> {
            let reply = self.metadata_reply.lock().expect("metadata reply").clone();
            serde_json::from_value(reply).map_err(|error| ToolError::backend(error.to_string()))
        }
    }

    #[async_trait]
    impl ClusterBackend for Recording {
        async fn list_agents(&self) -> Result<WebAgentsListResponse, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::ListAgents);
            serde_json::from_value(json!({ "agents": [] }))
                .map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn list_sessions(
            &self,
            agent_id: Option<&str>,
            force: bool,
        ) -> Result<WebSessionsListResponse, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::ListServerSessions(
                    agent_id.map(str::to_owned),
                    force,
                ));
            let reply = self
                .server_sessions
                .lock()
                .expect("server sessions")
                .clone();
            serde_json::from_value(reply).map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn project_list(&self) -> Result<ProjectListResponsePayload, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::ProjectList);
            let reply = self
                .project_list_reply
                .lock()
                .expect("project list")
                .clone();
            serde_json::from_value(reply).map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn project_get(
            &self,
            payload: ProjectGetPayload,
        ) -> Result<ProjectGetResponsePayload, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::ProjectGet(payload.project_id));
            let reply = self.project_get_reply.lock().expect("project get").clone();
            serde_json::from_value(reply).map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn create_project_session(
            &self,
            payload: ClientSessionCreatePayload,
        ) -> Result<ClientSessionCreateResponsePayload, ToolError> {
            let value = serde_json::to_value(&payload)
                .map_err(|error| ToolError::backend(error.to_string()))?;
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::CreateProjectSession(value));
            let explicit = self
                .create_project_session_reply
                .lock()
                .expect("create project session")
                .clone();
            let reply = explicit.unwrap_or_else(|| {
                json!({
                    "success": true,
                    "session_id": format!("{}:{}", payload.agent_id, payload.name),
                    "project_id": payload.project_id,
                    "warnings": []
                })
            });
            serde_json::from_value(reply).map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn env_list(&self) -> Result<ClientEnvListResponsePayload, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::EnvList);
            serde_json::from_value(json!({ "files": [] }))
                .map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn env_get(
            &self,
            payload: ClientEnvGetPayload,
        ) -> Result<ClientEnvGetResponsePayload, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::EnvGet(
                    payload.name,
                    payload.source,
                    payload.agent_id,
                ));
            serde_json::from_value(
                json!({ "success": true, "content": "PUBLIC=1\n", "in_use_by": [] }),
            )
            .map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn env_write(
            &self,
            payload: ClientEnvWritePayload,
        ) -> Result<ClientEnvWriteResponsePayload, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::EnvWrite(
                    payload.name,
                    payload.source,
                    payload.agent_id,
                    payload.content,
                    payload.overwrite,
                    payload.force,
                ));
            serde_json::from_value(json!({ "success": true, "exists": false, "warnings": [] }))
                .map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn env_delete(
            &self,
            payload: ClientEnvDeletePayload,
        ) -> Result<ClientEnvDeleteResponsePayload, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::EnvDelete(
                    payload.name,
                    payload.source,
                    payload.agent_id,
                    payload.force,
                ));
            serde_json::from_value(json!({ "success": true }))
                .map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn session_env_binding_get(
            &self,
            payload: ClientSessionEnvBindingGetPayload,
        ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::BindingGet(payload.session_id));
            serde_json::from_value(json!({
                "success": true,
                "binding": {
                    "session_id": "agent-a:dev",
                    "desired_revision": 3,
                    "desired_profiles": [],
                    "observed": {
                        "applied_revision": 3,
                        "status": "in_sync",
                        "profiles": [],
                        "managed_keys": ["PUBLIC"]
                    }
                },
                "warnings": []
            }))
            .map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn session_env_binding_set(
            &self,
            payload: ClientSessionEnvBindingSetPayload,
        ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError> {
            let expected = payload.expected_revision.expect("the Tool requires one");
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::BindingSet(
                    payload.session_id,
                    expected,
                    payload.profiles,
                ));
            serde_json::from_value(json!({ "success": true, "binding": null, "warnings": [] }))
                .map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn session_env_binding_reapply(
            &self,
            payload: ClientSessionEnvBindingReapplyPayload,
        ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError> {
            let expected = payload.expected_revision.expect("the Tool requires one");
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::BindingReapply(payload.session_id, expected));
            serde_json::from_value(json!({ "success": true, "binding": null, "warnings": [] }))
                .map_err(|error| ToolError::backend(error.to_string()))
        }
    }

    #[async_trait]
    impl NodeBackend for Recording {
        async fn list_sessions(&self, agent_id: &str) -> Result<SessionListOutput, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::ListSessions(agent_id.to_string()));
            let sessions = self.node_sessions.lock().expect("node sessions").clone();
            serde_json::from_value(sessions).map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn create_session(
            &self,
            agent_id: &str,
            name: &str,
            working_dir: Option<&str>,
            initial_metadata: Option<&SessionInitialMetadata>,
        ) -> Result<SessionCreatedOutput, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::CreateSession(
                    agent_id.to_string(),
                    name.to_string(),
                    working_dir.map(str::to_owned),
                    initial_metadata.cloned(),
                ));
            let metadata = initial_metadata.map(|metadata| {
                json!({
                    "revision": 1,
                    "title": metadata.title,
                    "description": metadata.description,
                    "tags": metadata.tags,
                    "created_at": 1,
                    "updated_at": 1,
                })
            });
            serde_json::from_value(json!({
                "name": name,
                "warnings": [],
                "instance_id": initial_metadata.map(|_| "instance-fixture"),
                "metadata": metadata,
            }))
            .map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn kill_session(
            &self,
            agent_id: &str,
            name: &str,
            expected_instance_id: &str,
        ) -> Result<SessionKillResponse, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::KillSession(
                    agent_id.to_string(),
                    name.to_string(),
                    expected_instance_id.to_string(),
                ));
            serde_json::from_value(json!({ "name": name }))
                .map_err(|error| ToolError::backend(error.to_string()))
        }

        async fn get_session_metadata(
            &self,
            agent_id: &str,
            name: &str,
        ) -> Result<SessionMetadataResponse, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::GetSessionMetadata(
                    agent_id.to_string(),
                    name.to_string(),
                ));
            self.metadata_reply()
        }

        async fn update_session_metadata(
            &self,
            agent_id: &str,
            request: SessionMetadataPatchPayload,
        ) -> Result<SessionMetadataResponse, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::UpdateSessionMetadata(
                    agent_id.to_string(),
                    request,
                ));
            self.metadata_reply()
        }
    }

    /// A context over one shared recorder.
    pub fn context(recorder: &Arc<Recording>) -> ToolContext {
        let cluster: Arc<dyn ClusterBackend> = recorder.clone();
        let node: Arc<dyn NodeBackend> = recorder.clone();
        ToolContext::new(cluster, node)
    }

    /// Arbitrary valid argument object.
    pub fn arguments(value: Value) -> serde_json::Map<String, Value> {
        value.as_object().expect("object arguments").clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recording};
    use nession_protocol::contracts::session::v1::SessionKillResponse;
    use std::collections::HashSet;
    use std::sync::Arc;

    #[test]
    fn registry_advertises_session_and_env_tools() {
        let catalog = registry().expect("registry");
        let names: Vec<_> = catalog
            .list()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect();
        assert_eq!(names, TOOL_NAMES);
    }

    #[test]
    fn every_registered_tool_advertises_a_documented_output_contract() {
        let catalog = registry().expect("registry");
        let tools = catalog.list();
        assert_eq!(tools.len(), 17, "the catalog is exactly 17 Tools");
        for tool in tools {
            let schema = tool
                .output_schema
                .as_ref()
                .unwrap_or_else(|| panic!("`{}` has no outputSchema", tool.name));
            let schema = serde_json::Value::Object((**schema).clone());
            assert_eq!(schema["type"], "object", "{}", tool.name);
            let properties = schema["properties"]
                .as_object()
                .unwrap_or_else(|| panic!("`{}` declares no fields", tool.name));
            assert!(!properties.is_empty(), "{}", tool.name);
            assert_documented(&schema, &schema, "", &mut HashSet::new());
        }
    }

    /// Every output field the Registry advertises must carry the description
    /// its Rust owner declared. A generated schema without descriptions would
    /// leave the Documents reader unable to explain the field (`#3735` SC-04).
    fn assert_documented(
        root: &serde_json::Value,
        node: &serde_json::Value,
        path: &str,
        trail: &mut HashSet<String>,
    ) {
        let node = resolve_ref(root, node, trail);
        if let Some(properties) = node
            .get("properties")
            .and_then(serde_json::Value::as_object)
        {
            for (name, property) in properties {
                let resolved = resolve_ref(root, property, trail);
                let description = property
                    .get("description")
                    .or_else(|| resolved.get("description"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                assert!(
                    !description.is_empty(),
                    "output field `{path}.{name}` has no authoritative description"
                );
                let next = if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}.{name}")
                };
                assert_documented(root, resolved, &next, trail);
                if let Some(items) = resolved.get("items") {
                    assert_documented(root, items, &format!("{next}[]"), trail);
                }
            }
        }
        for key in ["anyOf", "oneOf", "allOf"] {
            if let Some(branches) = node.get(key).and_then(serde_json::Value::as_array) {
                for branch in branches {
                    assert_documented(root, branch, path, trail);
                }
            }
        }
    }

    fn resolve_ref<'a>(
        root: &'a serde_json::Value,
        node: &'a serde_json::Value,
        trail: &mut HashSet<String>,
    ) -> &'a serde_json::Value {
        let mut current = node;
        loop {
            let Some(reference) = current.get("$ref").and_then(serde_json::Value::as_str) else {
                return current;
            };
            if !trail.insert(reference.to_string()) {
                return current;
            }
            let Some(target) = root.pointer(&reference[1..]) else {
                return current;
            };
            current = target;
        }
    }

    #[tokio::test]
    async fn representative_success_replies_conform_to_their_declared_output() {
        let recorder = Arc::new(Recording::default());
        let catalog = registry().expect("registry");
        let calls = [
            ("nession_server_list_agents", serde_json::json!({})),
            ("nession_server_project_list", serde_json::json!({})),
            (
                "nession_server_project_get",
                serde_json::json!({
                    "project_id": "project-123e4567-e89b-42d3-a456-426614174000"
                }),
            ),
            (
                "nession_server_project_session_list",
                serde_json::json!({
                    "project_id": "project-123e4567-e89b-42d3-a456-426614174000"
                }),
            ),
            (
                "nession_server_project_session_create",
                serde_json::json!({
                    "project_id": "project-123e4567-e89b-42d3-a456-426614174000",
                    "agent_id": "agent-a",
                    "name": "dev",
                    "target": { "kind": "existing", "working_dir": "/srv/project" }
                }),
            ),
            ("nession_server_env_list", serde_json::json!({})),
            (
                "nession_server_env_get",
                serde_json::json!({ "name": "prod.env" }),
            ),
            (
                "nession_server_env_write",
                serde_json::json!({ "name": "prod.env", "content": "A=1" }),
            ),
            (
                "nession_server_env_delete",
                serde_json::json!({ "name": "prod.env" }),
            ),
            (
                "nession_server_session_env_binding_get",
                serde_json::json!({ "session_id": "agent-a:dev" }),
            ),
            (
                "nession_server_session_env_binding_set",
                serde_json::json!({
                    "session_id": "agent-a:dev",
                    "expected_revision": 0,
                    "profiles": []
                }),
            ),
            (
                "nession_server_session_env_binding_reapply",
                serde_json::json!({ "session_id": "agent-a:dev", "expected_revision": 0 }),
            ),
            (
                "nession_agent_list_sessions",
                serde_json::json!({ "agent_id": "agent-a" }),
            ),
            (
                "nession_agent_create_session",
                serde_json::json!({ "agent_id": "agent-a", "name": "dev" }),
            ),
            (
                "nession_agent_kill_session",
                serde_json::json!({
                    "agent_id": "agent-a",
                    "name": "dev",
                    "expected_instance_id": "instance-a"
                }),
            ),
            (
                "nession_agent_get_session_metadata",
                serde_json::json!({ "agent_id": "agent-a", "name": "dev" }),
            ),
            (
                "nession_agent_update_session_metadata",
                serde_json::json!({
                    "agent_id": "agent-a",
                    "name": "dev",
                    "expected_instance_id": "instance-a",
                    "expected_revision": 0,
                    "patch": { "description": "Next step" }
                }),
            ),
        ];
        assert_eq!(calls.len(), 17);
        for (name, input) in calls {
            let reply = catalog
                .call(&context(&recorder), name, Some(arguments(input)))
                .await
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            let tool = catalog
                .list()
                .into_iter()
                .find(|tool| tool.name == name)
                .unwrap_or_else(|| panic!("{name} is registered"));
            let schema = serde_json::Value::Object((*tool.output_schema.expect("output")).clone());
            let reply = reply
                .as_object()
                .unwrap_or_else(|| panic!("{name} returned a non-object success reply"));
            let declared = schema["properties"].as_object().expect("properties");
            for key in reply.keys() {
                assert!(
                    declared.contains_key(key),
                    "{name} returned undeclared output field `{key}`"
                );
            }
            if let Some(required) = schema["required"].as_array() {
                for key in required {
                    let key = key.as_str().expect("required name");
                    assert!(
                        reply.contains_key(key),
                        "{name} omitted required output field `{key}`"
                    );
                }
            }
        }
    }

    #[test]
    fn a_success_reply_missing_or_mistyping_a_required_field_is_refused() {
        // The typed reply is the runtime contract; a host cannot hand the
        // service a success payload that omits a required declared field
        // (`#3735` SC-01 negative fixture).
        assert!(serde_json::from_value::<SessionKillResponse>(serde_json::json!({})).is_err());
        assert!(
            serde_json::from_value::<SessionKillResponse>(serde_json::json!({ "name": 7 }))
                .is_err()
        );
        assert!(serde_json::from_value::<SessionKillResponse>(
            serde_json::json!({ "name": "dev" })
        )
        .is_ok());
    }
}
