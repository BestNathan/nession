//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, reply_json, warn, ClientSessionSandboxReturnPayload, ConnectionHandler, Duration,
    HandlerAction, ProtocolMessage, SandboxActionErrorKind, SandboxActionResult,
};

/// A focus switch reads the context and selects a Window/Pane; no host
/// resources are prepared.
const SANDBOX_RETURN_TIMEOUT: Duration = Duration::from_secs(15);

impl ConnectionHandler {
    /// Handle `server.session.sandbox.return-to-native` — focus the preserved
    /// Native Pane of the current Sandbox execution.
    pub(super) async fn handle_client_session_sandbox_return(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let id = msg.id.clone();
        let refuse = |kind: SandboxActionErrorKind, error: &str| {
            reply_json(
                &id,
                "server.session.sandbox.return-to-native",
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
            warn!("Unauthenticated client requested Return to Native");
            return Ok(refuse(
                SandboxActionErrorKind::Unavailable,
                "Not authenticated",
            ));
        }
        let Ok(payload) = serde_json::from_value::<ClientSessionSandboxReturnPayload>(msg.payload)
        else {
            return Ok(refuse(
                SandboxActionErrorKind::Invalid,
                "session_id is required",
            ));
        };
        if payload.session_id.is_empty() {
            return Ok(refuse(
                SandboxActionErrorKind::Invalid,
                "session_id is required",
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
            "Return to Native Pane: agent_id={}, session_name={}",
            agent_id, session_name
        );
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.session.sandbox.return-to-native",
                json!({ "session_name": session_name }),
                SANDBOX_RETURN_TIMEOUT,
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
                        "server.session.sandbox.return-to-native",
                        serde_json::to_value(result)
                            .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
                    )),
                    None => {
                        warn!("Agent returned an unreadable Return to Native result");
                        Ok(refuse(
                            SandboxActionErrorKind::Failed,
                            "Agent returned an unreadable Return to Native result",
                        ))
                    }
                }
            }
            Ok(response) => {
                let message = response
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent could not return to the Native Pane");
                Ok(refuse(SandboxActionErrorKind::Failed, message))
            }
            Err(error) => Ok(refuse(SandboxActionErrorKind::Unavailable, &error)),
        }
    }
}
