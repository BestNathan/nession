//! `nession_agent_list_sessions` — Agent-owned Session discovery.
//!
//! The answer is the real tmux Session state of the Agent named in
//! `agent_id`. It is never the Server registry's view, and an omitted or empty
//! target is refused rather than defaulting to the MCP host.
//!
//! ## Stabilized output (#3735, #3910)
//!
//! The three hosting modes reach the same Agent truth through different
//! routes: an Agent's `agent.session.list` reply, the Server-embedded broker's
//! copy of it, and the Server's `server.session.list` projection. Those wire
//! shapes are not identical, so this Tool owns one MCP projection of the fields
//! every owner can state truthfully. A field only one route can produce stays
//! in that route's own Protocol contract and is not advertised here.
//!
//! A Server-route projection already carries the Session's current Project
//! association. A direct-Agent route does not, so the Tool asks the configured
//! Server for that metadata and merges it where the Session id matches. The
//! three `project_id` states are therefore distinct: a string is a confirmed
//! association, `null` is a confirmed non-association, and an omitted field
//! means the Server could not be asked — never that the Session is
//! unassociated.

use std::collections::HashMap;

use async_trait::async_trait;
use nession_protocol::contracts::session::v1::{
    SessionInfo, WebSessionInfo, WebSessionsListResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionAgentListSessions;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// The Agent node whose Sessions are listed.
    agent_id: String,
}

/// One live tmux Session on the named Agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SessionSummary {
    /// Canonical Session identity (`<agent_id>:<session_name>`).
    pub session_id: String,
    /// The tmux Session name on the named Agent.
    pub name: String,
    /// Number of tmux windows in the Session.
    pub window_count: u32,
    /// Number of clients currently attached to the Session.
    pub attached_clients: u32,
    /// Foreground command of the Session's active pane, when tmux reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_command: Option<String>,
    /// Live working directory of the Session's active pane, when the Agent
    /// reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    /// Durable tmux Session instance identity. Absent for a Session the Agent
    /// has not reported an identity for yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    /// The Server-owned Project association for this Session incarnation.
    ///
    /// A string is the Server's current authoritative association; explicit
    /// `null` is a confirmed non-association; the field is omitted only when
    /// the Server could not report the Session's metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Option<String>>,
}

impl SessionSummary {
    /// Project an Agent-owned `agent.session.list` entry.
    ///
    /// The Agent wire carries no Project metadata, so `project_id` starts
    /// unresolved. The Tool may enrich it from the configured Server.
    pub fn from_agent_session(agent_id: &str, session: &SessionInfo) -> Self {
        Self {
            session_id: format!("{agent_id}:{}", session.name),
            name: session.name.clone(),
            window_count: session.window_count,
            attached_clients: session.attached_clients,
            foreground_command: session.foreground_command.clone(),
            working_dir: session.working_dir.clone(),
            instance_id: session.instance_id.clone(),
            project_id: None,
        }
    }

    /// Project the Server's `server.session.list` entry.
    ///
    /// The Server projection names the Session `session_name`; the stable MCP
    /// field is the bare tmux name the Agent owns. The Server list is
    /// authoritative for Project association, so an absent wire value is a
    /// **confirmed** non-association and becomes an explicit `null`.
    pub fn from_web_session(session: &WebSessionInfo) -> Self {
        Self {
            session_id: session.session_id.clone(),
            name: session.session_name.clone(),
            window_count: session.window_count,
            attached_clients: session.attached_clients,
            foreground_command: session.foreground_command.clone(),
            working_dir: session.working_dir.clone(),
            instance_id: session.instance_id.clone(),
            project_id: Some(session.project_id.clone()),
        }
    }
}

/// The success reply of `nession_agent_list_sessions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SessionListOutput {
    /// The named Agent's live tmux Sessions.
    pub sessions: Vec<SessionSummary>,
    /// Agents that did not answer a forced refresh, so the list may be
    /// incomplete. Empty when the named Agent answered its own live state.
    #[serde(default)]
    pub stale_agents: Vec<String>,
}

