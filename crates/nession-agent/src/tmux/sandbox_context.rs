//! The Session-context Sandbox capability (#3124).
//!
//! The selected **active Pane** is the subject: it is either inside a verified
//! Nession-managed execution, outside it, or unknown. Enter creates a new
//! isolated Pane/Window in the same logical Session, verifies the launch
//! barrier, and only then moves focus. The original Native Pane is never
//! written to, killed or "converted".
//!
//! This module owns the Agent's context discovery and the three focus
//! transitions. Policy validation lives in `nession-sandbox`; tmux process
//! construction stays in `nession-tmux`; Session lifecycle stays in
//! [`SessionManager`](super::manager::SessionManager).

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use nession_protocol::contracts::sandbox::v1::{
    SandboxActionErrorKind, SandboxActionResult, SandboxCapabilityCatalog, SandboxCatalogStatus,
    SandboxContextStatus, SandboxCurrentContext, SandboxExecutionView, SandboxFieldError,
    SandboxFilesystemWorkspace, SandboxImageSelection, SandboxImplementationSupport,
    SandboxNativePane, SandboxPaneRef, SandboxPaneScope, SandboxPolicyDraft,
    SandboxPreflightResult, REGISTERED_IMPLEMENTATION_PATHS, SANDBOX_CATALOG_VERSION,
};
use nession_protocol::contracts::session::v1::{ManagedImageGrant, ManagedImageRole};
use nession_sandbox::{
    draft_from_policy, materialize, materialize_with_composition, preflight_unprepared_composition,
    requested_mechanisms, ExecutionRecord, LaunchRequest, SandboxError,
};
use nession_tmux::ops::PaneSummary;

use super::manager::{passwd_login_shell, resolve_session_shell, SessionManager};

/// The operation ids, for the Agent's command-response.
pub const CONTEXT_COMMAND: &str = "agent.session.sandbox.context";
pub const PREFLIGHT_COMMAND: &str = "agent.session.sandbox.preflight";
pub const ENTER_COMMAND: &str = "agent.session.sandbox.enter";
pub const RETURN_COMMAND: &str = "agent.session.sandbox.return-to-native";
pub const FOCUS_COMMAND: &str = "agent.session.sandbox.focus";

/// One explicit Enter request, grouped so the Agent's lifecycle call stays
/// readable as the image composition added its grants.
pub struct SandboxEnterInput<'a> {
    pub session_name: &'a str,
    pub generation: &'a str,
    pub probe_generation: &'a str,
    pub enter_id: &'a str,
    pub draft: &'a SandboxPolicyDraft,
    pub images: &'a [ManagedImageGrant],
    /// The Server-resolved Project Existing Location on this Agent (#3407).
    /// Present only when the effective Workspace branch is the Project
    /// Location; an explicit managed selection ignores it.
    pub project_location: Option<&'a str>,
    pub server_url: &'a str,
    pub working_dir: &'a str,
}

/// One explicit preflight request (#3124, Workspace resolution #3407).
pub struct SandboxPreflightInput<'a> {
    pub session_name: &'a str,
    pub generation: &'a str,
    pub probe_generation: &'a str,
    pub draft: &'a SandboxPolicyDraft,
    pub images: &'a [SandboxImageSelection],
    pub project_location: Option<&'a str>,
    pub working_dir: &'a str,
}

impl SessionManager {
    /// Observe the selected Session's active Pane and its Sandbox context.
    ///
    /// A tmux query failure is an error, not `Unknown`: the caller (the
    /// Server) turns it into a truthful offline/unavailable answer. `Unknown`
    /// is reserved for a Session whose Pane identity cannot be proven.
    pub async fn sandbox_context(&self, session_name: &str) -> Result<SandboxCurrentContext> {
        let ops = self.tmux_dep().ops();
        let panes = ops
            .list_panes()
            .await
            .context("list the Session's Panes for the Sandbox context")?;
        let Some(pane) = active_pane_of(&panes, session_name) else {
            return Ok(unknown_context(
                session_name,
                "the Session has no observable active Pane",
                self.sandbox_catalog(),
            ));
        };

        let instance_id = match self.session_instance_id(session_name).await {
            Ok(instance_id) => Some(instance_id),
            Err(error) => {
                tracing::warn!(
                    "could not read the instance identity of session {session_name}: {error:#}"
                );
                None
            }
        };

        let catalog = self.sandbox_catalog();
        let Some(runtime) = self.sandbox_runtime() else {
            return Ok(outside_context(
                session_name,
                &pane,
                instance_id,
                catalog,
                Some("this Agent has no Sandbox runtime configured".to_string()),
                Vec::new(),
            ));
        };

        let tracked = runtime
            .execution_for_pane(session_name, &pane.pane_id)
            .or_else(|| runtime.legacy_execution_for_pane(session_name, pane.pane_pid));

        let Some(record) = tracked else {
            return Ok(outside_context(
                session_name,
                &pane,
                instance_id,
                catalog,
                None,
                sandbox_pane_refs(runtime, session_name),
            ));
        };

        // A verified record belongs to one Session incarnation. A same-named
        // recreation must never inherit it.
        if instance_id.as_deref() != Some(record.instance_id.as_str()) {
            return Ok(outside_context(
                session_name,
                &pane,
                instance_id,
                catalog,
                Some(
                    "the Session's instance identity changed; the tracked execution \
                     belongs to an earlier Session and is not this Pane's"
                        .to_string(),
                ),
                sandbox_pane_refs(runtime, session_name),
            ));
        }

        Ok(inside_context(
            session_name,
            &pane,
            instance_id,
            catalog,
            record,
            sandbox_pane_refs(runtime, session_name),
        ))
    }

