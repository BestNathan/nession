//! Resolve the Session's Workspace declaration for preflight/Enter (#3407).
//!
//! The client names a *selection* (`auto`, `project_location`, `managed`).
//! Only the Server knows the Session's Project binding and the Project's
//! declared Existing Locations; it resolves the matching location for the
//! target Agent and pins the Project source image that becomes a managed
//! Workspace's EROFS lower. The Agent still re-validates the path at use time
//! and owns the physical Workspace registry.
//!
//! Selection precedence: an explicit managed Workspace outranks the Project
//! Location; `auto` prefers the matching Project Location and otherwise lets
//! the Agent allocate the Session-named managed Workspace. A wrong-Agent path
//! is never a candidate and an explicit selection never falls back silently.

use nession_protocol::contracts::image::v1::normalize_image_digest;
use nession_protocol::contracts::sandbox::v1::{
    SandboxFieldError, SandboxFilesystemWorkspace, SandboxImageRole, SandboxImageSelection,
    SandboxPolicyDraft,
};

/// What the Server adds to the Agent request for one Workspace declaration.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct ResolvedSandboxWorkspace {
    /// The matching Project Existing Location path on the target Agent.
    pub project_location: Option<String>,
    /// The Project source image that the selected managed Workspace's durable
    /// upper was prepared against. Absent when the Project has no source image
    /// or the effective branch is the Project Location.
    pub lower_digest: Option<String>,
}

fn workspace_field_error(code: &str, message: String) -> (String, SandboxFieldError) {
    (
        message.clone(),
        SandboxFieldError {
            field: "filesystem.workspace".to_string(),
            code: code.to_string(),
            message,
        },
    )
}

impl super::ConnectionHandler {
    /// Resolve the Workspace declaration for one target Agent.
    ///
    /// `images` is the already-derived image transport (before the Server adds
    /// a lower). A Workspace declaration without a Base Runtime image is
    /// refused by the declaration deriver before this runs.
    pub(super) async fn resolve_sandbox_workspace(
        &self,
        agent_id: &str,
        session_id: &str,
        policy: &SandboxPolicyDraft,
        images: &[SandboxImageSelection],
    ) -> Result<ResolvedSandboxWorkspace, (String, SandboxFieldError)> {
        let Some(workspace) = policy
            .filesystem
            .as_ref()
            .and_then(|filesystem| filesystem.workspace.as_ref())
        else {
            return Ok(ResolvedSandboxWorkspace::default());
        };
        let explicit_workspace_image = images
            .iter()
            .any(|selection| selection.role == SandboxImageRole::Workspace);

        let binding = self
            .db
            .get_session_project_binding(session_id)
            .await
            .map_err(|error| {
                workspace_field_error(
                    "project-unavailable",
                    format!("the Session's Project binding could not be read: {error:#}"),
                )
            })?;
        let project = match &binding {
            Some(binding) => Some(
                self.db
                    .get_project(&binding.project_id)
                    .await
                    .map_err(|error| {
                        workspace_field_error(
                            "project-unavailable",
                            format!("the Session's Project could not be read: {error:#}"),
                        )
                    })?
                    .ok_or_else(|| {
                        workspace_field_error(
                            "project-unavailable",
                            format!(
                                "the Session's Project '{}' no longer exists",
                                binding.project_id
                            ),
                        )
                    })?,
            ),
            None => None,
        };
        let project_location = project.as_ref().and_then(|project| {
            project
                .locations
                .iter()
                .find(|location| location.agent_id == agent_id)
                .map(|location| location.path.clone())
        });

        match workspace {
            SandboxFilesystemWorkspace::Managed { .. } => {
                if explicit_workspace_image {
                    return Err(workspace_field_error(
                        "workspace-image-conflict",
                        "an explicit workspace image cannot be combined with a managed Workspace selection"
                            .to_string(),
                    ));
                }
                Ok(ResolvedSandboxWorkspace {
                    project_location: None,
                    lower_digest: self.project_source_digest(session_id, &project).await?,
                })
            }
            SandboxFilesystemWorkspace::ProjectLocation => {
                let Some(path) = project_location else {
                    return Err(workspace_field_error(
                        "project-location-missing",
                        match &binding {
                            Some(binding) => format!(
                                "the Session's Project '{}' declares no Existing Location on this Agent; add one for this Agent or choose a managed Workspace",
                                binding.project_id
                            ),
                            None => "this Session is not bound to a Project; a Project Location cannot be selected"
                                .to_string(),
                        },
                    ));
                };
                if explicit_workspace_image {
                    return Err(workspace_field_error(
                        "workspace-image-conflict",
                        "a Project Location cannot be combined with a Project EROFS lower; choose a managed Workspace"
                            .to_string(),
                    ));
                }
                Ok(ResolvedSandboxWorkspace {
                    project_location: Some(path),
                    lower_digest: None,
                })
            }
            SandboxFilesystemWorkspace::Auto => match project_location {
                Some(path) => {
                    if explicit_workspace_image {
                        return Err(workspace_field_error(
                            "workspace-image-conflict",
                            "the automatic Project Location cannot be combined with a Project EROFS lower; choose a managed Workspace"
                                .to_string(),
                        ));
                    }
                    Ok(ResolvedSandboxWorkspace {
                        project_location: Some(path),
                        lower_digest: None,
                    })
                }
                None => Ok(ResolvedSandboxWorkspace {
                    project_location: None,
                    lower_digest: self.project_source_digest(session_id, &project).await?,
                }),
            },
        }
    }

    /// The Project source image pinned for this Session, when one exists.
    ///
    /// A Managed Session's durable context pins the digest it was created
    /// against; otherwise the Project's current source image is used. The
    /// caller still authorizes and readiness-checks the digest through the
    /// normal image-selection path.
    async fn project_source_digest(
        &self,
        session_id: &str,
        project: &Option<crate::db::ProjectRow>,
    ) -> Result<Option<String>, (String, SandboxFieldError)> {
        let Some(project) = project else {
            return Ok(None);
        };
        let managed = self
            .db
            .get_session_managed_context(session_id)
            .await
            .map_err(|error| {
                workspace_field_error(
                    "project-unavailable",
                    format!("the Session's Managed context could not be read: {error:#}"),
                )
            })?;
        let digest = managed
            .filter(|context| context.project_id == project.project_id)
            .map(|context| context.workspace_digest)
            .or_else(|| project.image_digest.clone());
        match digest {
            Some(digest) => normalize_image_digest(&digest).map(Some).map_err(|error| {
                workspace_field_error(
                    "invalid-lower",
                    format!(
                        "the Project source image digest is not valid: {}",
                        error.message()
                    ),
                )
            }),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_field_errors_name_the_workspace_field() {
        let (message, error) = workspace_field_error("project-location-missing", "missing".into());
        assert_eq!(message, "missing");
        assert_eq!(error.field, "filesystem.workspace");
        assert_eq!(error.code, "project-location-missing");
        assert!(!error.message.is_empty());
    }
}
