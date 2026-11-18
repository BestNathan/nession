//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use nession_protocol::contracts::session::v1::SessionActivityView;

use super::{warn, ConnectionHandler, HandlerAction, ProtocolMessage};

/// The Activity vocabulary the Server accepts from an Agent.
///
/// The Agent is the authority that produced it, but a malformed frame must not
/// become a Web-visible state: unknown strings are refused, not stored.
const ACTIVITY_STATES: [&str; 3] = ["working", "idle", "unknown"];
const ATTENTION_STATES: [&str; 1] = ["input_required"];

impl ConnectionHandler {
    /// Handle `server.agent.session-activity` (#3804).
    ///
    /// The Agent that owns the Session is the one on this connection, not the
    /// payload's claim — `authorized_agent_id` is the same authority check the
    /// inventory update uses, including the connection-generation fence that
    /// stops a superseded socket from writing.
    ///
    /// Activity is applied through its own registry method: it never stamps
    /// `last_activity` and never changes lifecycle `status`.
    pub(super) async fn handle_agent_session_activity(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload = msg.payload;
        let Some(agent_id) = self
            .authorized_agent_id(&payload, "server.agent.session-activity")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };
        if self.agent_registry.get(&agent_id).await.is_none() {
            warn!("Session activity from unregistered agent: {agent_id}");
            return Ok(HandlerAction::Reply(None));
        }

        let session_name = payload
            .get("session_name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let instance_id = payload
            .get("instance_id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let epoch = payload
            .get("epoch")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let generation = payload
            .get("generation")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let state = payload
            .get("state")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let attention = payload.get("attention").and_then(serde_json::Value::as_str);
        let capability_id = payload
            .get("capability_id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty());
        let observed_at_ms = payload
            .get("observed_at_ms")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);

        if session_name.is_empty() || instance_id.is_empty() || epoch.is_empty() || generation == 0
        {
            warn!("Session activity from {agent_id} is missing its identity fence; refusing");
            return Ok(HandlerAction::Reply(None));
        }
        if !ACTIVITY_STATES.contains(&state) {
            warn!("Session activity from {agent_id} names unknown state '{state}'; refusing");
            return Ok(HandlerAction::Reply(None));
        }
        if attention.is_some_and(|value| !ATTENTION_STATES.contains(&value)) {
            warn!(
                "Session activity from {agent_id} names unknown attention '{:?}'; refusing",
                attention
            );
            return Ok(HandlerAction::Reply(None));
        }

        let activity = SessionActivityView {
            state: state.to_string(),
            attention: attention.map(std::string::ToString::to_string),
            capability_id: capability_id.map(std::string::ToString::to_string),
            observed_at_ms,
        };
        if self
            .session_registry
            .update_activity(
                &agent_id,
                session_name,
                instance_id,
                epoch,
                generation,
                activity,
            )
            .await
        {
            // The projection is in `session_to_json`, so the push carries the
            // same Activity the next list reply will.
            self.broadcast_sessions().await;
        }

        Ok(HandlerAction::Reply(None))
    }
}
