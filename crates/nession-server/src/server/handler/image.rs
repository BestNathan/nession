//! Shared reply building for the Image units (#3022).
//!
//! One conversion from the contract descriptor to the wire and one refusal
//! shape, so the four image handlers cannot drift from each other.

use serde_json::{json, Value};

use crate::image::{BuildListPage, ImageError, ImageLibraryPage, ImageListPage};
use crate::server::handler::{reply_json, HandlerAction};
use nession_protocol::contracts::image::v1::{
    ImageBuildDescriptor, ImageDescriptor, ImageReferenceImpact, ImageTagUpdate,
};

pub(super) fn image_success_reply(id: &str, wire: &str, image: &ImageDescriptor) -> HandlerAction {
    reply_json(id, wire, json!({ "success": true, "image": image }))
}

pub(super) fn image_list_reply(id: &str, wire: &str, page: &ImageListPage) -> HandlerAction {
    let mut payload = serde_json::Map::new();
    payload.insert("success".to_string(), json!(true));
    payload.insert("images".to_string(), json!(page.images));
    payload.insert("total".to_string(), json!(page.total));
    if let Some(next_offset) = page.next_offset {
        payload.insert("next_offset".to_string(), json!(next_offset));
    }
    reply_json(id, wire, Value::Object(payload))
}

pub(super) fn image_build_success_reply(
    id: &str,
    wire: &str,
    build: &ImageBuildDescriptor,
) -> HandlerAction {
    reply_json(id, wire, json!({ "success": true, "build": build }))
}

pub(super) fn image_build_list_reply(id: &str, wire: &str, page: &BuildListPage) -> HandlerAction {
    let mut payload = serde_json::Map::new();
    payload.insert("builds".to_string(), json!(page.builds));
    payload.insert("total".to_string(), json!(page.total));
    if let Some(next_offset) = page.next_offset {
        payload.insert("next_offset".to_string(), json!(next_offset));
    }
    reply_json(id, wire, Value::Object(payload))
}

pub(super) fn image_error_reply(id: &str, wire: &str, kind: &str, error: &str) -> HandlerAction {
    reply_json(
        id,
        wire,
        json!({ "success": false, "error": error, "error_kind": kind }),
    )
}

/// One Library page reply (#3799).
pub(super) fn image_library_reply(id: &str, wire: &str, page: &ImageLibraryPage) -> HandlerAction {
    let mut payload = serde_json::Map::new();
    payload.insert("success".to_string(), json!(true));
    payload.insert("entries".to_string(), json!(page.entries));
    payload.insert("total".to_string(), json!(page.total));
    if let Some(next_offset) = page.next_offset {
        payload.insert("next_offset".to_string(), json!(next_offset));
    }
    reply_json(id, wire, Value::Object(payload))
}

/// One committed Tag CAS mutation.
pub(super) fn image_tag_update_reply(
    id: &str,
    wire: &str,
    update: &ImageTagUpdate,
) -> HandlerAction {
    reply_json(id, wire, json!({ "success": true, "update": update }))
}

/// One logical Tag unlink with the impact the caller reviewed.
pub(super) fn image_tag_remove_reply(
    id: &str,
    wire: &str,
    impact: &ImageReferenceImpact,
) -> HandlerAction {
    reply_json(
        id,
        wire,
        json!({ "success": true, "removed": true, "impact": impact }),
    )
}

/// One reference-impact observation.
pub(super) fn image_impact_reply(
    id: &str,
    wire: &str,
    impact: &ImageReferenceImpact,
) -> HandlerAction {
    reply_json(id, wire, json!({ "success": true, "impact": impact }))
}

/// A Tag/impact refusal with optional conflict readback and impact review.
pub(super) fn image_tag_error_reply(
    id: &str,
    wire: &str,
    error: &ImageError,
    current_digest: Option<String>,
    impact: Option<&ImageReferenceImpact>,
) -> HandlerAction {
    let mut payload = serde_json::Map::new();
    payload.insert("success".to_string(), json!(false));
    payload.insert("error".to_string(), json!(error.message()));
    payload.insert("error_kind".to_string(), json!(error.kind()));
    if let Some(current_digest) = current_digest {
        payload.insert("current_digest".to_string(), json!(current_digest));
    }
    if let Some(impact) = impact {
        payload.insert("impact".to_string(), json!(impact));
    }
    reply_json(id, wire, Value::Object(payload))
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
