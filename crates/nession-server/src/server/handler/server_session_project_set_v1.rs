//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{reply_json, ConnectionHandler, HandlerAction, ProtocolMessage};
use crate::db::SessionProjectBindingRow;
use nession_protocol::contracts::project::v1::is_valid_project_id;
use nession_protocol::contracts::session::v1::{
    SessionProjectBindingResponse, SessionProjectBindingUpdatePayload,
};

const WIRE: &str = "server.session.project.set";

fn reply(id: &str, response: SessionProjectBindingResponse) -> HandlerAction {
    reply_json(
        id,
        WIRE,
        serde_json::to_value(&response).unwrap_or(serde_json::json!({
            "success": false,
            "error": "project binding response could not be serialized",
            "error_kind": "unavailable",
        })),
    )
}

fn refusal(id: &str, kind: &str, error: &str) -> HandlerAction {
    reply(
        id,
        SessionProjectBindingResponse {
            success: false,
            project_id: None,
            revision: None,
            error: Some(error.to_string()),
            error_kind: Some(kind.to_string()),
        },
    )
}

impl ConnectionHandler {
    /// `server.session.project.set` — associate, change or remove one Session's
    /// explicit Project membership (#3082 SC-03).
    ///
    /// This is membership metadata only. It never sends an Agent command and
    /// never touches the Session's cwd, ENV binding, mounts, image or process.
    /// The Session must already exist; the Project must exist when one is named.
    /// `expected_revision` is the last revision the caller observed (0 for an
    /// unassociated Session); a mismatch is a deterministic conflict.
    pub(super) async fn handle_client_session_project_set(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(refusal(&msg.id, "unauthorized", "Not authenticated"));
        }
        let Ok(payload) = serde_json::from_value::<SessionProjectBindingUpdatePayload>(msg.payload)
        else {
            return Ok(refusal(
                &msg.id,
                "invalid",
                "session_id is required and project_id may be null",
            ));
        };
        let Some((agent_id, session_name)) = payload.session_id.split_once(':') else {
            return Ok(refusal(&msg.id, "invalid", "session_id is malformed"));
        };
        if agent_id.is_empty() || session_name.is_empty() {
            return Ok(refusal(&msg.id, "invalid", "session_id is malformed"));
        }

        // The Session must be a real live or recoverable Session. A link to a
        // name that no longer exists would be a ghost association.
        let (created_at, incarnation_id) =
            match self.session_registry.get(&payload.session_id).await {
                Some(session) => (session.created_at.timestamp(), session.instance_id),
                None => match self.db.get_session(&payload.session_id).await {
                    Ok(Some(row)) => (row.created_at, row.instance_id),
                    Ok(None) => {
                        return Ok(refusal(&msg.id, "not_found", "Session not found"));
                    }
                    Err(e) => {
                        tracing::error!(
                            "Failed to read session {} for project binding: {e:#}",
                            payload.session_id
                        );
                        return Ok(refusal(&msg.id, "unavailable", "Session could not be read"));
                    }
                },
            };

        if let Some(project_id) = payload.project_id.as_deref() {
            if !is_valid_project_id(project_id) {
                return Ok(refusal(&msg.id, "invalid", "project_id is malformed"));
            }
            match self.db.get_project(project_id).await {
                Ok(Some(_)) => {}
                Ok(None) => {
                    return Ok(refusal(&msg.id, "not_found", "Project not found"));
                }
                Err(e) => {
                    tracing::error!("Failed to read project {project_id} for binding: {e:#}");
                    return Ok(refusal(&msg.id, "unavailable", "Project could not be read"));
                }
            }
        }

        let current = match self
            .db
            .get_session_project_binding(&payload.session_id)
            .await
        {
            Ok(current) => current,
            Err(e) => {
                tracing::error!(
                    "Failed to read project binding for {}: {e:#}",
                    payload.session_id
                );
                return Ok(refusal(
                    &msg.id,
                    "unavailable",
                    "Project membership could not be read",
                ));
            }
        };
        let current_revision = current
            .as_ref()
            .map(|binding| binding.revision)
            .unwrap_or(0);
        if let Some(expected) = payload.expected_revision {
            if expected != current_revision {
                return Ok(refusal(
                    &msg.id,
                    "conflict",
                    &format!(
                        "Project membership changed (expected revision {expected}, current {current_revision})"
                    ),
                ));
            }
        }

        let now = chrono::Utc::now().timestamp();
        match payload.project_id {
            Some(project_id) => {
                let revision = current_revision.saturating_add(1);
                let row = SessionProjectBindingRow {
                    session_id: payload.session_id.clone(),
                    agent_id: agent_id.to_string(),
                    project_id: project_id.clone(),
                    incarnation_id: incarnation_id.clone().unwrap_or_default(),
                    agent_created_at: created_at,
                    revision,
                    updated_at: now,
                };
                match self.db.upsert_session_project_binding(&row).await {
                    Ok(()) => {
                        self.broadcast_sessions().await;
                        Ok(reply(
                            &msg.id,
                            SessionProjectBindingResponse {
                                success: true,
                                project_id: Some(project_id),
                                revision: Some(revision),
                                error: None,
                                error_kind: None,
                            },
                        ))
                    }
                    Err(e) => {
                        tracing::error!(
                            "Failed to set project binding for {}: {e:#}",
                            row.session_id
                        );
                        Ok(refusal(
                            &msg.id,
                            "unavailable",
                            "Project membership could not be saved",
                        ))
                    }
                }
            }
            None => match self
                .db
                .delete_session_project_binding(&payload.session_id)
                .await
            {
                Ok(()) => {
                    self.broadcast_sessions().await;
                    Ok(reply(
                        &msg.id,
                        SessionProjectBindingResponse {
                            success: true,
                            project_id: None,
                            revision: Some(0),
                            error: None,
                            error_kind: None,
                        },
                    ))
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to remove project binding for {}: {e:#}",
                        payload.session_id
                    );
                    Ok(refusal(
                        &msg.id,
                        "unavailable",
                        "Project membership could not be removed",
                    ))
                }
            },
        }
    }
}