    /// Validate one draft against the exact context revision, without creating
    /// any host resource.
    pub async fn sandbox_preflight(
        &self,
        input: SandboxPreflightInput<'_>,
    ) -> SandboxPreflightResult {
        let SandboxPreflightInput {
            session_name,
            generation,
            probe_generation,
            draft,
            images,
            project_location,
            working_dir,
        } = input;
        let context = match self.sandbox_context(session_name).await {
            Ok(context) => context,
            Err(error) => {
                return SandboxPreflightResult {
                    ok: false,
                    error: Some(format!("{error:#}")),
                    generation: generation.to_string(),
                    policy_digest: None,
                    backend: None,
                    mechanisms: Vec::new(),
                    errors: Vec::new(),
                    warnings: Vec::new(),
                    catalog: unavailable_catalog(format!("{error:#}")),
                };
            }
        };
        let catalog = context.catalog.clone();
        let stale_field = |field: &str, message: &str| SandboxPreflightResult {
            ok: false,
            error: Some(message.to_string()),
            generation: context.generation.clone(),
            policy_digest: None,
            backend: None,
            mechanisms: Vec::new(),
            errors: vec![SandboxFieldError {
                field: field.to_string(),
                code: "stale-generation".to_string(),
                message: message.to_string(),
            }],
            warnings: Vec::new(),
            catalog: catalog.clone(),
        };
        let refuse = |error: String, code: &str| SandboxPreflightResult {
            ok: false,
            error: Some(error.clone()),
            generation: context.generation.clone(),
            policy_digest: None,
            backend: None,
            mechanisms: Vec::new(),
            errors: vec![SandboxFieldError {
                field: "context".to_string(),
                code: code.to_string(),
                message: error,
            }],
            warnings: Vec::new(),
            catalog: catalog.clone(),
        };
        let field_refusal = |field: &str, code: &str, message: &str| SandboxPreflightResult {
            ok: false,
            error: Some(message.to_string()),
            generation: context.generation.clone(),
            policy_digest: None,
            backend: None,
            mechanisms: Vec::new(),
            errors: vec![SandboxFieldError {
                field: field.to_string(),
                code: code.to_string(),
                message: message.to_string(),
            }],
            warnings: Vec::new(),
            catalog: catalog.clone(),
        };

        if context.generation != generation {
            return refuse(
                "the Sandbox context changed since the draft was composed; re-read it".to_string(),
                "stale-generation",
            );
        }
        if context.catalog.probe_generation != probe_generation {
            return stale_field(
                "catalog.probe_generation",
                "the Agent's measured Sandbox capability changed since the draft was composed; re-read the context and run preflight again",
            );
        }
        if context.status == SandboxContextStatus::Inside {
            return refuse(
                "the active Pane is already inside a managed Sandbox".to_string(),
                "already-inside",
            );
        }
        if !context.enterable {
            return refuse(
                context
                    .reason
                    .clone()
                    .unwrap_or_else(|| "this Agent cannot enter a Sandbox from here".to_string()),
                "not-enterable",
            );
        }
        let Some(runtime) = self.sandbox_runtime() else {
            return refuse(
                "this Agent has no Sandbox runtime configured".to_string(),
                "not-enterable",
            );
        };
        let selected_workspace = draft
            .filesystem
            .as_ref()
            .and_then(|filesystem| filesystem.workspace.as_ref());
        if matches!(
            selected_workspace,
            Some(SandboxFilesystemWorkspace::ProjectLocation)
        ) && project_location.is_none()
        {
            return field_refusal(
                "filesystem.workspace",
                "project-location-missing",
                "this Session's Project declares no Existing Location on this Agent; add one for this Agent or choose a managed Workspace",
            );
        }
        // A managed selection outranks a Project Location; only an effective
        // Project Location branch carries the Server-resolved path.
        let project_location = match selected_workspace {
            Some(SandboxFilesystemWorkspace::ProjectLocation)
            | Some(SandboxFilesystemWorkspace::Auto) => project_location,
            _ => None,
        };
        let cache = runtime.erofs_cache();
        let composition = if images.is_empty() {
            None
        } else {
            let Some(cache) = cache.as_ref() else {
                return refuse(
                    "this Agent has no EROFS cache configured; it cannot prepare a Sandbox image composition"
                        .to_string(),
                    "not-enterable",
                );
            };
            match crate::sandbox_images::preflight_composition(cache, images, project_location) {
                Ok(composition) => Some(composition),
                Err(error) => {
                    return SandboxPreflightResult {
                        ok: false,
                        error: None,
                        generation: context.generation.clone(),
                        policy_digest: None,
                        backend: None,
                        mechanisms: Vec::new(),
                        errors: vec![SandboxFieldError {
                            field: "images".to_string(),
                            code: "invalid-composition".to_string(),
                            message: format!("{error:#}"),
                        }],
                        warnings: Vec::new(),
                        catalog,
                    };
                }
            }
        };
        let policy = match composition {
            Some(composition) => materialize_with_composition(draft, composition),
            None => materialize(draft),
        };
        let policy = match policy {
            Ok(policy) => policy,
            Err(errors) => {
                return SandboxPreflightResult {
                    ok: false,
                    error: None,
                    generation: context.generation.clone(),
                    policy_digest: None,
                    backend: None,
                    mechanisms: Vec::new(),
                    errors,
                    warnings: Vec::new(),
                    catalog,
                };
            }
        };
        let instance_id = match context.scope.session_instance_id.clone() {
            Some(instance_id) => instance_id,
            None => {
                return refuse(
                    "the Session instance identity could not be proven".to_string(),
                    "not-enterable",
                )
            }
        };
        let working_dir = match self
            .resolve_enter_working_dir(session_name, &context, working_dir)
            .await
        {
            Ok(working_dir) => working_dir,
            Err(error) => return refuse(error, "invalid-working-dir"),
        };
        let request = LaunchRequest {
            policy,
            session_name: session_name.to_string(),
            instance_id,
            working_dir,
            inner_command: vec!["<preflight>".to_string()],
            tmux_socket: Some(self.socket_path().to_path_buf()),
        };
        let settings = runtime.settings().clone();
        let images_selected = !images.is_empty();
        let preflight = tokio::task::spawn_blocking(move || {
            if images_selected {
                preflight_unprepared_composition(&request, &settings)
            } else {
                nession_sandbox::preflight(&request, &settings)
            }
        })
        .await;
        match preflight {
            Ok(Ok(report)) => {
                let mut mechanisms = requested_mechanisms(&report.compiled);
                if report.capabilities.backend == Some("linux-bwrap") {
                    mechanisms.push("backend.baseline_namespaces".to_string());
                }
                SandboxPreflightResult {
                    ok: true,
                    error: None,
                    generation: context.generation.clone(),
                    policy_digest: Some(report.compiled.digest.clone()),
                    backend: report.capabilities.backend.map(str::to_string),
                    mechanisms,
                    errors: Vec::new(),
                    warnings: report.warnings,
                    catalog,
                }
            }
            Ok(Err(SandboxError::UnsupportedRequests(field_errors))) => SandboxPreflightResult {
                ok: false,
                error: Some(
                    "the host cannot install one or more explicitly requested policy elements"
                        .to_string(),
                ),
                generation: context.generation.clone(),
                policy_digest: None,
                backend: None,
                mechanisms: Vec::new(),
                errors: field_errors,
                warnings: Vec::new(),
                catalog,
            },
            Ok(Err(error)) => {
                let code = preflight_error_code(&error);
                SandboxPreflightResult {
                    ok: false,
                    error: Some(error.to_string()),
                    generation: context.generation.clone(),
                    policy_digest: None,
                    backend: None,
                    mechanisms: Vec::new(),
                    errors: vec![SandboxFieldError {
                        field: "policy".to_string(),
                        code: code.to_string(),
                        message: error.to_string(),
                    }],
                    warnings: Vec::new(),
                    catalog,
                }
            }
            Err(error) => refuse(format!("the preflight task failed: {error}"), "unavailable"),
        }
    }

