//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, session_create_reply, AgentStatus, ClientSessionCreatePayload,
    ClientSessionCreateResponsePayload, ConnectionHandler, Duration, EnvFileRef, EnvSource,
    HandlerAction, ProtocolMessage,
};
use nession_erofs::oci::descriptor::Platform;
use nession_protocol::contracts::image::v1::{normalize_image_digest, ImageSource};
use nession_protocol::contracts::session::v1::{
    validate_session_name, ClientManagedCreate, EnvSelectionMode, ManagedImageGrant,
    ManagedImageObjectGrant, ManagedImageRole, ManagedSessionImages,
};

use crate::image::{agent_platform, ImageResolution};

// How long the Server waits for the Agent's create answer. Production keeps
// the operator-facing 30s/300s windows; unit tests use short values so an
// unanswered reply exercises the deadline deterministically without a
// wall-clock sleep (#3344).
#[cfg(test)]
const CREATE_RESPONSE_WAIT: Duration = Duration::from_millis(100);
#[cfg(not(test))]
const CREATE_RESPONSE_WAIT: Duration = Duration::from_secs(30);
#[cfg(test)]
const MANAGED_CREATE_RESPONSE_WAIT: Duration = Duration::from_millis(200);
#[cfg(not(test))]
const MANAGED_CREATE_RESPONSE_WAIT: Duration = Duration::from_secs(300);

/// One Managed creation the Server has resolved and authorized (#3062).
struct PreparedManagedCreate {
    images: ManagedSessionImages,
    attempt_id: String,
}

/// The identity fields of one resolved Managed image grant.
struct ManagedImageGrantIdentity {
    digest: String,
    path: String,
    objects: Vec<ManagedImageObjectGrant>,
}

/// Canonical Git repository identity for comparing a Project declaration with
/// the source a pinned image was built from.
fn normalized_git_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let without_git = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    without_git.trim_end_matches('/').to_ascii_lowercase()
}

