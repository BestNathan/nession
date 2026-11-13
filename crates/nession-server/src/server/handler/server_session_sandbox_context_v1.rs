//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, reply_json, warn, ClientSessionSandboxContextPayload, ConnectionHandler, Duration,
    HandlerAction, ProtocolMessage, SandboxContextResponse, SandboxCurrentContext,
};
use nession_protocol::contracts::image::v1::ImageCacheObservation;

/// The Agent has to resolve the active Pane, read the Session's instance
/// identity and (on a cold catalog) measure the host before it can answer.
const SANDBOX_CONTEXT_TIMEOUT: Duration = Duration::from_secs(20);

impl ConnectionHandler {
    /// Handle `server.session.sandbox.context` — relay the Agent's observation
    /// of the active Pane's Sandbox context.
    ///
    /// The Server authorizes the browser and routes to the Session's Agent. It
    /// does not name a Pane, does not cache a context and never infers
    /// `inside` from host support: every answer is the Agent's observation at
    /// the moment it was asked.
    pub(super) async fn handle_client_session_sandbox_context(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let id = msg.id.clone();
        let refusal = |message: &str| {
            reply_json(
                &id,
                "server.session.sandbox.context",
                serde_json::to_value(SandboxContextResponse {
                    success: false,
                    error: Some(message.to_string()),
                    context: None,
                    cache_statuses: Vec::new(),
                    cache_observations: Vec::new(),
                })
                .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
            )
        };
        if !self.authenticated_client {
            warn!("Unauthenticated client requested the Sandbox context");
            return Ok(refusal("Not authenticated"));
        }
        let Ok(payload) = serde_json::from_value::<ClientSessionSandboxContextPayload>(msg.payload)
        else {
            return Ok(refusal("session_id is required"));
        };
        if payload.session_id.is_empty() {
            return Ok(refusal("session_id is required"));
        }
        if let Some(digest) = payload
            .cache_digests
            .iter()
            .find(|digest| !nession_protocol::contracts::image::v1::is_valid_image_digest(digest))
        {
            return Ok(refusal(&format!("invalid cache digest: {digest}")));
        }
        let (agent_id, session_name) = match self.sandbox_session_target(&payload.session_id).await
        {
            Ok(target) => target,
            Err(error) => return Ok(refusal(&error)),
        };

        info!(
            "Requesting the Sandbox context: agent_id={}, session_name={}, cache_digests={}",
            agent_id,
            session_name,
            payload.cache_digests.len()
        );
        match self
            .agent_command_with_timeout(
                &agent_id,
                "agent.session.sandbox.context",
                json!({
                    "session_name": session_name,
                    "cache_digests": payload.cache_digests,
                }),
                SANDBOX_CONTEXT_TIMEOUT,
            )
            .await
        {
            Ok(response)
                if response.get("success").and_then(serde_json::Value::as_bool) == Some(true) =>
            {
                let context = response
                    .get("context")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<SandboxCurrentContext>(value).ok());
                let cache_observations = match response.get("cache_observations") {
                    Some(value) => {
                        match serde_json::from_value::<Vec<ImageCacheObservation>>(value.clone()) {
                            Ok(observations) => observations,
                            Err(error) => {
                                warn!("Agent returned an unreadable cache observation: {error}");
                                return Ok(refusal(
                                    "Agent returned an unreadable cache observation",
                                ));
                            }
                        }
                    }
                    None => Vec::new(),
                };
                for observation in &cache_observations {
                    if let Err(error) = observation.validate() {
                        warn!("Agent returned an invalid cache observation: {error}");
                        return Ok(refusal("Agent returned an invalid cache observation"));
                    }
                }
                match context {
                    Some(context) => Ok(reply_json(
                        &id,
                        "server.session.sandbox.context",
                        serde_json::to_value(SandboxContextResponse {
                            success: true,
                            error: None,
                            context: Some(context),
                            cache_statuses: response
                                .get("cache_statuses")
                                .cloned()
                                .and_then(|value| serde_json::from_value(value).ok())
                                .unwrap_or_default(),
                            cache_observations,
                        })
                        .unwrap_or_else(|_| json!({ "success": false, "error": "refused" })),
                    )),
                    None => {
                        warn!("Agent returned an unreadable Sandbox context");
                        Ok(refusal("Agent returned an unreadable Sandbox context"))
                    }
                }
            }
            Ok(response) => {
                let message = response
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent could not read the Sandbox context");
                Ok(refusal(message))
            }
            Err(error) => Ok(refusal(&error)),
        }
    }
}
