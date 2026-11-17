//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::image::{
    image_tag_error_reply, image_tag_remove_reply, image_unauthenticated_reply, parse_image_payload,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use crate::image::ImageError;
use nession_protocol::contracts::image::v1::ImageTagRemovePayload;

const WIRE: &str = "server.image.tag.remove";

impl ConnectionHandler {
    /// `server.image.tag.remove` — CAS-guarded logical unlink of one Tag.
    pub(super) async fn handle_client_image_tag_remove(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(image_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ImageTagRemovePayload = match parse_image_payload(&msg.id, WIRE, msg.payload) {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
        match self.image_manager.tag_remove(&payload).await {
            Ok(impact) => Ok(image_tag_remove_reply(&msg.id, WIRE, &impact)),
            Err(error) => {
                let current = match error {
                    ImageError::Conflict(_) => {
                        self.image_manager
                            .tag_current(&payload.repository, &payload.tag)
                            .await
                    }
                    _ => None,
                };
                let impact = match error {
                    ImageError::ImpactRequired(_) => self
                        .image_manager
                        .tag_impact(&payload.repository, &payload.tag)
                        .await
                        .ok(),
                    _ => None,
                };
                Ok(image_tag_error_reply(
                    &msg.id,
                    WIRE,
                    &error,
                    current,
                    impact.as_ref(),
                ))
            }
        }
    }
}
