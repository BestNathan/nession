//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, reply_json, warn, ClientSessionSandboxPreflightPayload, ConnectionHandler,
    Duration, HandlerAction, ProtocolMessage, SandboxCapabilityCatalog, SandboxPreflightResult,
};
use nession_protocol::contracts::image::v1::ImageStatus;
use nession_protocol::contracts::sandbox::v1::{validate_image_selections, SandboxFieldError};

/// Preflight is the Agent's compile + host-capability check. It creates no
/// resources, but a cold cache still probes Bubblewrap and the cgroup
/// delegation.
const SANDBOX_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(30);

impl ConnectionHandler {
    /// Handle `server.session.sandbox.preflight` — validate one draft against
    /// the exact context generation on the Session's Agent.
    ///
    /// The Server forwards the typed draft untouched. It does not compile,
    /// normalize or interpret the policy: `nession-sandbox` is the validator.
    pub(super) async fn handle_client_session_sandbox_preflight(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let id = msg.id.clone();
        let refuse = |error: &str, generation: &str| {
            reply_json(
                &id,
                "server.session.sandbox.preflight",
                serde_json::to_value(SandboxPreflightResult {
                    ok: false,
                    error: Some(error.to_string()),
                    generation: generation.to_string(),
                    policy_digest: None,
                    backend: None,
                    mechanisms: Vec::new(),
                    errors: Vec::new(),
                    warnings: Vec::new(),
                    catalog: SandboxCapabilityCatalog::unknown(error),
                })
                .unwrap_or_else(|_| json!({ "ok": false, "error": "refused" })),
            )
        };
        let refuse_with_errors = |error: &str, generation: &str, errors: Vec<SandboxFieldError>| {
            reply_json(
                &id,
                "server.session.sandbox.preflight",
                serde_json::to_value(SandboxPreflightResult {
                    ok: false,
                    error: Some(error.to_string()),
                    generation: generation.to_string(),
                    policy_digest: None,
                    backend: None,
                    mechanisms: Vec::new(),
                    errors,
                    warnings: Vec::new(),
                    catalog: SandboxCapabilityCatalog::unknown(error),
                })
                .unwrap_or_else(|_| json!({ "ok": false, "error": "refused" })),
            )
        };
        if !self.authenticated_client {
            warn!("Unauthenticated client requested a Sandbox preflight");
            return Ok(refuse("Not authenticated", ""));
        }
        let Ok(payload) =
            serde_json::from_value::<ClientSessionSandboxPreflightPayload>(msg.payload)
        else {
            return Ok(refuse("session_id is required", ""));
        };
        if payload.session_id.is_empty() {
            return Ok(refuse("session_id is required", ""));
        }
        let (agent_id, session_name) = match self.sandbox_session_target(&payload.session_id).await
        {
            Ok(target) => target,
            Err(error) => return Ok(refuse(&error, &payload.generation)),
        };

        if !payload.images.is_empty()
            && payload
                .policy
                .filesystem
                .as_ref()
                .is_some_and(|filesystem| {
                    !filesystem.access.read.is_empty() || !filesystem.access.write.is_empty()
                })
        {
            return Ok(refuse_with_errors(
                "the Sandbox image composition conflicts with filesystem.access",
                &payload.generation,
                vec![SandboxFieldError {
                    field: "filesystem.access".to_string(),
                    code: "conflict".to_string(),
                    message: "filesystem.composition replaces filesystem.access; clear the access lists before selecting images".to_string(),
                }],
            ));
        }
        if let Err(errors) = validate_image_selections(&payload.images) {
            return Ok(refuse_with_errors(
                "the Sandbox image selection is not a valid composition",
                &payload.generation,
                errors,
            ));
        }
        for (index, selection) in payload.images.iter().enumerate() {
            match self.image_manager.get(Some(&selection.digest), None).await {
                Ok(image) if image.status == ImageStatus::Ready => {}
                Ok(_) => {
                    return Ok(refuse_with_errors(
                        "a selected Sandbox image is not Server Ready",
                        &payload.generation,
                        vec![SandboxFieldError {
                            field: format!("images[{index}].digest"),
                            code: "not-ready".to_string(),
                            message: format!("image {} is not Server Ready", selection.digest),
                        }],
                    ));
                }
                Err(error) => {
                    return Ok(refuse_with_errors(
                        "a selected Sandbox image is not available",
                        &payload.generation,
                        vec![SandboxFieldError {
                            field: format!("images[{index}].digest"),
                            code: "not-found".to_string(),
                            message: error.message().to_string(),
                        }],
                    ));
                }
            }
        }

        info!(
            "Requesting a Sandbox preflight: agent_id={}, session_name={}, generation={}, images={}",
            agent_id,
            session_name,
            payload.generation,
            payload.images.len()
        );
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.session.sandbox.preflight",
                json!({
                    "session_name": session_name,
                    "generation": payload.generation,
                    "probe_generation": payload.probe_generation,
                    "policy": payload.policy,
                    "images": payload.images,
                    "working_dir": payload.working_dir,
                }),
                SANDBOX_PREFLIGHT_TIMEOUT,
            )
            .await
        {
            Ok(response)
                if response.get("success").and_then(serde_json::Value::as_bool) == Some(true) =>
            {
                let result = response
                    .get("result")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<SandboxPreflightResult>(value).ok());
                match result {
                    Some(result) => Ok(reply_json(
                        &id,
                        "server.session.sandbox.preflight",
                        serde_json::to_value(result)
                            .unwrap_or_else(|_| json!({ "ok": false, "error": "refused" })),
                    )),
                    None => {
                        warn!("Agent returned an unreadable Sandbox preflight");
                        Ok(refuse(
                            "Agent returned an unreadable Sandbox preflight",
                            &payload.generation,
                        ))
                    }
                }
            }
            Ok(response) => {
                let message = response
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent could not preflight the Sandbox draft");
                Ok(refuse(message, &payload.generation))
            }
            Err(error) => Ok(refuse(&error, &payload.generation)),
        }
    }
}
