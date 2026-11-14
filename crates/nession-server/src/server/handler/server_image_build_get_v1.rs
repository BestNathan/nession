//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::image::{
    image_build_success_reply, image_error_reply, image_unauthenticated_reply, parse_image_payload,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::image::v1::ImageBuildGetPayload;

const WIRE: &str = "server.image.build.get";

impl ConnectionHandler {
    /// `server.image.build.get` — read the authoritative durable state.
    pub(super) async fn handle_client_image_build_get(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(image_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ImageBuildGetPayload = match parse_image_payload(&msg.id, WIRE, msg.payload) {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
        match self.image_manager.get_build(&payload.build_id).await {
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
