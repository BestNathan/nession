//! The four baseline Tools (`#3264`).
//!
//! This module only declares the Tool modules and registers their handlers
//! with one [`ToolRegistry`]. It deliberately contains **no** `match name`
//! dispatch: a Tool's identity, schema, validation and execution live in its
//! own `<mcp_tool_name>.rs` file.

pub mod nession_agent_create_session;
pub mod nession_agent_kill_session;
pub mod nession_agent_list_sessions;
pub mod nession_server_list_agents;

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
        Arc::new(nession_agent_list_sessions::NessionAgentListSessions),
        Arc::new(nession_agent_create_session::NessionAgentCreateSession),
        Arc::new(nession_agent_kill_session::NessionAgentKillSession),
    ])
}

/// The exact names this service advertises.
pub const TOOL_NAMES: &[&str] = &[
    "nession_server_list_agents",
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

    /// What one Tool call asked the backend for.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Recorded {
        ListAgents,
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
    fn the_registry_advertises_exactly_the_four_baseline_tools() {
        let catalog = registry().expect("registry");
        let names: Vec<_> = catalog
            .list()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect();
        assert_eq!(names, TOOL_NAMES);
    }
}
