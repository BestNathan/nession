//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, reply_json, warn, ClientSessionSandboxImagePreparePayload, ConnectionHandler,
    Duration, HandlerAction, ProtocolMessage, SandboxImagePrepareResponse,
};
use nession_protocol::contracts::image::v1::{is_valid_image_digest, ImageCacheObservation};
use nession_protocol::contracts::sandbox::v1::{
    SandboxActionErrorKind, SandboxImageMode, SandboxImageRole, SandboxImageSelection,
};

use super::server_session_sandbox_images::prepare_grant;

/// One explicit prepare may resolve metadata and a full EROFS payload.
const SANDBOX_IMAGE_PREPARE_TIMEOUT: Duration = Duration::from_secs(300);

impl ConnectionHandler {
    /// Handle `server.session.sandbox.image-prepare` — one explicit,
    /// user-authorized prepare/resume/retry of one Image identity in the
    /// current Session Agent's cache (#3796).
    ///
    /// The Server authenticates the browser, proves the Session's registered
    /// Agent, authorizes the exact identity and mints one scoped grant. It
    /// never starts a download on its own and never treats an observation read
    /// as a request. A read failure is a typed refusal, not a fabricated
    /// cache state.
    pub(super) async fn handle_client_session_sandbox_image_prepare(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let id = msg.id.clone();
        let refuse = |kind: SandboxActionErrorKind, error: &str| {
            reply_json(
                &id,
                "server.session.sandbox.image-prepare",
                serde_json::to_value(SandboxImagePrepareResponse {
                    success: false,
                    error: Some(error.to_string()),
                    error_kind: Some(kind),
                    observation: None,
                    observations: Vec::new(),
                })
                .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
            )
        };
        if !self.authenticated_client {
            warn!("Unauthenticated client requested an Agent image preparation");
            return Ok(refuse(
                SandboxActionErrorKind::Unavailable,
                "Not authenticated",
            ));
        }
        let Ok(payload) =
            serde_json::from_value::<ClientSessionSandboxImagePreparePayload>(msg.payload)
        else {
            return Ok(refuse(
                SandboxActionErrorKind::Invalid,
                "session_id, digest and intent are required",
            ));
        };
        if payload.session_id.is_empty() {
            return Ok(refuse(
                SandboxActionErrorKind::Invalid,
                "session_id is required",
            ));
        }
        if !is_valid_image_digest(&payload.digest) {
            return Ok(refuse(
                SandboxActionErrorKind::Invalid,
                "image digest must be a sha256:<64 lowercase hex> digest",
            ));
        }
        let (agent_id, session_name) = match self.sandbox_session_target(&payload.session_id).await
        {
            Ok(target) => target,
            Err(error) => {
                return Ok(refuse(SandboxActionErrorKind::Unavailable, &error));
            }
        };
        let platform = self
            .agent_registry
            .get(&agent_id)
            .await
            .and_then(|agent| crate::image::agent_platform(&agent));
        let resolution = match self
            .image_manager
            .resolve_sandbox_image(&payload.session_id, &payload.digest, platform.as_ref())
            .await
        {
            Ok(resolution) => resolution,
            Err(error) => {
                let kind = match error.kind() {
                    "unavailable" => SandboxActionErrorKind::Unavailable,
                    "build_failed" => SandboxActionErrorKind::Failed,
                    _ => SandboxActionErrorKind::Invalid,
                };
                return Ok(refuse(
                    kind,
                    &format!(
                        "cannot authorize image {} for this Session: {}",
                        payload.digest,
                        error.message()
                    ),
                ));
            }
        };
        // The role is not part of a cache identity: one digest prepared here
        // is the same verified bytes whichever composition later mounts it.
        let selection = SandboxImageSelection {
            role: SandboxImageRole::Base,
            digest: payload.digest.clone(),
            target: None,
            mode: SandboxImageMode::ReadOnly,
        };
        let grant = prepare_grant(&selection, resolution);
        info!(
            "Image prepare: agent_id={}, session_name={}, digest={}, intent={:?}",
            agent_id, session_name, payload.digest, payload.intent
        );
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.session.sandbox.image-prepare",
                json!({
                    "session_name": session_name,
                    "digest": payload.digest,
                    "intent": payload.intent,
                    "grant": grant,
                }),
                SANDBOX_IMAGE_PREPARE_TIMEOUT,
            )
            .await
        {
            Ok(response)
                if response.get("success").and_then(serde_json::Value::as_bool) == Some(true) =>
            {
                let observation = match response.get("observation") {
                    Some(value) => {
                        match serde_json::from_value::<ImageCacheObservation>(value.clone()) {
                            Ok(observation) => Some(observation),
                            Err(error) => {
                                warn!(
                                    "Agent returned an unreadable image preparation observation: {error}"
                                );
                                return Ok(refuse(
                                    SandboxActionErrorKind::Failed,
                                    "Agent returned an unreadable image preparation observation",
                                ));
                            }
                        }
                    }
                    None => None,
                };
                let observations = match response.get("observations") {
                    Some(value) => {
                        match serde_json::from_value::<Vec<ImageCacheObservation>>(value.clone()) {
                            Ok(observations) => observations,
                            Err(error) => {
                                warn!(
                                    "Agent returned unreadable image closure observations: {error}"
                                );
                                return Ok(refuse(
                                    SandboxActionErrorKind::Failed,
                                    "Agent returned unreadable image closure observations",
                                ));
                            }
                        }
                    }
                    None => Vec::new(),
                };
                for observation in observation.iter().chain(observations.iter()) {
                    if let Err(error) = observation.validate() {
                        warn!("Agent returned an invalid image preparation observation: {error}");
                        return Ok(refuse(
                            SandboxActionErrorKind::Failed,
                            "Agent returned an invalid image preparation observation",
                        ));
                    }
                }
                Ok(reply_json(
                    &id,
                    "server.session.sandbox.image-prepare",
                    serde_json::to_value(SandboxImagePrepareResponse {
                        success: true,
                        error: None,
                        error_kind: None,
                        observation,
                        observations,
                    })
                    .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
                ))
            }
            Ok(response) => {
                let message = response
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent could not prepare the image");
                let kind = match response
                    .get("error_kind")
                    .and_then(serde_json::Value::as_str)
                {
                    Some("unavailable") => SandboxActionErrorKind::Unavailable,
                    Some("invalid") => SandboxActionErrorKind::Invalid,
                    _ => SandboxActionErrorKind::Failed,
                };
                Ok(refuse(kind, message))
            }
            Err(error) => Ok(refuse(SandboxActionErrorKind::Unavailable, &error)),
        }
    }
}
