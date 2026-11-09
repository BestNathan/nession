//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::image::{
    image_error_reply, image_success_reply, image_unauthenticated_reply, parse_image_payload,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::image::v1::ImageGetPayload;

const WIRE: &str = "server.image.get";

impl ConnectionHandler {
    /// `server.image.get` — read one image by immutable digest or mutable alias.
    pub(super) async fn handle_client_image_get(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(image_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ImageGetPayload = match parse_image_payload(&msg.id, WIRE, msg.payload) {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
        if payload.digest.is_some() == payload.alias.is_some() {
            return Ok(image_error_reply(
                &msg.id,
                WIRE,
                "invalid",
                "server.image.get requires exactly one of digest or alias",
            ));
        }
        match self
            .image_manager
            .get(payload.digest.as_deref(), payload.alias.as_deref())
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