impl SessionListOutput {
    /// Project one Agent's `agent.session.list` reply.
    pub fn from_agent_sessions(agent_id: &str, sessions: &[SessionInfo]) -> Self {
        Self::from_agent_reply(agent_id, sessions, Vec::new())
    }

    /// Project one Agent's reply together with any stale-Agent names the route
    /// reports.
    pub fn from_agent_reply(
        agent_id: &str,
        sessions: &[SessionInfo],
        stale_agents: Vec<String>,
    ) -> Self {
        Self {
            sessions: sessions
                .iter()
                .map(|session| SessionSummary::from_agent_session(agent_id, session))
                .collect(),
            stale_agents,
        }
    }

    /// Project the Server's `server.session.list` reply for one Agent.
    pub fn from_web_sessions(sessions: &[WebSessionInfo], stale_agents: Vec<String>) -> Self {
        Self {
            sessions: sessions
                .iter()
                .map(SessionSummary::from_web_session)
                .collect(),
            stale_agents,
        }
    }

    /// Fill unresolved Project metadata from the Server's current projection.
    ///
    /// Only Sessions the Server actually listed are enriched: a missing entry
    /// is **unresolved**, not an unassociation. A route that already reported
    /// an association (or a confirmed `null`) is never overwritten.
    pub fn apply_project_metadata(&mut self, listed: &WebSessionsListResponse) {
        let associations: HashMap<&str, Option<&str>> = listed
            .sessions
            .iter()
            .map(|session| (session.session_id.as_str(), session.project_id.as_deref()))
            .collect();
        for session in &mut self.sessions {
            if session.project_id.is_some() {
                continue;
            }
            if let Some(project_id) = associations.get(session.session_id.as_str()) {
                session.project_id = Some(project_id.map(str::to_owned));
            }
        }
    }
}

