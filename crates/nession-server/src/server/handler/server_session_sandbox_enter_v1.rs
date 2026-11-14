//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, reply_json, warn, ClientSessionSandboxEnterPayload, ConnectionHandler, Duration,
    HandlerAction, ProtocolMessage, SandboxActionErrorKind, SandboxActionResult,
};
use nession_protocol::contracts::sandbox::v1::{
    validate_image_selections, SandboxFieldError, SandboxImageMode, SandboxImageRole,
    SandboxImageSelection,
};
use nession_protocol::contracts::session::v1::{ManagedImageGrant, ManagedImageRole};

/// Enter may prepare a full image composition in the Agent's durable cache
/// before it creates the Pane. The budget covers preparation, launch and the
/// barrier; a missing cache or image still fails closed.
const SANDBOX_ENTER_TIMEOUT: Duration = Duration::from_secs(300);

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
        let refuse_with_fields =
            |kind: SandboxActionErrorKind, error: &str, field_errors: Vec<SandboxFieldError>| {
                reply_json(
                    &id,
                    "server.session.sandbox.enter",
                    serde_json::to_value(SandboxActionResult {
                        success: false,
                        error_kind: Some(kind),
                        error: Some(error.to_string()),
                        field_errors: Some(field_errors),
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

        let images = match super::server_session_sandbox_images::derive_sandbox_image_selections(
            &payload.policy,
            payload.images.clone(),
        ) {
            Ok(images) => images,
            Err(error) => {
                return Ok(refuse(SandboxActionErrorKind::Invalid, &error));
            }
        };

        if !images.is_empty()
            && payload
                .policy
                .filesystem
                .as_ref()
                .is_some_and(|filesystem| {
                    !filesystem.access.read.is_empty() || !filesystem.access.write.is_empty()
                })
        {
            return Ok(refuse(
                SandboxActionErrorKind::Invalid,
                "filesystem.composition replaces filesystem.access; clear the access lists before selecting images",
            ));
        }
        let workspace = match self
            .resolve_sandbox_workspace(&agent_id, &payload.session_id, &payload.policy, &images)
            .await
        {
            Ok(workspace) => workspace,
            Err((error, field_error)) => {
                return Ok(refuse_with_fields(
                    SandboxActionErrorKind::Invalid,
                    &error,
                    vec![field_error],
                ));
            }
        };
        let mut images = images;
        if let Some(digest) = workspace.lower_digest {
            images.push(SandboxImageSelection {
                role: SandboxImageRole::Workspace,
                digest,
                target: None,
                mode: SandboxImageMode::Overlay,
            });
        }
        if let Err(errors) = validate_image_selections(&images) {
            return Ok(refuse_with_fields(
                SandboxActionErrorKind::Invalid,
                "the Sandbox image selection is not a valid composition",
                errors,
            ));
        }
        let mut grants = Vec::with_capacity(images.len());
        for selection in &images {
            let grant = match self
                .image_manager
                .grant_sandbox_access(&payload.session_id, &selection.digest)
                .await
            {
                Ok(grant) => grant,
                Err(error) => {
                    return Ok(refuse(
                        if error.kind() == "unavailable" {
                            SandboxActionErrorKind::Unavailable
                        } else {
                            SandboxActionErrorKind::Invalid
                        },
                        &format!(
                            "cannot authorize Sandbox image {}: {}",
                            selection.digest,
                            error.message()
                        ),
                    ));
                }
            };
            grants.push(managed_grant(selection, grant));
        }

        info!(
            "Sandbox Enter: agent_id={}, session_name={}, generation={}, enter_id={}, images={}",
            agent_id,
            session_name,
            payload.generation,
            payload.enter_id,
            grants.len()
        );
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.session.sandbox.enter",
                json!({
                    "session_name": session_name,
                    "generation": payload.generation,
                    "probe_generation": payload.probe_generation,
                    "enter_id": payload.enter_id,
                    "policy": payload.policy,
                    "images": grants,
                    "project_location": workspace.project_location,
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

fn managed_grant(
    selection: &SandboxImageSelection,
    grant: crate::image::ImageAccessGrant,
) -> ManagedImageGrant {
    let (role, target) = match selection.role {
        SandboxImageRole::Base => (ManagedImageRole::Base, None),
        SandboxImageRole::Workspace => (ManagedImageRole::Workspace, None),
        SandboxImageRole::Toolchain => (ManagedImageRole::Toolchain, selection.target.clone()),
    };
    ManagedImageGrant {
        role,
        digest: selection.digest.clone(),
        path: grant.path,
        token: grant.token,
        target,
    }
}
