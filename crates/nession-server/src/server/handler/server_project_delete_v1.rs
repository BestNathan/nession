//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::project::{
    parse_project_payload, project_error_reply, project_success_reply_without_project,
    project_unauthenticated_reply, project_unavailable_reply,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::project::v1::{
    is_valid_project_id, ProjectDeletePayload, ProjectValidationError,
};

const WIRE: &str = "server.project.delete";

impl ConnectionHandler {
    /// `server.project.delete` — remove only the Project declaration.
    ///
    /// Existing Locations are user-owned host directories and image digests
    /// reference globally shared EROFS artifacts; neither is deleted, and no
    /// Session is cascaded (SC-03).
    pub(super) async fn handle_client_project_delete(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(project_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ProjectDeletePayload = match parse_project_payload(&msg.id, WIRE, msg.payload)
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
        match self.db.delete_project(&payload.project_id).await {
            Ok(true) => Ok(project_success_reply_without_project(&msg.id, WIRE)),
            Ok(false) => Ok(project_error_reply(
                &msg.id,
                WIRE,
                "not_found",
                "Project not found",
            )),
            Err(e) => {
                tracing::error!("Failed to delete project {}: {e:#}", payload.project_id);
                Ok(project_unavailable_reply(
                    &msg.id,
                    WIRE,
                    "Project could not be deleted",
                ))
            }
        }
    }
}