    /// The one explicit Enter: allocate an isolated Pane in the same logical
    /// Session, verify the barrier, then focus it.
    pub async fn sandbox_enter(&self, input: SandboxEnterInput<'_>) -> SandboxActionResult {
        let SandboxEnterInput {
            session_name,
            generation,
            probe_generation,
            enter_id,
            draft,
            images,
            project_location,
            server_url,
            working_dir,
        } = input;
        let Some(runtime) = self.sandbox_runtime().cloned() else {
            return action_refusal(
                SandboxActionErrorKind::Unavailable,
                "this Agent has no Sandbox runtime configured",
                None,
                None,
            );
        };
        // A duplicate delivery of the same attempt replays its outcome
        // instead of launching a second Pane.
        if let Some(previous) = runtime.recent_enter(enter_id) {
            return previous;
        }

        let context = match self.sandbox_context(session_name).await {
            Ok(context) => context,
            Err(error) => {
                return action_refusal(
                    SandboxActionErrorKind::Unavailable,
                    format!("the Sandbox context could not be read: {error:#}"),
                    None,
                    None,
                )
            }
        };
        let refusal = |kind, error: String, field_errors: Option<Vec<SandboxFieldError>>| {
            let result = action_refusal(kind, error, field_errors, Some(context.clone()));
            runtime.remember_enter(enter_id, result.clone());
            result
        };

        if context.status == SandboxContextStatus::Inside {
            return refusal(
                SandboxActionErrorKind::Conflict,
                "the active Pane is already inside a managed Sandbox".to_string(),
                None,
            );
        }
        if context.generation != generation {
            return refusal(
                SandboxActionErrorKind::Conflict,
                "the Sandbox context changed since preflight; re-run it".to_string(),
                None,
            );
        }
        if context.catalog.probe_generation != probe_generation {
            return refusal(
                SandboxActionErrorKind::Conflict,
                "the Agent's measured Sandbox capability changed since preflight; run it again"
                    .to_string(),
                Some(vec![SandboxFieldError {
                    field: "catalog.probe_generation".to_string(),
                    code: "stale-generation".to_string(),
                    message: "the host capability changed between preflight and Enter".to_string(),
                }]),
            );
        }
        if !context.enterable {
            return refusal(
                SandboxActionErrorKind::Unavailable,
                context
                    .reason
                    .clone()
                    .unwrap_or_else(|| "this Agent cannot enter a Sandbox from here".to_string()),
                None,
            );
        }
        let Some(pane_id) = context.scope.pane_id.clone() else {
            return refusal(
                SandboxActionErrorKind::Unavailable,
                "the active Pane identity could not be read".to_string(),
                None,
            );
        };
        let Some(window_id) = context.scope.window_id.clone() else {
            return refusal(
                SandboxActionErrorKind::Unavailable,
                "the active Window identity could not be read".to_string(),
                None,
            );
        };
        let Some(instance_id) = context.scope.session_instance_id.clone() else {
            return refusal(
                SandboxActionErrorKind::Unavailable,
                "the Session instance identity could not be proven".to_string(),
                None,
            );
        };
        // Selection precedence (#3407 SC-02): an explicit managed Workspace
        // outranks the Project Location; otherwise a matching Project Existing
        // Location is selected; otherwise the Session-name managed Workspace
        // is allocated. An explicit Project Location without a matching
        // declaration fails closed; it never falls back silently.
        let lower_digest = images
            .iter()
            .find(|grant| grant.role == ManagedImageRole::Workspace)
            .map(|grant| grant.digest.as_str());
        let selected_workspace = draft
            .filesystem
            .as_ref()
            .and_then(|filesystem| filesystem.workspace.as_ref());
        let workspace_override = match selected_workspace {
            None => None,
            Some(SandboxFilesystemWorkspace::Managed { workspace_id, name }) => {
                let Some(manager) = self.workspaces() else {
                    return refusal(
                        SandboxActionErrorKind::Unavailable,
                        "this Agent has no Workspace registry configured".to_string(),
                        None,
                    );
                };
                match resolve_managed_workspace(
                    manager,
                    ManagedWorkspaceRequest {
                        workspace_id: workspace_id.as_deref(),
                        name: name.as_deref(),
                        session_name,
                        lower_digest,
                    },
                )
                .await
                {
                    Ok(workspace) => Some(workspace),
                    Err(error) => {
                        return refusal(
                            SandboxActionErrorKind::Unavailable,
                            format!("cannot resolve the selected Workspace: {error:#}"),
                            Some(vec![SandboxFieldError {
                                field: "filesystem.workspace".to_string(),
                                code: "unavailable".to_string(),
                                message: format!("{error:#}"),
                            }]),
                        )
                    }
                }
            }
            Some(SandboxFilesystemWorkspace::ProjectLocation) => {
                match resolve_project_location(project_location, lower_digest) {
                    Ok(path) => Some(
                        crate::sandbox_images::SandboxWorkspaceOverride::ProjectLocation { path },
                    ),
                    Err(error) => {
                        return refusal(
                            SandboxActionErrorKind::Invalid,
                            format!("{error:#}"),
                            Some(vec![SandboxFieldError {
                                field: "filesystem.workspace".to_string(),
                                code: "project-location".to_string(),
                                message: "the Project Location is not usable for this Enter"
                                    .to_string(),
                            }]),
                        )
                    }
                }
            }
            Some(SandboxFilesystemWorkspace::Auto) => {
                if let Some(path) = project_location {
                    match resolve_project_location(Some(path), lower_digest) {
                        Ok(path) => Some(
                            crate::sandbox_images::SandboxWorkspaceOverride::ProjectLocation {
                                path,
                            },
                        ),
                        Err(error) => {
                            return refusal(
                                SandboxActionErrorKind::Invalid,
                                format!("{error:#}"),
                                Some(vec![SandboxFieldError {
                                    field: "filesystem.workspace".to_string(),
                                    code: "project-location".to_string(),
                                    message: "the Project Location is not usable for this Enter"
                                        .to_string(),
                                }]),
                            )
                        }
                    }
                } else {
                    let Some(manager) = self.workspaces() else {
                        return refusal(
                            SandboxActionErrorKind::Unavailable,
                            "this Agent has no Workspace registry configured".to_string(),
                            None,
                        );
                    };
                    match resolve_managed_workspace(
                        manager,
                        ManagedWorkspaceRequest {
                            workspace_id: None,
                            name: None,
                            session_name,
                            lower_digest,
                        },
                    )
                    .await
                    {
                        Ok(workspace) => Some(workspace),
                        Err(error) => {
                            return refusal(
                                SandboxActionErrorKind::Unavailable,
                                format!("cannot resolve the automatic Workspace: {error:#}"),
                                Some(vec![SandboxFieldError {
                                    field: "filesystem.workspace".to_string(),
                                    code: "unavailable".to_string(),
                                    message: format!("{error:#}"),
                                }]),
                            )
                        }
                    }
                }
            }
        };
        if images.is_empty() && workspace_override.is_some() {
            return refusal(
                SandboxActionErrorKind::Invalid,
                "a Workspace selection requires an image RootFS".to_string(),
                Some(vec![SandboxFieldError {
                    field: "filesystem.workspace".to_string(),
                    code: "unsupported".to_string(),
                    message: "select a Base Runtime image for a Workspace-backed Sandbox"
                        .to_string(),
                }]),
            );
        }
        let mut prepared_images = if images.is_empty() {
            None
        } else {
            let Some(cache) = runtime.erofs_cache() else {
                return refusal(
                    SandboxActionErrorKind::Unavailable,
                    "this Agent has no EROFS cache configured; it cannot prepare a Sandbox image composition"
                        .to_string(),
                    None,
                );
            };
            match crate::sandbox_images::prepare(
                &cache,
                images,
                server_url,
                &runtime.settings().state_dir,
                workspace_override,
            )
            .await
            {
                Ok(prepared) => Some(prepared),
                Err(error) => {
                    return refusal(
                        SandboxActionErrorKind::Failed,
                        format!("cannot prepare the Sandbox image composition: {error:#}"),
                        None,
                    )
                }
            }
        };
        let policy = match prepared_images.as_ref() {
            Some(prepared) => materialize_with_composition(draft, prepared.composition.clone()),
            None => materialize(draft),
        };
        let policy = match policy {
            Ok(policy) => policy,
            Err(errors) => {
                return refusal(
                    SandboxActionErrorKind::Invalid,
                    "the draft is not a valid Sandbox policy".to_string(),
                    Some(errors),
                )
            }
        };
        let working_dir = match self
            .resolve_enter_working_dir(session_name, &context, working_dir)
            .await
        {
            Ok(working_dir) => working_dir,
            Err(error) => {
                return refusal(
                    SandboxActionErrorKind::Invalid,
                    error,
                    Some(vec![SandboxFieldError {
                        field: "working_dir".to_string(),
                        code: "invalid-working-dir".to_string(),
                        message: "the working directory is not usable for Enter".to_string(),
                    }]),
                )
            }
        };
        let Some(shell) = self.resolve_enter_shell().await else {
            return refusal(
                SandboxActionErrorKind::Unavailable,
                "no interactive shell could be resolved for the Sandbox Pane".to_string(),
                None,
            );
        };

        let request = LaunchRequest {
            policy,
            session_name: session_name.to_string(),
            instance_id,
            working_dir,
            inner_command: vec![shell, "-l".to_string()],
            tmux_socket: Some(self.socket_path().to_path_buf()),
        };
        let prepare_runtime = runtime.clone();
        let prepared = tokio::task::spawn_blocking(move || prepare_runtime.prepare(&request)).await;
        let mut prepared = match prepared {
            Ok(Ok(prepared)) => prepared,
            Ok(Err(error)) => {
                let (kind, field_errors) = match error.downcast_ref::<SandboxError>() {
                    Some(SandboxError::UnsupportedRequests(field_errors)) => (
                        SandboxActionErrorKind::Unavailable,
                        Some(field_errors.clone()),
                    ),
                    Some(SandboxError::InvalidPolicy(_)) => (SandboxActionErrorKind::Invalid, None),
                    Some(SandboxError::UnsupportedPolicy(_))
                    | Some(SandboxError::BackendUnavailable(_)) => {
                        (SandboxActionErrorKind::Unavailable, None)
                    }
                    _ => (SandboxActionErrorKind::Failed, None),
                };
                return refusal(kind, format!("{error:#}"), field_errors);
            }
            Err(error) => {
                return refusal(
                    SandboxActionErrorKind::Failed,
                    format!("the Sandbox preparation task failed: {error}"),
                    None,
                )
            }
        };
        if let Some(prepared_images) = prepared_images.as_mut() {
            // The execution record now owns the writable composition workspace;
            // its bounded cleanup removes it with the execution.
            prepared_images.workspace_guard.disarm();
        }
        prepared.set_native_pane(&window_id, &pane_id);

        let ops = self.tmux_dep().ops();
        let created = ops
            .new_window(&nession_tmux::NewWindow {
                session_name: session_name.to_string(),
                name: "sandbox".to_string(),
                working_dir: prepared.record().working_dir.clone(),
                env: prepared.env().to_vec(),
                command: prepared.command().to_vec(),
            })
            .await;
        let created = match created {
            Ok(created) => created,
            Err(error) => {
                if let Err(abort) = prepared.abort() {
                    tracing::warn!(
                        "could not release the prepared Sandbox after window failure: {abort}"
                    );
                }
                runtime.forget_catalog();
                return refusal(
                    SandboxActionErrorKind::Failed,
                    format!("the isolated Pane could not be created: {error:#}"),
                    None,
                );
            }
        };
        let Some(pane_pid) = created.pane_pid else {
            self.rollback_sandbox_window(&created.window_id, prepared)
                .await;
            return refusal(
                SandboxActionErrorKind::Failed,
                "the isolated Pane has no root process to verify".to_string(),
                None,
            );
        };

        let target = crate::sandbox_runtime::PaneLaunchTarget {
            pane_pid,
            pane_id: Some(created.pane_id.clone()),
            window_id: Some(created.window_id.clone()),
        };
        let verify_runtime = runtime.clone();
        let verify_session = session_name.to_string();
        let workspace_lease = prepared_images
            .as_mut()
            .and_then(|prepared_images| prepared_images.workspace_lease.take());
        let verified = tokio::task::spawn_blocking(move || {
            crate::sandbox_runtime::launch_and_verify(
                &verify_runtime,
                prepared,
                target,
                &verify_session,
                workspace_lease,
            )
        })
        .await;
        match verified {
            Ok(Ok(_report)) => {}
            Ok(Err(error)) => {
                // The execution barrier refused it: remove exactly the Window
                // this Enter created. The Native Pane was never touched.
                if let Err(kill) = ops.kill_window(&created.window_id).await {
                    tracing::warn!(
                        "could not remove the unverified Sandbox Window {}: {kill:#}",
                        created.window_id
                    );
                }
                return refusal(SandboxActionErrorKind::Failed, format!("{error:#}"), None);
            }
            Err(error) => {
                if let Err(kill) = ops.kill_window(&created.window_id).await {
                    tracing::warn!(
                        "could not remove the unverified Sandbox Window {}: {kill:#}",
                        created.window_id
                    );
                }
                return refusal(
                    SandboxActionErrorKind::Failed,
                    format!("the Sandbox verification task failed: {error}"),
                    None,
                );
            }
        }

        // Verification released the barrier; only now may focus move.
        if let Err(error) = ops.select_window(&created.window_id).await {
            let result = action_refusal(
                SandboxActionErrorKind::Failed,
                format!("the Sandbox Pane was verified but could not be focused: {error:#}"),
                None,
                self.sandbox_context(session_name).await.ok(),
            );
            runtime.remember_enter(enter_id, result.clone());
            return result;
        }
        if let Err(error) = ops.select_pane(&created.pane_id).await {
            tracing::warn!("the Sandbox Window was selected but its Pane was not: {error:#}");
        }

        let after = self.sandbox_context(session_name).await.ok();
        let result = SandboxActionResult {
            success: true,
            error_kind: None,
            error: None,
            field_errors: None,
            context: after,
        };
        runtime.remember_enter(enter_id, result.clone());
        result
    }

