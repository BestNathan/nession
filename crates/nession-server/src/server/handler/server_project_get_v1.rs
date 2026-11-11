//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::project::{
    parse_project_payload, project_error_reply, project_success_reply,
    project_unauthenticated_reply, project_unavailable_reply,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::project::v1::{
    is_valid_project_id, ProjectGetPayload, ProjectValidationError,
};

const WIRE: &str = "server.project.get";

impl ConnectionHandler {
    /// `server.project.get` — one Project by its stable identity.
    ///
    /// Reads do not require a Session, an Agent or a selected workspace: a
    /// Project exists independently of all of them (SC-06).
    pub(super) async fn handle_client_project_get(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(project_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ProjectGetPayload = match parse_project_payload(&msg.id, WIRE, msg.payload) {
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
        match self.db.get_project(&payload.project_id).await {
            Ok(Some(row)) => Ok(project_success_reply(&msg.id, WIRE, &row)),
            Ok(None) => Ok(project_error_reply(
                &msg.id,
                WIRE,
                "not_found",
                "Project not found",
            )),
            Err(e) => {
                tracing::error!("Failed to read project {}: {e:#}", payload.project_id);
                Ok(project_unavailable_reply(
                    &msg.id,
                    WIRE,
                    "Project could not be loaded",
                ))
            }
        }
    }
}
