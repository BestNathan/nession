//! `nession_server_project_session_list` — Project-scoped Server Session view.
//!
//! This is a filtered Server query, not a second Session registry. The Server's
//! `server.session.list` projection supplies each Session's **current
//! authoritative** Project association for its incarnation, so a Session
//! Web-rebound into the Project appears here without any Agent runtime change,
//! and a Session created through a Project but later rebound elsewhere does
//! not.

use async_trait::async_trait;
use nession_protocol::contracts::project::v1::{is_valid_project_id, ProjectValidationError};
use nession_protocol::contracts::session::v1::WebSessionInfo;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionServerProjectSessionList;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// Stable Project identity to scope the Session view.
    project_id: String,
    /// Optional Agent filter; absent lists every Agent's Sessions.
    #[serde(default)]
    agent_id: Option<String>,
    /// Ask the Server for live Agent state before answering.
    #[serde(default)]
    force: bool,
}

/// One Session whose current authoritative association is the Project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ProjectSessionSummary {
    /// Canonical Session identity (`<agent_id>:<session_name>`).
    pub session_id: String,
    /// The tmux Session name on the owning Agent.
    pub name: String,
    /// The Agent node that owns the Session.
    pub agent_id: String,
    /// Number of tmux windows in the Session.
    pub window_count: u32,
    /// Number of clients currently attached to the Session.
    pub attached_clients: u32,
    /// Foreground command of the Session's active pane, when tmux reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_command: Option<String>,
    /// Live working directory of the Session's active pane, when reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    /// Durable tmux Session instance identity, when the Agent reported one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
}

impl ProjectSessionSummary {
    fn from_web_session(session: &WebSessionInfo) -> Self {
        Self {
            session_id: session.session_id.clone(),
            name: session.session_name.clone(),
            agent_id: session.agent_id.clone(),
            window_count: session.window_count,
            attached_clients: session.attached_clients,
            foreground_command: session.foreground_command.clone(),
            working_dir: session.working_dir.clone(),
            instance_id: session.instance_id.clone(),
        }
    }
}

/// The success reply of `nession_server_project_session_list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ProjectSessionListOutput {
    /// The Project these Sessions are currently associated with.
    pub project_id: String,
    /// Sessions whose current authoritative association is `project_id`.
    pub sessions: Vec<ProjectSessionSummary>,
    /// Agents that did not answer a forced refresh, so the list may be
    /// incomplete rather than complete-but-empty.
    #[serde(default)]
    pub stale_agents: Vec<String>,
}