    /// Focus the preserved Native Pane. This is a focus switch, not a
    /// teardown: the Sandbox Pane and its isolation keep running.
    pub async fn sandbox_return_to_native(&self, session_name: &str) -> SandboxActionResult {
        let Some(runtime) = self.sandbox_runtime().cloned() else {
            return action_refusal(
                SandboxActionErrorKind::Unavailable,
                "this Agent has no Sandbox runtime configured",
                None,
                None,
            );
        };
        let context = match self.sandbox_context(session_name).await {
            Ok(context) => context,
            Err(error) => {
                return action_refusal(
                    SandboxActionErrorKind::Unavailable,
                    format!("the Sandbox context could not be read: {error:#}"),
                    None,
                    None,
                )
            }
        };
        if context.status != SandboxContextStatus::Inside {
            return action_refusal(
                SandboxActionErrorKind::Conflict,
                "the active Pane is not inside a managed Sandbox".to_string(),
                None,
                Some(context),
            );
        }
        let Some(record) = context
            .scope
            .pane_id
            .as_deref()
            .and_then(|pane_id| runtime.execution_for_pane(session_name, pane_id))
        else {
            return action_refusal(
                SandboxActionErrorKind::Conflict,
                "the active Pane's execution record could not be identified".to_string(),
                None,
                Some(context),
            );
        };
        let (Some(native_window), Some(native_pane)) = (
            record.native_window_id.clone(),
            record.native_pane_id.clone(),
        ) else {
            return action_refusal(
                SandboxActionErrorKind::Unavailable,
                "this execution has no preserved Native Pane to return to".to_string(),
                None,
                Some(context),
            );
        };

        let ops = self.tmux_dep().ops();
        let panes = match ops.list_panes().await {
            Ok(panes) => panes,
            Err(error) => {
                return action_refusal(
                    SandboxActionErrorKind::Unavailable,
                    format!("the Native Pane could not be located: {error:#}"),
                    None,
                    Some(context),
                )
            }
        };
        if !panes.iter().any(|pane| {
            pane.session_name == session_name
                && pane.window_id == native_window
                && pane.pane_id == native_pane
        }) {
            return action_refusal(
                SandboxActionErrorKind::Unavailable,
                "the preserved Native Pane no longer exists".to_string(),
                None,
                Some(context),
            );
        }
        if let Err(error) = ops
            .select_window(&native_window)
            .await
            .and(ops.select_pane(&native_pane).await)
        {
            return action_refusal(
                SandboxActionErrorKind::Failed,
                format!("the Native Pane could not be focused: {error:#}"),
                None,
                Some(context),
            );
        }
        let after = self.sandbox_context(session_name).await.ok();
        SandboxActionResult {
            success: true,
            error_kind: None,
            error: None,
            field_errors: None,
            context: after,
        }
    }

