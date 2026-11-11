//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::project::{
    parse_project_payload, project_error_reply, project_success_reply,
    project_unauthenticated_reply, project_unavailable_reply,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use crate::db::ProjectRow;
use nession_protocol::contracts::project::v1::{
    is_valid_project_id, validate_project_draft, ProjectUpdatePayload, ProjectValidationError,
};

const WIRE: &str = "server.project.update";

impl ConnectionHandler {
    /// `server.project.update` — replace one Project's mutable declaration.
    ///
    /// The replacement is whole, like the Session Environment Binding's set
    /// operation: absent optional fields clear, an empty location list clears
    /// the locations. Identity and creation time are owned by the Server and
    /// never reassigned (SC-04).
    pub(super) async fn handle_client_project_update(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(project_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ProjectUpdatePayload = match parse_project_payload(&msg.id, WIRE, msg.payload)
        {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
        if !is_valid_project_id(&payload.project_id) {
            return Ok(project_error_reply(
                &msg.id,
                WIRE,
                "invalid",
                &ProjectValidationError::InvalidProjectId.message(),
            ));
        }
        let normalized = match validate_project_draft(
            &payload.name,
            payload.description.as_deref(),
            payload.source.as_ref(),
            &payload.locations,
            payload.session_defaults.as_ref(),
            payload.image_digest.as_deref(),
        ) {
            Ok(normalized) => normalized,
            Err(error) => {
                return Ok(project_error_reply(
                    &msg.id,
                    WIRE,
                    "invalid",
                    &error.message(),
                ))
            }
        };

        let now = chrono::Utc::now().timestamp();
        let row = ProjectRow {
            project_id: payload.project_id,
            name: normalized.name,
            description: normalized.description,
            source: normalized.source,
            locations: normalized.locations,
            session_defaults: normalized.session_defaults,
            image_digest: normalized.image_digest,
            // The DAO preserves the stored creation time; this value is unused.
            created_at: 0,
            updated_at: now,
        };
        match self.db.update_project(&row).await {
            Ok(Some(updated)) => Ok(project_success_reply(&msg.id, WIRE, &updated)),
            Ok(None) => Ok(project_error_reply(
                &msg.id,
                WIRE,
                "not_found",
                "Project not found",
            )),
            Err(e) => {
                tracing::error!("Failed to update project {}: {e:#}", row.project_id);
                Ok(project_unavailable_reply(
                    &msg.id,
                    WIRE,
                    "Project could not be saved",
                ))
            }
        }
    }
}
