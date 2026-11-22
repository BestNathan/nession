//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::image::{
    image_impact_reply, image_tag_error_reply, image_unauthenticated_reply, parse_image_payload,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::image::v1::ImageImpactPayload;

const WIRE: &str = "server.image.impact.get";

impl ConnectionHandler {
    /// `server.image.impact.get` — known reference impact for one Tag.
    pub(super) async fn handle_client_image_impact_get(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(image_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ImageImpactPayload = match parse_image_payload(&msg.id, WIRE, msg.payload) {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
        match self
            .image_manager
            .tag_impact(&payload.repository, &payload.tag)
            .await
        {
            Ok(impact) => Ok(image_impact_reply(&msg.id, WIRE, &impact)),
            Err(error) => Ok(image_tag_error_reply(&msg.id, WIRE, &error, None, None)),
        }
    }
}