    /// Focus one existing, tracked Sandbox Pane without entering a new one.
    pub async fn sandbox_focus(&self, session_name: &str, pane_id: &str) -> SandboxActionResult {
        let Some(runtime) = self.sandbox_runtime().cloned() else {
            return action_refusal(
                SandboxActionErrorKind::Unavailable,
                "this Agent has no Sandbox runtime configured",
                None,
                None,
            );
        };
        if runtime.execution_for_pane(session_name, pane_id).is_none() {
            return action_refusal(
                SandboxActionErrorKind::Conflict,
                "that Pane is not a tracked Sandbox Pane of this Session".to_string(),
                None,
                self.sandbox_context(session_name).await.ok(),
            );
        }
        let ops = self.tmux_dep().ops();
        let panes = match ops.list_panes().await {
            Ok(panes) => panes,
            Err(error) => {
                return action_refusal(
                    SandboxActionErrorKind::Unavailable,
                    format!("the Sandbox Pane could not be located: {error:#}"),
                    None,
                    None,
                )
            }
        };
        let Some(pane) = panes
            .iter()
            .find(|pane| pane.session_name == session_name && pane.pane_id == pane_id)
        else {
            return action_refusal(
                SandboxActionErrorKind::Unavailable,
                "the Sandbox Pane no longer exists".to_string(),
                None,
                self.sandbox_context(session_name).await.ok(),
            );
        };
        if let Err(error) = ops
            .select_window(&pane.window_id)
            .await
            .and(ops.select_pane(&pane.pane_id).await)
        {
            return action_refusal(
                SandboxActionErrorKind::Failed,
                format!("the Sandbox Pane could not be focused: {error:#}"),
                None,
                self.sandbox_context(session_name).await.ok(),
            );
        }
        SandboxActionResult {
            success: true,
            error_kind: None,
            error: None,
            field_errors: None,
            context: self.sandbox_context(session_name).await.ok(),
        }
    }

