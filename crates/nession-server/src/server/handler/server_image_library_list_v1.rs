//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::image::{
    image_error_reply, image_library_reply, image_unauthenticated_reply, parse_image_payload,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::image::v1::ImageLibraryListPayload;

const WIRE: &str = "server.image.library.list";

impl ConnectionHandler {
    /// `server.image.library.list` — the Server Catalog Library page.
    pub(super) async fn handle_client_image_library_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(image_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ImageLibraryListPayload = match parse_image_payload(&msg.id, WIRE, msg.payload)
        {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
        match self
            .image_manager
            .library(
                payload.offset,
                payload.limit,
                &payload.query,
                &payload.repository,
            )
            .await
        {
            Ok(page) => Ok(image_library_reply(&msg.id, WIRE, &page)),
            Err(error) => Ok(image_error_reply(
                &msg.id,
                WIRE,
                error.kind(),
                error.message(),
            )),
        }
    }
}
