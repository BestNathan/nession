//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::image::{
    image_build_success_reply, image_error_reply, image_unauthenticated_reply, parse_image_payload,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::image::v1::ImageBuildRetryPayload;

const WIRE: &str = "server.image.build.retry";

impl ConnectionHandler {
    /// `server.image.build.retry` — start a new attempt in the same record.
    ///
    /// A verified snapshot is reused; a Git source may refetch its pinned
    /// commit. A local source with no trustworthy snapshot is refused rather
    /// than silently re-copied.
    pub(super) async fn handle_client_image_build_retry(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(image_unauthenticated_reply(&msg.id, WIRE));
        }
        let payload: ImageBuildRetryPayload = match parse_image_payload(&msg.id, WIRE, msg.payload)
        {
            Ok(payload) => payload,
            Err(reply) => return Ok(reply),
        };
        match self.image_manager.retry_build(&payload.build_id).await {
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
