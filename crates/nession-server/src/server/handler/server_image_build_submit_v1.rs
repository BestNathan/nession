//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::image::{
    image_build_success_reply, image_error_reply, image_unauthenticated_reply, parse_image_payload,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::image::v1::ImageBuildSubmitPayload;

const WIRE: &str = "server.image.build.submit";

impl ConnectionHandler {
    /// `server.image.build.submit` — create one durable asynchronous build.
    ///
    /// The durable directory and `building` registry row exist before this
    /// returns; no Git or `mkfs.erofs` work has to finish. A repeated
    /// `client_request_id` with the same source returns the existing record.
    pub(super) async fn handle_client_image_build_submit(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(image_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ImageBuildSubmitPayload = match parse_image_payload(&msg.id, WIRE, msg.payload)
        {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
        match self
            .image_manager
            .submit_build(
                &payload.source,
                payload.alias.as_deref(),
                payload.client_request_id.as_deref(),
            )
            .await
        {
            Ok(build) => Ok(image_build_success_reply(&msg.id, WIRE, &build)),
            Err(error) => Ok(image_error_reply(
                &msg.id,
                WIRE,
                error.kind(),
                error.message(),
            )),
        }
    }
}
