//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    info, json, session_create_reply, AgentStatus, ClientSessionCreatePayload,
    ClientSessionCreateResponsePayload, ConnectionHandler, Duration, EnvFileRef, EnvSource,
    HandlerAction, ProtocolMessage,
};
use nession_protocol::contracts::image::v1::{normalize_image_digest, ImageStatus};
use nession_protocol::contracts::session::v1::{
    ClientManagedCreate, ManagedImageGrant, ManagedImageRole, ManagedSessionImages,
};

/// One Managed creation the Server has resolved and authorized (#3062).
struct PreparedManagedCreate {
    images: ManagedSessionImages,
    attempt_id: String,
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
        };

        if !self.authenticated_client {
            return Ok(session_create_reply(&msg.id, refusal("Not authenticated")));
        }

        // `env_files` is declared now. The handler read it off the payload after
        // this parse would have moved it, so the compiler showed the contract
        // was missing a field rather than a reviewer having to notice.
        let Ok(ClientSessionCreatePayload {
            agent_id,
            name,
            working_dir,
            env_files: env_refs,
            sandbox,
            project_id,
            managed,
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

        // Precedence (#3025 SC-03): an explicit request selection wins; only
        // when the request selects none do the Project's declared ENV profile
        // ids apply, resolved as Server env files by name. The resolved set
        // becomes the Session's own binding below, so a later Project edit
        // cannot mutate an existing Session's environment.
        let env_refs: Vec<EnvFileRef> = if env_refs.is_empty() {
            project
                .as_ref()
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
        } else {
            env_refs
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
                }),
            )
            .await;

        // A Managed create waits for the Agent's cache preparation before the
        // Session exists, so it gets a bounded longer window than the ordinary
        // create. Both are explicit timeouts; neither retries on its own.
        let response_wait = if managed_context.is_some() {
            Duration::from_secs(300)
        } else {
            Duration::from_secs(30)
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

                Ok(session_create_reply(
                    &msg.id,
                    ClientSessionCreateResponsePayload {
                        success,
                        session_id,
                        error,
                        warnings,
                        project_id,
                        sandbox: sandbox_report,
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
    async fn begin_managed_create(
        &self,
        project: Option<&crate::db::ProjectRow>,
        project_id: Option<&str>,
        agent_id: &str,
        session_name: &str,
        request: &ClientManagedCreate,
        attempt_id: &str,
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
        let workspace = self
            .image_manager
            .get(Some(&workspace_digest), None)
            .await
            .map_err(|error| format!("Project Source image: {error}"))?;
        if workspace.status != ImageStatus::Ready {
            return Err(format!(
                "Project Source image {workspace_digest} is not ready"
            ));
        }

        let base_digest = normalize_image_digest(&request.base_digest)
            .map_err(|error| format!("Base Runtime image: {}", error.message()))?;
        let base = self
            .image_manager
            .grant_managed_access(project_id, &base_digest)
            .await
            .map_err(|error| format!("Base Runtime image: {error}"))?;
        let workspace_grant = self
            .image_manager
            .grant_managed_access(project_id, &workspace_digest)
            .await
            .map_err(|error| format!("Project Source image: {error}"))?;

        let mut images = vec![
            ManagedImageGrant {
                role: ManagedImageRole::Base,
                digest: base_digest.clone(),
                path: base.path,
                token: base.token,
                target: None,
            },
            ManagedImageGrant {
                role: ManagedImageRole::Workspace,
                digest: workspace_digest.clone(),
                path: workspace_grant.path,
                token: workspace_grant.token,
                target: None,
            },
        ];
        for toolchain in &request.toolchains {
            let digest = normalize_image_digest(&toolchain.digest)
                .map_err(|error| format!("Toolchain image: {}", error.message()))?;
            let grant = self
                .image_manager
                .grant_managed_access(project_id, &digest)
                .await
                .map_err(|error| format!("Toolchain image {digest}: {error}"))?;
            images.push(ManagedImageGrant {
                role: ManagedImageRole::Toolchain,
                digest,
                path: grant.path,
                token: grant.token,
                target: Some(toolchain.target.clone()),
            });
        }

        let row = crate::db::SessionManagedContextRow {
            session_id,
            agent_id: agent_id.to_string(),
            project_id: project_id.to_string(),
            attempt_id: attempt_id.to_string(),
            base_digest,
            workspace_digest,
            toolchains: request.toolchains.clone(),
            source_sha: workspace.source_sha,
            workspace: None,
            status: "preparing".to_string(),
            error: None,
            updated_at: chrono::Utc::now().timestamp(),
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