#[async_trait]
impl ToolHandler for NessionServerProjectSessionList {
    fn name(&self) -> &'static str {
        "nession_server_project_session_list"
    }

    fn description(&self) -> &'static str {
        "List Sessions whose current authoritative Server-owned Project association is the given \
         project_id. This is a filtered Server query over the one Session registry, not a \
         Project-owned Session store. `agent_id` narrows the view; `force=true` refreshes live \
         Agent state and reports stale Agents."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<ProjectSessionListOutput>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let arguments: Arguments = parse_arguments(arguments)?;
        non_empty(&arguments.project_id, "project_id")?;
        if !is_valid_project_id(&arguments.project_id) {
            return Err(ToolError::invalid_argument(
                ProjectValidationError::InvalidProjectId.message(),
            ));
        }
        if let Some(agent_id) = arguments.agent_id.as_deref() {
            non_empty(agent_id, "agent_id")?;
        }
        let listed = context
            .cluster
            .list_sessions(arguments.agent_id.as_deref(), arguments.force)
            .await?;
        let sessions: Vec<ProjectSessionSummary> = listed
            .sessions
            .iter()
            .filter(|session| session.project_id.as_deref() == Some(arguments.project_id.as_str()))
            .map(ProjectSessionSummary::from_web_session)
            .collect();
        reply_value(&ProjectSessionListOutput {
            project_id: arguments.project_id,
            sessions,
            stale_agents: listed.stale_agents,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use serde_json::json;
    use std::sync::Arc;

    const PROJECT_ID: &str = "project-123e4567-e89b-42d3-a456-426614174000";
    const OTHER_PROJECT_ID: &str = "project-223e4567-e89b-42d3-a456-426614174000";

    fn session(session_id: &str, project_id: Option<&str>) -> Value {
        json!({
            "session_id": session_id,
            "agent_id": session_id.split_once(':').expect("agent id").0,
            "session_name": session_id.split_once(':').expect("name").1,
            "status": "detached",
            "window_count": 1,
            "attached_clients": 0,
            "project_id": project_id,
            "last_activity": "2026-11-18T00:00:00Z"
        })
    }

    #[tokio::test]
    async fn it_returns_only_currently_associated_sessions() {
        let recorder = Arc::new(Recording::default());
        recorder.set_server_sessions(&[
            session("agent-a:project-dev", Some(PROJECT_ID)),
            session("agent-a:shell", None),
            session("agent-b:other", Some(OTHER_PROJECT_ID)),
        ]);
        let reply = NessionServerProjectSessionList
            .call(
                &context(&recorder),
                arguments(json!({ "project_id": PROJECT_ID })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["project_id"], PROJECT_ID);
        let sessions = reply["sessions"].as_array().expect("sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["session_id"], "agent-a:project-dev");
        assert_eq!(sessions[0]["agent_id"], "agent-a");
        assert_eq!(sessions[0]["name"], "project-dev");
        assert_eq!(
            recorder.calls(),
            vec![Recorded::ListServerSessions(None, false)]
        );
    }

    #[tokio::test]
    async fn it_forwards_the_agent_filter_and_force_refresh() {
        let recorder = Arc::new(Recording::default());
        NessionServerProjectSessionList
            .call(
                &context(&recorder),
                arguments(json!({
                    "project_id": PROJECT_ID,
                    "agent_id": "agent-a",
                    "force": true
                })),
            )
            .await
            .expect("reply");
        assert_eq!(
            recorder.calls(),
            vec![Recorded::ListServerSessions(
                Some("agent-a".to_string()),
                true
            )]
        );
    }

    #[tokio::test]
    async fn stale_agents_remain_truthful_on_an_empty_or_incomplete_view() {
        let recorder = Arc::new(Recording::default());
        *recorder.server_sessions.lock().expect("server sessions") = json!({
            "sessions": [],
            "stale_agents": ["agent-b"]
        });
        let reply = NessionServerProjectSessionList
            .call(
                &context(&recorder),
                arguments(json!({ "project_id": PROJECT_ID, "force": true })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["sessions"], json!([]));
        assert_eq!(reply["stale_agents"], json!(["agent-b"]));
    }

    #[tokio::test]
    async fn a_malformed_identity_never_reaches_the_backend() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerProjectSessionList
            .call(
                &context(&recorder),
                arguments(json!({ "project_id": "not-a-project" })),
            )
            .await
            .expect_err("malformed project id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn an_empty_agent_filter_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerProjectSessionList
            .call(
                &context(&recorder),
                arguments(json!({ "project_id": PROJECT_ID, "agent_id": "  " })),
            )
            .await
            .expect_err("empty agent id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[test]
    fn its_schema_is_closed_and_requires_the_project() {
        let schema = NessionServerProjectSessionList.input_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["project_id"]));
        assert_eq!(
            schema["properties"]["agent_id"]["type"],
            json!(["string", "null"])
        );
        assert_eq!(schema["properties"]["force"]["type"], "boolean");
    }

    #[tokio::test]
    async fn an_unexpected_argument_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerProjectSessionList
            .call(
                &context(&recorder),
                arguments(json!({ "project_id": PROJECT_ID, "session_id": "agent-a:dev" })),
            )
            .await
            .expect_err("unexpected argument");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
