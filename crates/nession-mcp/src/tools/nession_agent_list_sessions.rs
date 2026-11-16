//! `nession_agent_list_sessions` — Agent-owned Session discovery.
//!
//! The answer is the real tmux Session state of the Agent named in
//! `agent_id`. It is never the Server registry's view, and an omitted or empty
//! target is refused rather than defaulting to the MCP host.
//!
//! ## Stabilized output (#3735)
//!
//! The three hosting modes reach the same Agent truth through different
//! routes: an Agent's `agent.session.list` reply, the Server-embedded broker's
//! copy of it, and the Server's `server.session.list` projection. Those wire
//! shapes are not identical, so this Tool owns one MCP projection of the fields
//! every owner can state truthfully. A field only one route can produce stays
//! in that route's own Protocol contract and is not advertised here.

use async_trait::async_trait;
use nession_protocol::contracts::session::v1::{SessionInfo, WebSessionInfo};
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
}

impl SessionSummary {
    /// Project an Agent-owned `agent.session.list` entry.
    pub fn from_agent_session(session: &SessionInfo) -> Self {
        Self {
            name: session.name.clone(),
            window_count: session.window_count,
            attached_clients: session.attached_clients,
            foreground_command: session.foreground_command.clone(),
            working_dir: session.working_dir.clone(),
            instance_id: session.instance_id.clone(),
        }
    }

    /// Project the Server's `server.session.list` entry.
    ///
    /// The Server projection names the Session `session_name`; the stable MCP
    /// field is the bare tmux name the Agent owns.
    pub fn from_web_session(session: &WebSessionInfo) -> Self {
        Self {
            name: session.session_name.clone(),
            window_count: session.window_count,
            attached_clients: session.attached_clients,
            foreground_command: session.foreground_command.clone(),
            working_dir: session.working_dir.clone(),
            instance_id: session.instance_id.clone(),
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
    pub fn from_agent_sessions(sessions: &[SessionInfo]) -> Self {
        Self::from_agent_reply(sessions, Vec::new())
    }

    /// Project one Agent's reply together with any stale-Agent names the route
    /// reports.
    pub fn from_agent_reply(sessions: &[SessionInfo], stale_agents: Vec<String>) -> Self {
        Self {
            sessions: sessions
                .iter()
                .map(SessionSummary::from_agent_session)
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
}

#[async_trait]
impl ToolHandler for NessionAgentListSessions {
    fn name(&self) -> &'static str {
        "nession_agent_list_sessions"
    }

    fn description(&self) -> &'static str {
        "List the real tmux Sessions on one explicitly named Agent node. This is Agent truth, \
         not the Server registry view. `agent_id` is required; the call never falls back to the \
         host running MCP."
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
        let reply = context.node.list_sessions(&arguments.agent_id).await?;
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
}
