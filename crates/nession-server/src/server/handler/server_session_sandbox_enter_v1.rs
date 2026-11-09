//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, reply_json, warn, ClientSessionSandboxEnterPayload, ConnectionHandler, Duration,
    HandlerAction, ProtocolMessage, SandboxActionErrorKind, SandboxActionResult,
};

/// Enter prepares host resources, creates a Pane, waits for the in-sandbox
/// launch barrier and verifies it. The budget has to cover all of them; the
/// Agent refuses long before this if anything is unavailable.
const SANDBOX_ENTER_TIMEOUT: Duration = Duration::from_secs(60);

impl ConnectionHandler {
    /// Handle `server.session.sandbox.enter` — the one explicit Enter.
    ///
    /// `Key` serializes Enter with every other mutation of this Session; the
    /// Agent additionally binds the draft to the context generation and
    /// replays a repeated `enter_id` without launching a second Pane.
    pub(super) async fn handle_client_session_sandbox_enter(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let id = msg.id.clone();
        let refuse = |kind: SandboxActionErrorKind, error: &str| {
            reply_json(
                &id,
                "server.session.sandbox.enter",
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
            warn!("Unauthenticated client requested Sandbox Enter");
            return Ok(refuse(
                SandboxActionErrorKind::Unavailable,
                "Not authenticated",
            ));
        }
        let Ok(payload) = serde_json::from_value::<ClientSessionSandboxEnterPayload>(msg.payload)
        else {
            return Ok(refuse(
                SandboxActionErrorKind::Invalid,
                "session_id, generation, enter_id and policy are required",
            ));
        };
        if payload.session_id.is_empty() || payload.enter_id.is_empty() {
            return Ok(refuse(
                SandboxActionErrorKind::Invalid,
                "session_id and enter_id are required",
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
            "Sandbox Enter: agent_id={}, session_name={}, generation={}, enter_id={}",
            agent_id, session_name, payload.generation, payload.enter_id
        );
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.session.sandbox.enter",
                json!({
                    "session_name": session_name,
                    "generation": payload.generation,
                    "enter_id": payload.enter_id,
                    "policy": payload.policy,
                    "working_dir": payload.working_dir,
                }),
                SANDBOX_ENTER_TIMEOUT,
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
                        "server.session.sandbox.enter",
                        serde_json::to_value(result)
                            .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
                    )),
                    None => {
                        warn!("Agent returned an unreadable Sandbox Enter result");
                        Ok(refuse(
                            SandboxActionErrorKind::Failed,
                            "Agent returned an unreadable Sandbox Enter result",
                        ))
                    }
                }
            }
            Ok(response) => {
                let message = response
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent could not enter the Sandbox");
                Ok(refuse(SandboxActionErrorKind::Failed, message))
            }
            Err(error) => Ok(refuse(SandboxActionErrorKind::Unavailable, &error)),
        }
    }
}