    /// The measured host catalog, or a truthful unavailable catalog.
    fn sandbox_catalog(&self) -> SandboxCapabilityCatalog {
        match self.sandbox_runtime() {
            Some(runtime) => runtime.catalog(),
            None => unavailable_catalog("this Agent has no Sandbox runtime configured".to_string()),
        }
    }

    async fn resolve_enter_working_dir(
        &self,
        session_name: &str,
        context: &SandboxCurrentContext,
        requested: &str,
    ) -> std::result::Result<String, String> {
        if !requested.trim().is_empty() {
            if !requested.starts_with('/') {
                return Err("the working directory must be absolute".to_string());
            }
            return Ok(requested.trim().to_string());
        }
        if let Some(working_dir) = context.scope.working_dir.clone() {
            return Ok(working_dir);
        }
        self.get_session_cwd(session_name)
            .await
            .map_err(|error| format!("the Pane's working directory could not be read: {error:#}"))
    }

    async fn resolve_enter_shell(&self) -> Option<String> {
        let tmux_default = self.tmux_dep().ops().default_shell().await.ok().flatten();
        resolve_session_shell(
            tmux_default,
            std::env::var("SHELL").ok(),
            passwd_login_shell(),
        )
    }

    async fn rollback_sandbox_window<P>(&self, window_id: &str, prepared: P) {
        if let Err(error) = self.tmux_dep().ops().kill_window(window_id).await {
            tracing::warn!("could not remove the unverified Sandbox Window {window_id}: {error:#}");
        }
        drop(prepared);
    }
}

/// One managed Workspace resolution request (#3407).
struct ManagedWorkspaceRequest<'a> {
    workspace_id: Option<&'a str>,
    name: Option<&'a str>,
    session_name: &'a str,
    lower_digest: Option<&'a str>,
}

/// Resolve one managed Workspace, acquire its RW lease and pin the Project
/// EROFS lower its durable upper belongs to.
///
/// An explicit stable id is leased directly; an explicit name is reused or
/// created in the default namespace; `auto` uses the Session name. The caller
/// holds the lease until the execution is cleaned up.
async fn resolve_managed_workspace(
    manager: &std::sync::Arc<crate::workspace_manager::WorkspaceManager>,
    request: ManagedWorkspaceRequest<'_>,
) -> Result<crate::sandbox_images::SandboxWorkspaceOverride> {
    let ManagedWorkspaceRequest {
        workspace_id,
        name,
        session_name,
        lower_digest,
    } = request;
    let workspace_id = match (workspace_id, name) {
        (Some(workspace_id), None) => workspace_id.to_string(),
        (None, Some(name)) => {
            manager
                .get_or_create(Some("default"), name, false)
                .await?
                .workspace_id
        }
        (None, None) => {
            manager
                .get_or_create(Some("default"), session_name, true)
                .await?
                .workspace_id
        }
        (Some(_), Some(_)) => {
            anyhow::bail!("a managed Workspace needs exactly one of workspace_id or name")
        }
    };
    let path = manager.workspace_directory(&workspace_id)?;
    let lease = manager.lease(&workspace_id).await?;
    // A changed/missing lower on a Workspace whose durable upper was prepared
    // against a Project image is refused before any host resource is created.
    manager
        .pin_lower_digest(&workspace_id, lower_digest)
        .await?;
    Ok(crate::sandbox_images::SandboxWorkspaceOverride::Managed { path, lease })
}

