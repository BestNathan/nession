//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::image::{
    image_access_reply, image_error_reply, image_unauthenticated_reply, parse_image_payload,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::image::v1::ImageAccessPayload;

const WIRE: &str = "server.image.access";

impl ConnectionHandler {
    /// `server.image.access` — mint a Project-scoped, expiring blob grant.
    ///
    /// A caller authorized for Project A cannot obtain a grant for Project B's
    /// private digest: the Project's own durable reference is the authority,
    /// independently of physical digest dedupe.
    pub(super) async fn handle_client_image_access(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(image_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ImageAccessPayload = match parse_image_payload(&msg.id, WIRE, msg.payload) {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
        match self
            .image_manager
            .grant_access(&payload.project_id, &payload.digest)
            .await
        {
            Ok(grant) => Ok(image_access_reply(
                &msg.id,
                WIRE,
                &grant.token,
                grant.expires_at,
                &grant.path,
            )),
            Err(error) => Ok(image_error_reply(
                &msg.id,
                WIRE,
                error.kind(),
                error.message(),
            )),
        }
    }
}
