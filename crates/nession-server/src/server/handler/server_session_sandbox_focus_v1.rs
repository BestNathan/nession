//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, reply_json, warn, ClientSessionSandboxFocusPayload, ConnectionHandler, Duration,
    HandlerAction, ProtocolMessage, SandboxActionErrorKind, SandboxActionResult,
};

/// Focus reads the context and selects a Window/Pane; no resources are
/// prepared.
const SANDBOX_FOCUS_TIMEOUT: Duration = Duration::from_secs(15);

impl ConnectionHandler {
    /// Handle `server.session.sandbox.focus` — focus one existing, tracked
    /// Sandbox Pane. Return to Native is a focus switch; this is its inverse,
    /// and neither tears an execution down.
    pub(super) async fn handle_client_session_sandbox_focus(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let id = msg.id.clone();
        let refuse = |kind: SandboxActionErrorKind, error: &str| {
            reply_json(
                &id,
                "server.session.sandbox.focus",
                serde_json::to_value(SandboxActionResult {
                    success: false,
                    error_kind: Some(kind),
                    error: Some(error.to_string()),
                    field_errors: None,
                    context: None,
                })
                .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
            )
        };
        if !self.authenticated_client {
            warn!("Unauthenticated client requested Sandbox Pane focus");
            return Ok(refuse(
                SandboxActionErrorKind::Unavailable,
                "Not authenticated",
            ));
        }
        let Ok(payload) = serde_json::from_value::<ClientSessionSandboxFocusPayload>(msg.payload)
        else {
            return Ok(refuse(
                SandboxActionErrorKind::Invalid,
                "session_id and pane_id are required",
            ));
        };
        if payload.session_id.is_empty() || payload.pane_id.is_empty() {
            return Ok(refuse(
                SandboxActionErrorKind::Invalid,
                "session_id and pane_id are required",
            ));
        }
        let (agent_id, session_name) = match self.sandbox_session_target(&payload.session_id).await
        {
            Ok(target) => target,
            Err(error) => {
                return Ok(refuse(SandboxActionErrorKind::Unavailable, &error));
            }
        };

        info!(
            "Focus Sandbox Pane: agent_id={}, session_name={}, pane_id={}",
            agent_id, session_name, payload.pane_id
        );
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.session.sandbox.focus",
                json!({ "session_name": session_name, "pane_id": payload.pane_id }),
                SANDBOX_FOCUS_TIMEOUT,
            )
            .await
        {
            Ok(response)
                if response.get("success").and_then(serde_json::Value::as_bool) == Some(true) =>
            {
                let result = response
                    .get("result")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<SandboxActionResult>(value).ok());
                match result {
                    Some(result) => Ok(reply_json(
                        &id,
                        "server.session.sandbox.focus",
                        serde_json::to_value(result)
                            .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
                    )),
                    None => {
                        warn!("Agent returned an unreadable Sandbox focus result");
                        Ok(refuse(
                            SandboxActionErrorKind::Failed,
                            "Agent returned an unreadable Sandbox focus result",
                        ))
                    }
                }
            }
            Ok(response) => {
                let message = response
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent could not focus the Sandbox Pane");
                Ok(refuse(SandboxActionErrorKind::Failed, message))
            }
            Err(error) => Ok(refuse(SandboxActionErrorKind::Unavailable, &error)),
        }
    }
}