/// Validate the Server-resolved Project Existing Location at use time.
///
/// The path is external and user-owned: it must exist on this Agent as a real
/// directory and is never created, canonicalized behind a symlink, or deleted.
/// A Project Location cannot carry a Project EROFS lower because the Overlay
/// would have to keep upper/work inside the user's directory.
fn resolve_project_location(path: Option<&str>, lower_digest: Option<&str>) -> Result<PathBuf> {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
        anyhow::bail!(
            "this Session's Project declares no Existing Location on this Agent; add one for this Agent or choose a managed Workspace"
        );
    };
    if lower_digest.is_some() {
        anyhow::bail!(
            "a Project Location cannot be combined with a Project EROFS lower; choose a managed Workspace"
        );
    }
    let declared = Path::new(path);
    if !declared.is_absolute() {
        anyhow::bail!("the Project Location `{path}` must be an absolute path");
    }
    let metadata = std::fs::symlink_metadata(declared).map_err(|error| {
        anyhow::anyhow!(
            "the Project Location {} is not available on this Agent: {error}",
            declared.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        anyhow::bail!(
            "the Project Location {} must be a real directory",
            declared.display()
        );
    }
    let canonical = std::fs::canonicalize(declared).map_err(|error| {
        anyhow::anyhow!(
            "the Project Location {} cannot be resolved: {error}",
            declared.display()
        )
    })?;
    if canonical != declared {
        anyhow::bail!(
            "the Project Location {} resolves to {}; declare the canonical path",
            declared.display(),
            canonical.display()
        );
    }
    Ok(canonical)
}

/// The Session's active Pane: the one row tmux marks as both the current
/// Window and that Window's active Pane.
fn active_pane_of(panes: &[PaneSummary], session_name: &str) -> Option<PaneSummary> {
    panes
        .iter()
        .find(|pane| pane.session_name == session_name && pane.window_active && pane.pane_active)
        .cloned()
}

fn scope_of(
    session_name: &str,
    pane: &PaneSummary,
    instance_id: Option<String>,
) -> SandboxPaneScope {
    SandboxPaneScope {
        session_name: session_name.to_string(),
        session_instance_id: instance_id,
        pane_id: Some(pane.pane_id.clone()),
        window_id: Some(pane.window_id.clone()),
        pane_pid: pane.pane_pid,
        working_dir: None,
    }
}

fn unknown_context(
    session_name: &str,
    reason: &str,
    catalog: SandboxCapabilityCatalog,
) -> SandboxCurrentContext {
    let scope = SandboxPaneScope {
        session_name: session_name.to_string(),
        ..SandboxPaneScope::default()
    };
    SandboxCurrentContext {
        status: SandboxContextStatus::Unknown,
        reason: Some(reason.to_string()),
        generation: generation(&scope, SandboxContextStatus::Unknown, None, &catalog),
        scope,
        execution: None,
        effective_policy: None,
        native_pane: None,
        enterable: false,
        sandbox_panes: Vec::new(),
        catalog,
    }
}

fn outside_context(
    session_name: &str,
    pane: &PaneSummary,
    instance_id: Option<String>,
    catalog: SandboxCapabilityCatalog,
    reason: Option<String>,
    sandbox_panes: Vec<SandboxPaneRef>,
) -> SandboxCurrentContext {
    let scope = scope_of(session_name, pane, instance_id);
    let enterable = scope.session_instance_id.is_some()
        && catalog.backend.is_some()
        && catalog.status == SandboxCatalogStatus::Available;
    let reason = reason.or_else(|| {
        if !enterable {
            catalog
                .reason
                .clone()
                .or_else(|| Some("this host cannot offer Sandbox Enter".to_string()))
        } else {
            None
        }
    });
    SandboxCurrentContext {
        status: SandboxContextStatus::Outside,
        reason,
        generation: generation(&scope, SandboxContextStatus::Outside, None, &catalog),
        scope,
        execution: None,
        effective_policy: None,
        native_pane: None,
        enterable,
        sandbox_panes,
        catalog,
    }
}

fn inside_context(
    session_name: &str,
    pane: &PaneSummary,
    instance_id: Option<String>,
    catalog: SandboxCapabilityCatalog,
    record: ExecutionRecord,
    sandbox_panes: Vec<SandboxPaneRef>,
) -> SandboxCurrentContext {
    let mut scope = scope_of(session_name, pane, instance_id);
    scope.working_dir = Some(record.working_dir.clone());
    let native_pane = match (&record.native_window_id, &record.native_pane_id) {
        (Some(window_id), Some(pane_id)) => Some(SandboxNativePane {
            window_id: window_id.clone(),
            pane_id: pane_id.clone(),
        }),
        _ => None,
    };
    let execution = SandboxExecutionView {
        execution_id: record.execution_id.clone(),
        backend: record.backend.clone(),
        policy_digest: record.policy_digest.clone(),
        mechanisms: record.mechanisms.clone(),
        cgroup_path: record.cgroup_path.clone(),
        proxy_endpoint: record.proxy_endpoint.clone(),
        warnings: record.warnings.clone(),
        pane_pid: record.pane_pid,
        created_at: record.created_at,
    };
    SandboxCurrentContext {
        status: SandboxContextStatus::Inside,
        reason: None,
        generation: generation(
            &scope,
            SandboxContextStatus::Inside,
            Some(&record.execution_id),
            &catalog,
        ),
        scope,
        execution: Some(execution),
        effective_policy: record.effective_policy.as_ref().map(draft_from_policy),
        native_pane,
        enterable: false,
        sandbox_panes,
        catalog,
    }
}

fn sandbox_pane_refs(
    runtime: &crate::sandbox_runtime::SandboxRuntime,
    session_name: &str,
) -> Vec<SandboxPaneRef> {
    runtime
        .sandbox_panes(session_name)
        .into_iter()
        .filter_map(|record| {
            Some(SandboxPaneRef {
                execution_id: record.execution_id,
                window_id: record.window_id?,
                pane_id: record.pane_id?,
                backend: record.backend,
            })
        })
        .collect()
}

fn generation(
    scope: &SandboxPaneScope,
    status: SandboxContextStatus,
    execution_id: Option<&str>,
    catalog: &SandboxCapabilityCatalog,
) -> String {
    let facts = format!(
        "v1|{}|{}|{}|{}|{:?}|{:?}|{}|{}",
        scope.session_name,
        scope.session_instance_id.as_deref().unwrap_or("-"),
        scope.pane_id.as_deref().unwrap_or("-"),
        scope.window_id.as_deref().unwrap_or("-"),
        scope.pane_pid,
        status,
        execution_id.unwrap_or("-"),
        catalog.probe_generation
    );
    nession_sandbox::hex_sha256(facts.as_bytes())
}

fn unavailable_catalog(reason: String) -> SandboxCapabilityCatalog {
    SandboxCapabilityCatalog {
        catalog_version: SANDBOX_CATALOG_VERSION,
        status: SandboxCatalogStatus::Unavailable,
        platform: "unknown".to_string(),
        backend: None,
        probe_generation: nession_sandbox::hex_sha256(reason.as_bytes()),
        source: "agent-host-probe".to_string(),
        detail: Vec::new(),
        reason: Some(reason.clone()),
        implementations: REGISTERED_IMPLEMENTATION_PATHS
            .iter()
            .map(|path| SandboxImplementationSupport::unknown(*path, reason.clone()))
            .collect(),
        resource_fields: Vec::new(),
        syscall_fields: Vec::new(),
    }
}

fn preflight_error_code(error: &SandboxError) -> &'static str {
    match error {
        SandboxError::InvalidPolicy(_) => "invalid-policy",
        SandboxError::UnsupportedPolicy(_) | SandboxError::UnsupportedRequests(_) => "unsupported",
        SandboxError::BackendUnavailable(_) => "unavailable",
        SandboxError::Prepare(_) => "prepare-failed",
        SandboxError::Verify(_) => "verify-failed",
        SandboxError::Cleanup(_) => "cleanup-failed",
    }
}