fn is_full_commit(reference: &str) -> bool {
    reference.len() == 40 && reference.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Whether a Project's declared Git Source still names the source of its
/// pinned Project image (#3794 SC-03).
///
/// A non-Git image source cannot prove or disprove the Project declaration,
/// so it is not refused here. A full commit `ref` is matched against the
/// image's resolved `source_sha`; any other ref must equal the ref the build
/// recorded. A mismatch means the declaration changed after the pin.
fn project_source_matches_image(
    project_source: &nession_protocol::contracts::project::v1::ProjectSource,
    image_source: &ImageSource,
    image_source_sha: Option<&str>,
) -> bool {
    let ImageSource::GitHub {
        repository_url,
        reference,
    } = image_source
    else {
        return true;
    };
    if normalized_git_url(&project_source.repository_url) != normalized_git_url(repository_url) {
        return false;
    }
    let project_ref = project_source.reference.trim();
    if is_full_commit(project_ref) {
        return image_source_sha.is_some_and(|sha| sha.eq_ignore_ascii_case(project_ref));
    }
    project_ref == reference.trim()
}

impl ConnectionHandler {
    /// Handle `server.session.create` — create a new session on a target agent.
    pub(super) async fn handle_client_session_create(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. This unit's `error` carries
        // `skip_serializing_if`, so unlike `session.kill` the type *omits* it
        // when absent — which is why the created branch below loses an
        // `error: null` it used to send rather than gaining one.
        let refusal = |error: &str| ClientSessionCreateResponsePayload {
            success: false,
            session_id: None,
            error: Some(error.to_string()),
            warnings: Vec::new(),
            project_id: None,
            sandbox: None,
            instance_id: None,
            metadata: None,
        };

        if !self.authenticated_client {
            return Ok(session_create_reply(&msg.id, refusal("Not authenticated")));
        }

        // Pre-read the explicit selection mode so an unsupported value names
        // itself. The typed parse below remains the single owner of the shape;
        // this only prevents it from collapsing every malformed field into the
        // generic "agent_id and name are required" refusal.
        let env_selection_mode = match msg.payload.get("env_selection_mode") {
            None | Some(serde_json::Value::Null) => None,
            Some(value) => match serde_json::from_value::<EnvSelectionMode>(value.clone()) {
                Ok(mode) => Some(mode),
                Err(_) => {
                    return Ok(session_create_reply(
                        &msg.id,
                        refusal("env_selection_mode must be 'inherit' or 'replace'"),
                    ));
                }
            },
        };

        // `env_files` is declared now. The handler read it off the payload after
        // this parse would have moved it, so the compiler showed the contract
        // was missing a field rather than a reviewer having to notice.
        let Ok(ClientSessionCreatePayload {
            agent_id,
            name,
            working_dir,
            env_files: env_refs,
            env_selection_mode: _,
            sandbox,
            project_id,
            managed,
            initial_metadata,
        }) = serde_json::from_value::<ClientSessionCreatePayload>(msg.payload)
        else {
            return Ok(session_create_reply(
                &msg.id,
                refusal("agent_id and name are required"),
            ));
        };

        if agent_id.is_empty() || name.is_empty() {
            return Ok(session_create_reply(
                &msg.id,
                refusal("agent_id and name are required"),
            ));
        }
        // One creation-time name policy for every Server create route (#4614).
        // The Agent repeats it at its own boundary; this refusal is earlier
        // and avoids a round trip that cannot succeed.
        if let Err(error) = validate_session_name(&name) {
            return Ok(session_create_reply(
                &msg.id,
                refusal(&format!("invalid Session name: {error}")),
            ));
        }
        // The one shared metadata contract validates the initial work context
        // before anything is staged or sent to an Agent (#4081). The Agent
        // validates again at its own boundary; this refusal is the earlier,
        // cleaner answer for a Server client.
        let initial_metadata = match initial_metadata {
            Some(metadata) => match metadata.normalized() {
                Ok(_) => Some(metadata),
                Err(error) => {
                    return Ok(session_create_reply(
                        &msg.id,
                        refusal(&format!("invalid: {error}")),
                    ));
                }
            },
            None => None,
        };
        let agent_id = agent_id.as_str();

        // A Project is a declaration; the Session owns its realized
        // environment (#3025). Naming one ties this create to an Existing
        // Location the Project actually declares, so a client cannot attach an
        // arbitrary Agent/path pair by asserting a Project id. The Project may
        // be edited or deleted later without mutating this Session.
        let project = if let Some(project_id) = project_id.as_deref() {
            let project = match self.db.get_project(project_id).await {
                Ok(Some(project)) => project,
                Ok(None) => {
                    return Ok(session_create_reply(
                        &msg.id,
                        refusal(&format!("Project '{project_id}' not found")),
                    ));
                }
                Err(e) => {
                    tracing::error!("Failed to read project {project_id}: {e:#}");
                    return Ok(session_create_reply(
                        &msg.id,
                        refusal("Project could not be loaded"),
                    ));
                }
            };
            // A Managed Session uses the Project Source image and an
            // Agent-owned workspace, so it names no Existing Location.
            if managed.is_none() {
                let Some(working_dir) = working_dir.as_deref() else {
                    return Ok(session_create_reply(
                        &msg.id,
                        refusal("A Project Session requires an Existing Location directory"),
                    ));
                };
                if !project
                    .locations
                    .iter()
                    .any(|location| location.agent_id == agent_id && location.path == working_dir)
                {
                    return Ok(session_create_reply(
                        &msg.id,
                        refusal(&format!(
                            "Agent '{agent_id}' and directory '{working_dir}' are not an Existing Location of Project '{project_id}'"
                        )),
                    ));
                }
            }
            Some(project)
        } else {
            None
        };

        // Check agent exists and is online
        let agent = self.agent_registry.get(agent_id).await;
        // The Agent's advertised OCI platform selects a platform Manifest from
        // an Index. An older Agent that advertises none keeps the legacy
        // digest-addressed path only (#3499).
        let managed_platform = agent.as_ref().and_then(agent_platform);
        match agent {
            Some(a) if a.status == AgentStatus::Online => {}
            Some(_) => {
                return Ok(session_create_reply(
                    &msg.id,
                    refusal(&format!("Agent '{agent_id}' is offline")),
                ));
            }
            None => {
                return Ok(session_create_reply(
                    &msg.id,
                    refusal(&format!("Agent '{agent_id}' not found")),
                ));
            }
        }

        let request_id = uuid::Uuid::new_v4().to_string();

        // Managed creation (#3062): resolve and authorize every pinned artifact
        // before the Agent prepares its cache. A failure here refuses the
        // create and no Session is started.
        let managed_context = if let Some(request) = managed.as_ref() {
            match self
                .begin_managed_create(
                    project.as_ref(),
                    project_id.as_deref(),
                    agent_id,
                    &name,
                    request,
                    &request_id,
                    managed_platform.as_ref(),
                )
                .await
            {
                Ok(context) => Some(context),
                Err(error) => {
                    return Ok(session_create_reply(&msg.id, refusal(&error)));
                }
            }
        } else {
            None
        };

        // Precedence (#3025 SC-03, #3649): an explicit selection mode states
        // the caller's intent. `replace` uses the request exactly, including an
        // empty list that deliberately binds no environment. `inherit` resolves
        // the named Project's declared ENV profile ids and refuses a
        // simultaneous explicit selection. Absent keeps the legacy precedence:
        // a non-empty request selection wins; only when the request selects
        // none do the Project's declared ENV profile ids apply. The resolved
        // set becomes the Session's own binding below, so a later Project edit
        // cannot mutate an existing Session's environment.
        let inherited_refs = |project: Option<&crate::db::ProjectRow>| -> Vec<EnvFileRef> {
            project
                .and_then(|project| project.session_defaults.as_ref())
                .map(|defaults| {
                    defaults
                        .env_profile_ids
                        .iter()
                        .map(|id| EnvFileRef {
                            name: id.clone(),
                            source: EnvSource::Server,
                            agent_id: None,
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let env_refs: Vec<EnvFileRef> = match env_selection_mode {
            Some(EnvSelectionMode::Inherit) => {
                if !env_refs.is_empty() {
                    return Ok(session_create_reply(
                        &msg.id,
                        refusal(
                            "env_selection_mode 'inherit' cannot be combined with env_files; use 'replace' for an explicit selection",
                        ),
                    ));
                }
                if project.is_none() {
                    return Ok(session_create_reply(
                        &msg.id,
                        refusal("env_selection_mode 'inherit' requires a Project"),
                    ));
                }
                inherited_refs(project.as_ref())
            }
            Some(EnvSelectionMode::Replace) => env_refs,
            None => {
                if env_refs.is_empty() {
                    inherited_refs(project.as_ref())
                } else {
                    env_refs
                }
            }
        };

        // `env_refs` is the effective create-time binding selection — the
        // explicit request or the Project defaults above. The same resolution
        // produces both the Agent's snapshots and the desired binding the
        // Server persists, so the two cannot describe different content.
        let snapshots = if env_refs.is_empty() {
            Vec::new()
        } else {
            match self.resolve_snapshots(agent_id, &env_refs).await {
                Ok(s) => s,
                Err(e) => {
                    return Ok(session_create_reply(&msg.id, refusal(&e)));
                }
            }
        };
        let mut materialized = crate::env::binding::materialized_profiles(&[], &env_refs, "create");
        for (materialized, snapshot) in materialized.iter_mut().zip(&snapshots) {
            materialized.content_hash = Some(crate::env::binding::snapshot_hash(snapshot));
        }
        let binding_profiles: Vec<super::SessionEnvProfile> = materialized
            .iter()
            .map(|materialized| super::SessionEnvProfile {
                profile: materialized.profile.clone(),
                phase: materialized.phase.clone(),
                content_hash: materialized.content_hash.clone(),
            })
            .collect();
        let binding_revision = if env_refs.is_empty() { 0 } else { 1 };
        let session_id_for_binding = format!("{agent_id}:{name}");
        // Stage the attempt's desired binding; do not persist it yet. An Agent
        // that refuses a duplicate name never owned this Session, so writing
        // here would replace or clear the live Session's binding before that
        // refusal arrives (#2999). The candidate is applied only after a
        // successful create, or on the ambiguous answer where the Agent may
        // have created the Session.
        let candidate_binding = if env_refs.is_empty() {
            None
        } else {
            Some(crate::env::BindingRecord {
                session_id: session_id_for_binding.clone(),
                agent_id: agent_id.to_string(),
                desired_revision: binding_revision,
                profiles: materialized,
                updated_at: i64::try_from(super::current_timestamp()).unwrap_or(0),
            })
        };

        info!(
            "Client requested session create on agent {}: name={}, env_files={}",
            agent_id,
            name,
            env_refs.len()
        );

        // An ambiguous create reply (disconnect/timeout) must not overwrite
        // the membership of a Session that already existed under this name.
        let session_pre_existed = self
            .session_registry
            .get(&session_id_for_binding)
            .await
            .is_some();
        // A Managed Session's cwd is `/workspace` inside the prepared
        // sandbox; the Agent owns the host-side tmux cwd and the writable
        // workspace directory.
        let agent_working_dir = if managed_context.is_some() {
            None
        } else {
            working_dir
        };
        let rx = self
            .command_broker
            .send_command(
                agent_id,
                "agent.session.create",
                &request_id,
                json!({
                    "request_id": request_id,
                    "name": name,
                    // Ignored on the far side: the Agent creates every session at
                    // its own fixed starting size and lets the first attach
                    // resize it (`TmuxManager::create_session`, and the sizing
                    // decision of 2026-08-15). Kept because the agent payload
                    // field exists and a missing key is not the same wire as one
                    // that says 80×24 — see the note on the CLI's `--width`.
                    "width": 80,
                    "height": 24,
                    // The fixed column count this release selects (#2487).
                    // The Agent validates and creates at this width; the
                    // `width` above remains for an Agent built before the
                    // field existed and is ignored by a current one.
                    "terminal_cols": self.config.terminal_cols,
                    "working_dir": agent_working_dir,
                    "env_snapshots": snapshots,
                    "binding_profiles": binding_profiles,
                    "binding_revision": if binding_revision == 0 {
                        None
                    } else {
                        Some(binding_revision)
                    },
                    "sandbox": sandbox,
                    "managed": managed_context.as_ref().map(|context| &context.images),
                    // Initial Session work context (#4081). The Agent owns the
                    // commit; this is the same field on the direct projection.
                    "initial_metadata": initial_metadata,
                }),
            )
            .await;

        // A Managed create waits for the Agent's cache preparation before the
        // Session exists, so it gets a bounded longer window than the ordinary
        // create. Both are explicit timeouts; neither retries on its own.
        let response_wait = if managed_context.is_some() {
            MANAGED_CREATE_RESPONSE_WAIT
        } else {
            CREATE_RESPONSE_WAIT
        };
        match tokio::time::timeout(response_wait, rx).await {
            Ok(Ok(response)) => {
                let success = response
                    .get("success")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let managed_workspace = response
                    .get("workspace")
                    .and_then(serde_json::Value::as_str)
                    .map(std::string::ToString::to_string);
                let (session_id, binding_warning, project_id) = if success {
                    let sid = format!("{agent_id}:{name}");
                    // The SessionWatcher may have reported the real pane
                    // command *before* this create ACK was delivered (#2021).
                    // Only fill an absent row. Overwriting an existing Agent
                    // report with foreground_command=None would roll "bash"
                    // back to "unknown" even after the server already pushed
                    // the authoritative value to the browser.
                    let session_info = crate::registry::session::SessionInfo {
                        session_id: sid.clone(),
                        agent_id: agent_id.to_string(),
                        session_name: name.to_string(),
                        status: crate::registry::session::SessionStatus::Detached,
                        window_count: 1,
                        attached_clients: 0,
                        // Just created: the agent reports the pane command on
                        // its next update.
                        foreground_command: None,
                        working_dir: None,
                        created_at: chrono::Utc::now(),
                        last_activity: chrono::Utc::now(),
                        instance_id: None,
                        // The Agent's first inventory reports the summary.
                        metadata: None,
                        activity: None,
                        activity_epoch: None,
                        activity_generation: 0,
                    };
                    self.session_registry
                        .insert_session_if_absent(session_info)
                        .await;
                    // Apply the staged Environment Binding before the broadcast:
                    // the create reply is the frame this client expects next,
                    // and awaiting the binding after the broadcast let the
                    // queued sessions-changed frame arrive first.
                    let binding_warning = self
                        .apply_create_binding(&session_id_for_binding, candidate_binding.as_ref())
                        .await;
                    // Commit the Project membership with the same create. The
                    // Agent never sees it; the Server owns the link. The first
                    // Agent report adopts the binding with the tmux creation
                    // time, which is what makes a later name reuse a different
                    // incarnation (#3082 SC-01/SC-02).
                    let project_id = if let Some(pid) = project_id.as_deref() {
                        match self
                            .apply_create_project_binding(&session_id_for_binding, pid)
                            .await
                        {
                            Ok(()) => Some(pid.to_string()),
                            Err(e) => {
                                tracing::error!(
                                    "Failed to persist Project membership for {session_id_for_binding}: {e:#}"
                                );
                                None
                            }
                        }
                    } else {
                        None
                    };
                    if let Some(context) = &managed_context {
                        if let Err(e) = self
                            .db
                            .mark_session_managed_context_ready(
                                &session_id_for_binding,
                                &context.attempt_id,
                                managed_workspace.as_deref(),
                            )
                            .await
                        {
                            tracing::error!(
                                "Failed to mark managed context ready for {session_id_for_binding}: {e:#}"
                            );
                        }
                    }
                    // Broadcast the current registry snapshot, which might
                    // contain a newer Agent report than this create reply.
                    self.broadcast_sessions().await;
                    (Some(sid), binding_warning, project_id)
                } else {
                    // The Agent refused the create (a duplicate name or another
                    // refusal). This attempt does not own the Session, so its
                    // staged candidate is discarded without touching the
                    // existing binding. A Managed attempt records the refusal
                    // so a retry sees a truthful failed disposition.
                    if let Some(context) = &managed_context {
                        let reason = response
                            .get("error")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("Managed creation was refused by the Agent");
                        if let Err(e) = self
                            .db
                            .mark_session_managed_context_failed(
                                &session_id_for_binding,
                                &context.attempt_id,
                                reason,
                            )
                            .await
                        {
                            tracing::error!(
                                "Failed to mark managed context failed for {session_id_for_binding}: {e:#}"
                            );
                        }
                    }
                    (None, None, None)
                };
                let error = response
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string);
                let mut warnings = response
                    .get("warnings")
                    .and_then(|value| value.as_array())
                    .map(|warnings| {
                        warnings
                            .iter()
                            .filter_map(|warning| warning.as_str().map(str::to_string))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if let Some(warning) = binding_warning {
                    warnings.push(warning);
                }
                let sandbox_report = response.get("sandbox").and_then(|value| {
                    serde_json::from_value::<
                        nession_protocol::contracts::sandbox::v1::SandboxExecutionReport,
                    >(value.clone())
                    .ok()
                });
                // The Agent's committed initial work context and the durable
                // identity it belongs to (#4081). A successful create reports
                // both; a refusal reports neither.
                let instance_id = response
                    .get("instance_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                let metadata = response
                    .get("metadata")
                    .filter(|value| !value.is_null())
                    .and_then(|value| {
                        serde_json::from_value::<
                            nession_protocol::contracts::session::v1::SessionMetadata,
                        >(value.clone())
                        .ok()
                    });

                Ok(session_create_reply(
                    &msg.id,
                    ClientSessionCreateResponsePayload {
                        success,
                        session_id,
                        error,
                        warnings,
                        project_id,
                        sandbox: sandbox_report,
                        instance_id,
                        metadata,
                    },
                ))
            }
            // The Agent may have processed the create even though its answer
            // did not arrive. A genuinely new Session keeps the ambiguous-create
            // recovery semantics: apply the staged candidate, because losing a
            // real Session's intent is worse than a stale row a later session
            // list can clean up. An attempt that targeted an already-live
            // Session owns no new incarnation, so it must not replace or clear
            // that Session's desired binding (#3344).
            Ok(Err(_)) => {
                if let Some(context) = &managed_context {
                    let _ = self
                        .db
                        .mark_session_managed_context_failed(
                            &session_id_for_binding,
                            &context.attempt_id,
                            "Agent disconnected during Managed creation",
                        )
                        .await;
                }
                self.apply_ambiguous_create_binding(
                    &session_id_for_binding,
                    candidate_binding.as_ref(),
                    project_id.as_deref(),
                    session_pre_existed,
                )
                .await;
                Ok(session_create_reply(&msg.id, refusal("Agent disconnected")))
            }
            Err(_) => {
                // The caller's deadline settles the pending entry (#4434,
                // SC-03): the entry is removed now, so a late create reply is
                // counted as `late` instead of being delivered to a request
                // whose caller has already been answered. Kill and the generic
                // timeout path already do this; create ran its own timeout and
                // was the rollout miss.
                self.command_broker
                    .expire_pending(agent_id, &request_id)
                    .await;
                if let Some(context) = &managed_context {
                    let _ = self
                        .db
                        .mark_session_managed_context_failed(
                            &session_id_for_binding,
                            &context.attempt_id,
                            "Timeout waiting for the Agent during Managed creation",
                        )
                        .await;
                }
                // Same ownership fence as the disconnect branch (#3344).
                self.apply_ambiguous_create_binding(
                    &session_id_for_binding,
                    candidate_binding.as_ref(),
                    project_id.as_deref(),
                    session_pre_existed,
                )
                .await;
                Ok(session_create_reply(
                    &msg.id,
                    refusal("Timeout waiting for agent response"),
                ))
            }
        }
    }

    /// Resolve and authorize one Managed creation's pinned artifacts.
    ///
    /// Every digest is normalized and required to be a ready Image Manager
    /// artifact; the Server mints a scoped grant for each one and records the
    /// `preparing` context. The Agent remains the owner of cache preparation
    /// and sandbox capability validation.
    /// Resolve one Managed artifact to its pinned Manifest grant.
    ///
    /// A catalog image yields the final Manifest digest plus the Manifest,
    /// Config and EROFS routes the Agent may fetch. A historical
    /// digest-addressed EROFS row keeps the accepted single-digest grant.
    #[allow(clippy::too_many_arguments)]
    async fn resolve_managed_grant(
        &self,
        project_id: &str,
        session_id: &str,
        digest: &str,
        platform: Option<&Platform>,
        role: &str,
        label: &str,
    ) -> Result<(ManagedImageGrantIdentity, crate::db::ResolvedImageBinding), String> {
        match self
            .image_manager
            .resolve_managed_image(project_id, session_id, digest, platform)
            .await
            .map_err(|error| format!("{label}: {error}"))?
        {
            ImageResolution::Manifest(access) => {
                let path = access
                    .objects
                    .first()
                    .map(|object| object.path.clone())
                    .ok_or_else(|| format!("{label}: resolved Manifest has no route"))?;
                let objects = access
                    .objects
                    .iter()
                    .map(|object| ManagedImageObjectGrant {
                        digest: object.digest.clone(),
                        media_type: object.media_type.clone(),
                        size_bytes: object.size_bytes,
                        path: object.path.clone(),
                    })
                    .collect();
                let binding = crate::db::ResolvedImageBinding {
                    role: role.to_string(),
                    requested_digest: digest.to_string(),
                    manifest_digest: Some(access.manifest_digest.clone()),
                    layer_digest: access.layer_digest.clone(),
                };
                Ok((
                    ManagedImageGrantIdentity {
                        digest: access.manifest_digest,
                        path,
                        objects,
                    },
                    binding,
                ))
            }
            ImageResolution::Legacy(grant) => {
                let binding = crate::db::ResolvedImageBinding {
                    role: role.to_string(),
                    requested_digest: digest.to_string(),
                    manifest_digest: None,
                    layer_digest: digest.to_string(),
                };
                Ok((
                    ManagedImageGrantIdentity {
                        digest: digest.to_string(),
                        path: grant.path,
                        objects: Vec::new(),
                    },
                    binding,
                ))
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn begin_managed_create(
        &self,
        project: Option<&crate::db::ProjectRow>,
        project_id: Option<&str>,
        agent_id: &str,
        session_name: &str,
        request: &ClientManagedCreate,
        attempt_id: &str,
        platform: Option<&Platform>,
    ) -> Result<PreparedManagedCreate, String> {
        let Some(project) = project else {
            return Err("Managed creation requires a Project".to_string());
        };
        let Some(project_id) = project_id else {
            return Err("Managed creation requires a Project".to_string());
        };
        // A Managed Session that already reached `ready` owns its workspace
        // and its durable context. A same-named create is not a retry of that
        // Session — the Agent would refuse the duplicate tmux name — and
        // starting a new attempt here would overwrite the live context with a
        // `preparing` row before the refusal arrived. Remove the Session
        // first; a stale ready row is reclaimed by Session reconciliation.
        let session_id = format!("{agent_id}:{session_name}");
        if let Some(existing) = self
            .db
            .get_session_managed_context(&session_id)
            .await
            .map_err(|error| format!("Managed context could not be read: {error:#}"))?
        {
            if existing.status == "ready" {
                return Err(format!(
                    "Session '{session_name}' already exists with a ready Managed context; remove it before creating again"
                ));
            }
        }
        let Some(workspace_digest) = project.image_digest.clone() else {
            return Err(format!(
                "Project '{project_id}' does not pin an EROFS image required for a Managed Session"
            ));
        };
        let workspace_digest = normalize_image_digest(&workspace_digest)
            .map_err(|error| format!("Project Source image: {}", error.message()))?;
        // The legacy source commit remains available for a digest-addressed
        // EROFS row; a catalog Manifest identity may have no legacy row. The
        // same descriptor is the staleness boundary for the Project's Git
        // Source: a create never silently consumes an image built from a
        // different declaration (#3794 SC-03).
        let workspace_descriptor = self
            .image_manager
            .get(Some(&workspace_digest), None)
            .await
            .ok();
        if let (Some(project_source), Some(descriptor)) =
            (project.source.as_ref(), workspace_descriptor.as_ref())
        {
            if !project_source_matches_image(
                project_source,
                &descriptor.source,
                descriptor.source_sha.as_deref(),
            ) {
                return Err(format!(
                    "Project '{project_id}' Git Source changed since its pinned image was built; re-pin the Project image before creating a Managed Session"
                ));
            }
        }
        let workspace_source_sha =
            workspace_descriptor.and_then(|descriptor| descriptor.source_sha);

        let base_digest = normalize_image_digest(&request.base_digest)
            .map_err(|error| format!("Base Runtime image: {}", error.message()))?;
        let (base_grant, base_binding) = self
            .resolve_managed_grant(
                project_id,
                &session_id,
                &base_digest,
                platform,
                "base",
                "Base Runtime image",
            )
            .await?;
        let (workspace_grant, workspace_binding) = self
            .resolve_managed_grant(
                project_id,
                &session_id,
                &workspace_digest,
                platform,
                "workspace",
                "Project Source image",
            )
            .await?;

        let mut images = vec![
            ManagedImageGrant {
                role: ManagedImageRole::Base,
                digest: base_grant.digest,
                path: base_grant.path,
                target: None,
                objects: base_grant.objects,
            },
            ManagedImageGrant {
                role: ManagedImageRole::Workspace,
                digest: workspace_grant.digest,
                path: workspace_grant.path,
                target: None,
                objects: workspace_grant.objects,
            },
        ];
        let mut resolved_images = vec![base_binding, workspace_binding];
        for toolchain in &request.toolchains {
            let digest = normalize_image_digest(&toolchain.digest)
                .map_err(|error| format!("Toolchain image: {}", error.message()))?;
            let (grant, binding) = self
                .resolve_managed_grant(
                    project_id,
                    &session_id,
                    &digest,
                    platform,
                    "toolchain",
                    &format!("Toolchain image {digest}"),
                )
                .await?;
            images.push(ManagedImageGrant {
                role: ManagedImageRole::Toolchain,
                digest: grant.digest,
                path: grant.path,
                target: toolchain.target.clone(),
                objects: grant.objects,
            });
            resolved_images.push(binding);
        }

        let row = crate::db::SessionManagedContextRow {
            session_id,
            agent_id: agent_id.to_string(),
            project_id: project_id.to_string(),
            attempt_id: attempt_id.to_string(),
            base_digest,
            workspace_digest,
            toolchains: request.toolchains.clone(),
            source_sha: workspace_source_sha,
            workspace: None,
            status: "preparing".to_string(),
            error: None,
            updated_at: chrono::Utc::now().timestamp(),
            resolved_images,
        };
        self.db
            .begin_session_managed_context(&row)
            .await
            .map_err(|error| format!("Managed context could not be recorded: {error:#}"))?;
        Ok(PreparedManagedCreate {
            images: ManagedSessionImages { images },
            attempt_id: attempt_id.to_string(),
        })
    }

    /// Record the Project membership a create committed.
    ///
    /// The binding is deliberately written with `agent_created_at = 0`
    /// (pending): the Agent ACK does not carry the tmux creation time, and the
    /// first authoritative report adopts it. Until then, the list projection
    /// only exposes the membership for a session row that belongs to this
    /// create's short window.
    async fn apply_create_project_binding(
        &self,
        session_id: &str,
        project_id: &str,
    ) -> anyhow::Result<()> {
        let agent_id = session_id
            .split_once(':')
            .map(|(agent_id, _)| agent_id)
            .unwrap_or_default();
        let row = crate::db::SessionProjectBindingRow {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
            project_id: project_id.to_string(),
            incarnation_id: String::new(),
            agent_created_at: 0,
            revision: 1,
            updated_at: chrono::Utc::now().timestamp(),
        };
        self.db.upsert_session_project_binding(&row).await
    }

    /// Reconcile the staged binding for an ambiguous create outcome (reply
    /// channel closed, or the create deadline elapsed).
    ///
    /// An attempt that targeted an already-live Session (`session_pre_existed`)
    /// owns no new Session incarnation: its speculative candidate must not
    /// replace or clear that Session's desired binding or Project membership
    /// (#3344). A genuinely new Session keeps the ambiguous-create recovery
    /// semantics — the Agent may have created it — so the candidate is applied
    /// exactly as before.
    async fn apply_ambiguous_create_binding(
        &self,
        session_id: &str,
        candidate: Option<&crate::env::BindingRecord>,
        project_id: Option<&str>,
        session_pre_existed: bool,
    ) {
        if session_pre_existed {
            return;
        }
        let _ = self.apply_create_binding(session_id, candidate).await;
        if let Some(pid) = project_id {
            let _ = self.apply_create_project_binding(session_id, pid).await;
        }
    }

    /// Apply a create's staged Environment Binding once the Agent has answered.
    ///
    /// A successful create owns the Session, so the attempt may replace a stale
    /// row or start a new Session empty. The candidate is `None` when the
    /// request selected no profiles; a successful Session then clears any stale
    /// same-named row rather than inheriting it. A refusal never calls this.
    async fn apply_create_binding(
        &self,
        session_id: &str,
        candidate: Option<&crate::env::BindingRecord>,
    ) -> Option<String> {
        match candidate {
            Some(record) => match self.env_service.bindings.put(record).await {
                Ok(()) => None,
                Err(e) => {
                    tracing::error!(
                        "Failed to persist env binding for {session_id} after create: {e:#}"
                    );
                    Some(format!(
                        "Session created, but the Environment Binding could not be persisted: {e:#}"
                    ))
                }
            },
            None => {
                // A new Session with no selected profiles starts empty; a row
                // from a dead same-named Session must not leak into it.
                self.env_service.bindings.clear_session(session_id).await;
                None
            }
        }
    }
}