#[async_trait]
impl ToolHandler for NessionAgentListSessions {
    fn name(&self) -> &'static str {
        "nession_agent_list_sessions"
    }

    fn description(&self) -> &'static str {
        "List the real tmux Sessions on one explicitly named Agent node. This is Agent truth, \
         not the Server registry view. `agent_id` is required; the call never falls back to the \
         host running MCP. Each Session's `project_id` is the Server's current authoritative \
         Project association; explicit null means unassociated and an omitted field means the \
         Server metadata was unavailable."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<SessionListOutput>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let arguments: Arguments = parse_arguments(arguments)?;
        non_empty(&arguments.agent_id, "agent_id")?;
        let mut reply = context.node.list_sessions(&arguments.agent_id).await?;
        // A direct-Agent route reports no Project metadata. Enrichment is
        // best-effort and must never turn Agent truth into a failure: an
        // unreachable Server leaves the field omitted, which is the truthful
        // "unknown" state, not a guessed `null`.
        if reply
            .sessions
            .iter()
            .any(|session| session.project_id.is_none())
        {
            if let Ok(listed) = context
                .cluster
                .list_sessions(Some(&arguments.agent_id), false)
                .await
            {
                reply.apply_project_metadata(&listed);
            }
        }
        reply_value(&reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[tokio::test]
    async fn it_asks_the_named_agent() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionAgentListSessions
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "agent-1" })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["sessions"], serde_json::json!([]));
        assert_eq!(
            recorder.calls(),
            vec![Recorded::ListSessions("agent-1".to_string())]
        );
    }

    #[test]
    fn agent_id_is_required_and_statically_typed() {
        let schema = NessionAgentListSessions.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], serde_json::json!(["agent_id"]));
        assert_eq!(schema["properties"]["agent_id"]["type"], "string");
    }

    #[tokio::test]
    async fn a_missing_target_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentListSessions
            .call(&context(&recorder), arguments(serde_json::json!({})))
            .await
            .expect_err("missing agent_id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn an_empty_target_is_refused_rather_than_interpreted_as_local() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentListSessions
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "  " })),
            )
            .await
            .expect_err("empty agent_id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn an_unexpected_argument_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentListSessions
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "a", "force": true })),
            )
            .await
            .expect_err("unexpected argument");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
    }

    #[test]
    fn the_server_projection_keeps_identity_and_confirms_non_association() {
        let session: WebSessionInfo = serde_json::from_value(serde_json::json!({
            "session_id": "agent-a:shell",
            "agent_id": "agent-a",
            "session_name": "shell",
            "status": "detached",
            "window_count": 1,
            "attached_clients": 0,
            "last_activity": "2026-11-18T00:00:00Z"
        }))
        .expect("server session");
        let summary = SessionSummary::from_web_session(&session);
        assert_eq!(summary.session_id, "agent-a:shell");
        assert_eq!(summary.name, "shell");
        assert_eq!(summary.project_id, Some(None));
        let value = serde_json::to_value(&summary).expect("summary json");
        assert_eq!(value["project_id"], Value::Null);
    }

    #[test]
    fn an_agent_projection_derives_identity_and_leaves_project_unresolved() {
        let session: SessionInfo = serde_json::from_value(serde_json::json!({
            "name": "shell",
            "created_at": 0,
            "window_count": 1,
            "attached_clients": 0,
            "width": 80,
            "height": 24,
            "foreground_command": null
        }))
        .expect("agent session");
        let summary = SessionSummary::from_agent_session("agent-a", &session);
        assert_eq!(summary.session_id, "agent-a:shell");
        assert_eq!(summary.project_id, None);
        let value = serde_json::to_value(&summary).expect("summary json");
        assert!(
            value.get("project_id").is_none(),
            "unresolved metadata must be omitted, not serialized as null"
        );
    }

    #[tokio::test]
    async fn server_metadata_enriches_unresolved_agent_sessions() {
        let recorder = Arc::new(Recording::default());
        recorder.set_node_sessions(&[serde_json::json!({
            "session_id": "agent-a:dev",
            "name": "dev",
            "window_count": 1,
            "attached_clients": 0
        })]);
        recorder.set_server_sessions(&[
            serde_json::json!({
                "session_id": "agent-a:dev",
                "agent_id": "agent-a",
                "session_name": "dev",
                "status": "detached",
                "window_count": 1,
                "attached_clients": 0,
                "project_id": "project-123e4567-e89b-42d3-a456-426614174000",
                "last_activity": "2026-11-18T00:00:00Z"
            }),
            serde_json::json!({
                "session_id": "agent-a:shell",
                "agent_id": "agent-a",
                "session_name": "shell",
                "status": "detached",
                "window_count": 1,
                "attached_clients": 0,
                "last_activity": "2026-11-18T00:00:00Z"
            }),
        ]);
        let reply = NessionAgentListSessions
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "agent-a" })),
            )
            .await
            .expect("reply");
        assert_eq!(
            reply["sessions"][0]["project_id"],
            "project-123e4567-e89b-42d3-a456-426614174000"
        );
        assert_eq!(
            recorder.calls(),
            vec![
                Recorded::ListSessions("agent-a".to_string()),
                Recorded::ListServerSessions(Some("agent-a".to_string()), false)
            ]
        );
    }

    #[tokio::test]
    async fn an_unavailable_server_leaves_metadata_omitted_instead_of_guessing() {
        let recorder = Arc::new(Recording::default());
        recorder.set_node_sessions(&[serde_json::json!({
            "session_id": "agent-a:dev",
            "name": "dev",
            "window_count": 1,
            "attached_clients": 0
        })]);
        // An untypable Server reply is a backend failure; Agent truth survives
        // and the Project field stays unresolved.
        *recorder.server_sessions.lock().expect("server sessions") =
            serde_json::json!({ "unexpected": true });
        let reply = NessionAgentListSessions
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "agent-a" })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["sessions"][0]["session_id"], "agent-a:dev");
        assert!(
            reply["sessions"][0].get("project_id").is_none(),
            "an unavailable Server must omit the field: {reply}"
        );
    }

    #[test]
    fn its_output_schema_declares_the_identity_and_project_states() {
        let schema = NessionAgentListSessions.output_schema();
        let rendered = serde_json::to_string(&schema).expect("schema json");
        assert!(rendered.contains("\"session_id\""), "{rendered}");
        assert!(rendered.contains("\"project_id\""), "{rendered}");
    }
}
