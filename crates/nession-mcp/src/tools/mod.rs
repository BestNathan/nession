//! MCP baseline Session Tools plus Server-owned ENV file and Session
//! Environment Binding management.
//!
//! This module only declares the Tool modules and registers their handlers
//! with one [`ToolRegistry`]. It deliberately contains **no** `match name`
//! dispatch: a Tool's identity, schema, validation and execution live in its
//! own `<mcp_tool_name>.rs` file.

mod env_target;
pub mod nession_agent_create_session;
pub mod nession_agent_kill_session;
pub mod nession_agent_list_sessions;
pub mod nession_server_env_delete;
pub mod nession_server_env_get;
pub mod nession_server_env_list;
pub mod nession_server_env_write;
pub mod nession_server_list_agents;
pub mod nession_server_session_env_binding_get;
pub mod nession_server_session_env_binding_reapply;
pub mod nession_server_session_env_binding_set;

use std::sync::Arc;

use crate::registry::{RegistryError, ToolRegistry};
use crate::tool::ToolHandler;

/// Build the catalog this service advertises.
///
/// The order is the advertised order and is stable: Server-owned discovery
/// first, then the Agent-owned Session operations.
pub fn registry() -> Result<ToolRegistry, RegistryError> {
    ToolRegistry::build([
        Arc::new(nession_server_list_agents::NessionServerListAgents) as Arc<dyn ToolHandler>,
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
    ])
}

/// The exact names this service advertises.
pub const TOOL_NAMES: &[&str] = &[
    "nession_server_list_agents",
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
];

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use serde_json::{json, Value};

    use crate::backend::{ClusterBackend, NodeBackend};
    use crate::error::ToolError;
    use crate::tool::ToolContext;
    use nession_protocol::contracts::env::v1::{
        ClientEnvDeletePayload, ClientEnvGetPayload, ClientEnvWritePayload, EnvFileRef, EnvSource,
    };
    use nession_protocol::contracts::session::v1::{
        ClientSessionEnvBindingGetPayload, ClientSessionEnvBindingReapplyPayload,
        ClientSessionEnvBindingSetPayload,
    };

    /// What one Tool call asked the backend for.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Recorded {
        ListAgents,
        EnvList,
        EnvGet(String, EnvSource, Option<String>),
        EnvWrite(String, EnvSource, Option<String>, String, bool, bool),
        EnvDelete(String, EnvSource, Option<String>, bool),
        BindingGet(String),
        BindingSet(String, u64, Vec<EnvFileRef>),
        BindingReapply(String, u64),
        ListSessions(String),
        CreateSession(String, String, Option<String>),
        KillSession(String, String),
    }

    /// A backend pair that records calls and answers a canned reply.
    #[derive(Default)]
    pub struct Recording {
        pub calls: Mutex<Vec<Recorded>>,
    }

    impl Recording {
        pub fn calls(&self) -> Vec<Recorded> {
            self.calls.lock().expect("recording lock").clone()
        }
    }

    #[async_trait]
    impl ClusterBackend for Recording {
        async fn list_agents(&self) -> Result<Value, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::ListAgents);
            Ok(json!({ "agents": [] }))
        }

        async fn env_list(&self) -> Result<Value, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::EnvList);
            Ok(json!({ "files": [] }))
        }

        async fn env_get(&self, payload: ClientEnvGetPayload) -> Result<Value, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::EnvGet(
                    payload.name,
                    payload.source,
                    payload.agent_id,
                ));
            Ok(json!({ "success": true, "content": "PUBLIC=1\n", "in_use_by": [] }))
        }

        async fn env_write(&self, payload: ClientEnvWritePayload) -> Result<Value, ToolError> {
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
            Ok(json!({ "success": true, "exists": false, "warnings": [] }))
        }

        async fn env_delete(&self, payload: ClientEnvDeletePayload) -> Result<Value, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::EnvDelete(
                    payload.name,
                    payload.source,
                    payload.agent_id,
                    payload.force,
                ));
            Ok(json!({ "success": true }))
        }

        async fn session_env_binding_get(
            &self,
            payload: ClientSessionEnvBindingGetPayload,
        ) -> Result<Value, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::BindingGet(payload.session_id));
            Ok(json!({
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
        }

        async fn session_env_binding_set(
            &self,
            payload: ClientSessionEnvBindingSetPayload,
        ) -> Result<Value, ToolError> {
            let expected = payload.expected_revision.expect("the Tool requires one");
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::BindingSet(
                    payload.session_id,
                    expected,
                    payload.profiles,
                ));
            Ok(json!({ "success": true, "binding": null, "warnings": [] }))
        }

        async fn session_env_binding_reapply(
            &self,
            payload: ClientSessionEnvBindingReapplyPayload,
        ) -> Result<Value, ToolError> {
            let expected = payload.expected_revision.expect("the Tool requires one");
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::BindingReapply(payload.session_id, expected));
            Ok(json!({ "success": true, "binding": null, "warnings": [] }))
        }
    }

    #[async_trait]
    impl NodeBackend for Recording {
        async fn list_sessions(&self, agent_id: &str) -> Result<Value, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::ListSessions(agent_id.to_string()));
            Ok(json!({ "sessions": [], "stale_agents": [] }))
        }

        async fn create_session(
            &self,
            agent_id: &str,
            name: &str,
            working_dir: Option<&str>,
        ) -> Result<Value, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::CreateSession(
                    agent_id.to_string(),
                    name.to_string(),
                    working_dir.map(str::to_owned),
                ));
            Ok(json!({ "name": name, "warnings": [] }))
        }

        async fn kill_session(&self, agent_id: &str, name: &str) -> Result<Value, ToolError> {
            self.calls
                .lock()
                .expect("recording lock")
                .push(Recorded::KillSession(
                    agent_id.to_string(),
                    name.to_string(),
                ));
            Ok(json!({ "name": name }))
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
}
