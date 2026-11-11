//! Shared reply building for the Project units (#3021).
//!
//! One conversion from the persisted row to the versioned contract, and one
//! refusal shape, so the five Project handlers cannot drift from each other or
//! from the contract. This module owns no route and no `handle_*` method.

use serde_json::{json, Value};

use crate::db::ProjectRow;
use crate::server::handler::{reply_json, HandlerAction};
use nession_protocol::contracts::project::v1::Project;

/// Project as the wire carries it.
pub(super) fn project_from_row(row: &ProjectRow) -> Project {
    Project {
        project_id: row.project_id.clone(),
        name: row.name.clone(),
        description: row.description.clone(),
        source: row.source.clone(),
        locations: row.locations.clone(),
        session_defaults: row.session_defaults.clone(),
        image_digest: row.image_digest.clone(),
        // Timestamps are minted by `chrono::Utc::now().timestamp()` and are
        // non-negative; a negative stored value is corrupt state, and reporting
        // it as 0 keeps the reply inside the contract rather than failing it.
        created_at: u64::try_from(row.created_at).unwrap_or(0),
        updated_at: u64::try_from(row.updated_at).unwrap_or(0),
    }
}

pub(super) fn project_json(row: &ProjectRow) -> Value {
    serde_json::to_value(project_from_row(row)).unwrap_or(Value::Null)
}

/// A successful read/mutation reply carrying the Project.
pub(super) fn project_success_reply(id: &str, wire: &str, row: &ProjectRow) -> HandlerAction {
    reply_json(
        id,
        wire,
        json!({ "success": true, "project": project_json(row) }),
    )
}

/// A successful reply that only reports the operation outcome.
pub(super) fn project_success_reply_without_project(id: &str, wire: &str) -> HandlerAction {
    reply_json(id, wire, json!({ "success": true }))
}

/// A deterministic refusal. `kind` is `invalid`, `not_found`, `unauthorized`
/// or `unavailable`; `error` is the user-facing detail.
pub(super) fn project_error_reply(id: &str, wire: &str, kind: &str, error: &str) -> HandlerAction {
    reply_json(
        id,
        wire,
        json!({ "success": false, "error": error, "error_kind": kind }),
    )
}

/// The standard unauthenticated refusal for a Project unit.
pub(super) fn project_unauthenticated_reply(id: &str, wire: &str) -> HandlerAction {
    project_error_reply(id, wire, "unauthorized", "Not authenticated")
}

/// Parse a Project payload, or return the deterministic invalid refusal.
///
/// Kept here rather than in each leaf so every unit answers malformed input the
/// same way, including the same message.
pub(super) fn parse_project_payload<T: serde::de::DeserializeOwned>(
    id: &str,
    wire: &str,
    payload: Value,
) -> Result<T, HandlerAction> {
    serde_json::from_value(payload).map_err(|_| {
        project_error_reply(
            id,
            wire,
            "invalid",
            "Malformed project payload: required fields are missing or have the wrong type",
        )
    })
}

/// A stored-read or stored-write failure: log the cause, never leak it.
pub(super) fn project_unavailable_reply(id: &str, wire: &str, what: &str) -> HandlerAction {
    project_error_reply(id, wire, "unavailable", what)
}