fn action_refusal(
    kind: SandboxActionErrorKind,
    error: impl Into<String>,
    field_errors: Option<Vec<SandboxFieldError>>,
    context: Option<SandboxCurrentContext>,
) -> SandboxActionResult {
    SandboxActionResult {
        success: false,
        error_kind: Some(kind),
        error: Some(error.into()),
        field_errors,
        context,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(session: &str, pane_id: &str, window_id: &str, active: bool) -> PaneSummary {
        PaneSummary {
            session_id: "$0".to_string(),
            session_name: session.to_string(),
            window_id: window_id.to_string(),
            window_index: 0,
            window_name: "w".to_string(),
            pane_id: pane_id.to_string(),
            pane_index: 0,
            pane_pid: Some(1),
            pane_tty: None,
            window_linked: false,
            window_active: active,
            pane_active: active,
        }
    }

    #[test]
    fn the_active_pane_is_the_current_window_and_its_active_pane() {
        let panes = vec![
            pane("s", "%1", "@1", false),
            pane("s", "%2", "@2", true),
            pane("other", "%3", "@3", true),
        ];
        let active = active_pane_of(&panes, "s").expect("one active Pane");
        assert_eq!(active.pane_id, "%2");
        assert!(active_pane_of(&panes, "missing").is_none());
    }

    #[test]
    fn the_generation_changes_with_the_pane_or_execution() {
        let catalog = unavailable_catalog("no backend".to_string());
        let scope = SandboxPaneScope {
            session_name: "s".to_string(),
            session_instance_id: Some("i".to_string()),
            pane_id: Some("%1".to_string()),
            window_id: Some("@1".to_string()),
            pane_pid: Some(1),
            working_dir: None,
        };
        let first = generation(&scope, SandboxContextStatus::Outside, None, &catalog);
        let mut moved = scope.clone();
        moved.pane_id = Some("%2".to_string());
        let second = generation(&moved, SandboxContextStatus::Outside, None, &catalog);
        assert_ne!(first, second);
        let inside = generation(
            &scope,
            SandboxContextStatus::Inside,
            Some("exec-1"),
            &catalog,
        );
        assert_ne!(first, inside);
    }

    #[test]
    fn a_project_location_must_be_a_real_canonical_directory() {
        let location = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(location.path()).unwrap();
        assert_eq!(
            resolve_project_location(canonical.to_str(), None).unwrap(),
            canonical
        );

        let missing = location.path().join("missing");
        let error = resolve_project_location(missing.to_str(), None).unwrap_err();
        assert!(format!("{error:#}").contains("not available on this Agent"));

        let relative = resolve_project_location(Some("work/project"), None).unwrap_err();
        assert!(format!("{relative:#}").contains("absolute"));

        let error = resolve_project_location(
            canonical.to_str(),
            Some(&format!("sha256:{}", "a".repeat(64))),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("Project EROFS lower"));

        let error = resolve_project_location(None, None).unwrap_err();
        assert!(format!("{error:#}").contains("no Existing Location on this Agent"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_project_location_is_refused() {
        let location = tempfile::tempdir().unwrap();
        let target = std::fs::canonicalize(location.path()).unwrap();
        let link = location.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let error = resolve_project_location(link.to_str(), None).unwrap_err();
        assert!(format!("{error:#}").contains("must be a real directory"));
    }

    #[tokio::test]
    async fn an_unknown_explicit_managed_workspace_is_refused() {
        let state = tempfile::tempdir().unwrap();
        let manager = std::sync::Arc::new(
            crate::workspace_manager::WorkspaceManager::open(state.path().join("workspaces"))
                .unwrap(),
        );
        let unknown = format!("ws_{}", uuid::Uuid::new_v4());
        let error = resolve_managed_workspace(
            &manager,
            ManagedWorkspaceRequest {
                workspace_id: Some(&unknown),
                name: None,
                session_name: "fix-terminal",
                lower_digest: None,
            },
        )
        .await
        .unwrap_err();
        assert!(format!("{error:#}").contains("workspace not found"));
        // An unauthorized identity form is refused before any lookup.
        let error = resolve_managed_workspace(
            &manager,
            ManagedWorkspaceRequest {
                workspace_id: Some("../escape"),
                name: None,
                session_name: "fix-terminal",
                lower_digest: None,
            },
        )
        .await
        .unwrap_err();
        assert!(format!("{error:#}").contains("not a valid managed workspace identity"));
    }

    #[tokio::test]
    async fn a_managed_workspace_pins_its_project_lower_across_resolution() {
        let state = tempfile::tempdir().unwrap();
        let manager = std::sync::Arc::new(
            crate::workspace_manager::WorkspaceManager::open(state.path().join("workspaces"))
                .unwrap(),
        );
        let first_lower = format!("sha256:{}", "a".repeat(64));
        let other_lower = format!("sha256:{}", "b".repeat(64));
        let resolved = resolve_managed_workspace(
            &manager,
            ManagedWorkspaceRequest {
                workspace_id: None,
                name: None,
                session_name: "fix-terminal",
                lower_digest: Some(&first_lower),
            },
        )
        .await
        .unwrap();
        let path = match resolved {
            crate::sandbox_images::SandboxWorkspaceOverride::Managed { path, .. } => path,
            _ => panic!("auto must resolve to a managed Workspace"),
        };
        assert!(path.is_dir());
        // The lease is released for the rest of this test; a new resolution
        // must observe the persisted pin, not an in-memory claim.
        drop(manager);

        let manager = std::sync::Arc::new(
            crate::workspace_manager::WorkspaceManager::open(state.path().join("workspaces"))
                .unwrap(),
        );
        let changed = resolve_managed_workspace(
            &manager,
            ManagedWorkspaceRequest {
                workspace_id: None,
                name: None,
                session_name: "fix-terminal",
                lower_digest: Some(&other_lower),
            },
        )
        .await
        .unwrap_err();
        assert!(format!("{changed:#}").contains("refusing a different lower"));
        let missing = resolve_managed_workspace(
            &manager,
            ManagedWorkspaceRequest {
                workspace_id: None,
                name: None,
                session_name: "fix-terminal",
                lower_digest: None,
            },
        )
        .await
        .unwrap_err();
        assert!(format!("{missing:#}").contains("re-enter with the same lower"));
        let listed = manager.list(None).await.unwrap();
        let workspace_id = listed.first().unwrap().workspace_id.clone();
        let again = resolve_managed_workspace(
            &manager,
            ManagedWorkspaceRequest {
                workspace_id: Some(workspace_id.as_str()),
                name: None,
                session_name: "fix-terminal",
                lower_digest: Some(&first_lower),
            },
        )
        .await
        .unwrap();
        match again {
            crate::sandbox_images::SandboxWorkspaceOverride::Managed {
                path: again_path, ..
            } => {
                assert_eq!(again_path, path);
            }
            _ => panic!("an explicit id must resolve to the managed Workspace"),
        }
    }
}
