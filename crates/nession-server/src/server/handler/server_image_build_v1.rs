//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::image::{
    image_error_reply, image_success_reply, image_unauthenticated_reply, parse_image_payload,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::image::v1::ImageBuildPayload;

const WIRE: &str = "server.image.build";

impl ConnectionHandler {
    /// `server.image.build` — build one source into the global image store.
    ///
    /// The manager validates and normalizes the source canonically, runs the
    /// bounded worker, and publishes only after the digest has been computed
    /// from stored bytes. A failed build returns a recoverable `build_failed`
    /// refusal and never exposes partial bytes as ready.
    pub(super) async fn handle_client_image_build(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(image_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ImageBuildPayload = match parse_image_payload(&msg.id, WIRE, msg.payload) {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
        match self
            .image_manager
            .build(&payload.source, payload.alias.as_deref())
            .await
        {
            Ok(image) => Ok(image_success_reply(&msg.id, WIRE, &image)),
            Err(error) => Ok(image_error_reply(
                &msg.id,
                WIRE,
                error.kind(),
                error.message(),
            )),
        }
    }
}
