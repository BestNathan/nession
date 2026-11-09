//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::project::{
    parse_project_payload, project_error_reply, project_success_reply,
    project_unauthenticated_reply, project_unavailable_reply,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use crate::db::ProjectRow;
use nession_protocol::contracts::project::v1::{
    validate_project_draft, ProjectCreatePayload, PROJECT_ID_PREFIX,
};

const WIRE: &str = "server.project.create";

impl ConnectionHandler {
    /// `server.project.create` — persist a new Project declaration.
    ///
    /// A name is the only required field. The Server mints the identity; no
    /// Agent, Git source, location or Session may block persistence (SC-01,
    /// SC-02).
    pub(super) async fn handle_client_project_create(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(project_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ProjectCreatePayload = match parse_project_payload(&msg.id, WIRE, msg.payload)
        {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
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
            project_id: format!("{PROJECT_ID_PREFIX}{}", uuid::Uuid::new_v4()),
            name: normalized.name,
            description: normalized.description,
            source: normalized.source,
            locations: normalized.locations,
            session_defaults: normalized.session_defaults,
            image_digest: normalized.image_digest,
            created_at: now,
            updated_at: now,
        };
        if let Err(e) = self.db.insert_project(&row).await {
            tracing::error!("Failed to create project: {e:#}");
            return Ok(project_unavailable_reply(
                &msg.id,
                WIRE,
                "Project could not be saved",
            ));
        }
        Ok(project_success_reply(&msg.id, WIRE, &row))
    }
}
