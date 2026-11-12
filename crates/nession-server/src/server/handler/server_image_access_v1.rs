//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::image::{
    image_access_reply, image_error_reply, image_unauthenticated_reply, parse_image_payload,
};
use super::{ConnectionHandler, HandlerAction, ProtocolMessage};
use nession_protocol::contracts::image::v1::{ImageAccessConsumer, ImageAccessPayload};

const WIRE: &str = "server.image.access";

impl ConnectionHandler {
    /// `server.image.access` — mint a consumer-scoped, expiring blob grant.
    ///
    /// A Project caller cannot obtain a grant for another Project's private
    /// digest, and a Session caller can only name a digest its own ready Managed
    /// context resolved. Physical digest dedupe is never the authority.
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
        let consumer = match payload.consumer() {
            Ok(consumer) => consumer,
            Err(error) => {
                return Ok(image_error_reply(
                    &msg.id,
                    WIRE,
                    "invalid",
                    &error.message(),
                ));
            }
        };
        let grant = match consumer {
            ImageAccessConsumer::Project(project_id) => {
                self.image_manager
                    .grant_access(project_id, &payload.digest)
                    .await
            }
            ImageAccessConsumer::Session(session_id) => {
                if let Err(error) = self.sandbox_session_target(session_id).await {
                    return Ok(image_error_reply(
                        &msg.id,
                        WIRE,
                        if error.contains("not found") {
                            "not_found"
                        } else {
                            "unavailable"
                        },
                        &error,
                    ));
                }
                self.image_manager
                    .grant_session_access(session_id, &payload.digest)
                    .await
            }
        };
        match grant {
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
