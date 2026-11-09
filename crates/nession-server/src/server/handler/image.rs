//! Shared reply building for the Image units (#3022).
//!
//! One conversion from the contract descriptor to the wire and one refusal
//! shape, so the four image handlers cannot drift from each other.

use serde_json::{json, Value};

use crate::server::handler::{reply_json, HandlerAction};
use nession_protocol::contracts::image::v1::ImageDescriptor;

pub(super) fn image_success_reply(id: &str, wire: &str, image: &ImageDescriptor) -> HandlerAction {
    reply_json(id, wire, json!({ "success": true, "image": image }))
}

pub(super) fn image_list_reply(id: &str, wire: &str, images: &[ImageDescriptor]) -> HandlerAction {
    reply_json(id, wire, json!({ "success": true, "images": images }))
}

pub(super) fn image_access_reply(
    id: &str,
    wire: &str,
    token: &str,
    expires_at: u64,
    path: &str,
) -> HandlerAction {
    reply_json(
        id,
        wire,
        json!({
            "success": true,
            "token": token,
            "expires_at": expires_at,
            "path": path,
        }),
    )
}

pub(super) fn image_error_reply(id: &str, wire: &str, kind: &str, error: &str) -> HandlerAction {
    reply_json(
        id,
        wire,
        json!({ "success": false, "error": error, "error_kind": kind }),
    )
}

pub(super) fn image_unauthenticated_reply(id: &str, wire: &str) -> HandlerAction {
    image_error_reply(id, wire, "unauthorized", "Not authenticated")
}

pub(super) fn parse_image_payload<T: serde::de::DeserializeOwned>(
    id: &str,
    wire: &str,
    payload: Value,
) -> Result<T, HandlerAction> {
    serde_json::from_value(payload).map_err(|_| {
        image_error_reply(
            id,
            wire,
            "invalid",
            "Malformed image payload: required fields are missing or have the wrong type",
        )
    })
}
