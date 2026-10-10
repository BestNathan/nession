//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::*;

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

        // `env_refs` came out of the parsed payload above — the create-time
        // injection selection.
        let env_snapshots = if env_refs.is_empty() {
            Vec::new()
        } else {
            match self.resolve_snapshots(agent_id, &env_refs).await {
                Ok(s) => s,
                Err(e) => {
                    return Ok(session_create_reply(&msg.id, refusal(&e)));
                }
            }
        };

        info!(
            "Client requested session create on agent {}: name={}, env_files={}",
            agent_id,
            name,
            env_refs.len()
        );

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
                    "working_dir": working_dir,
                    "env_snapshots": env_snapshots,
                }),
            )
            .await;

        // Wait up to 30 seconds for agent response.
        // Increased from 10s to handle slow CI environments where tmux operations
        // and agent processing can take longer.
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(response)) => {
                let success = response
                    .get("success")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let session_id = if success {
                    let sid = format!("{agent_id}:{name}");
                    // Immediately register the session so it shows up in list
                    // and attach requests without waiting for the agent's
                    // SessionWatcher poll cycle.
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
                    };
                    self.session_registry.update_session(session_info).await;
                    self.broadcast_sessions().await;
                    // Record create-time env usage for visibility + in-use lock.
                    if !env_refs.is_empty() {
                        self.env_service.usage.record_create(&sid, &env_refs, None);
                    }
                    Some(sid)
                } else {
                    None
                };
                let error = response
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string);

                Ok(session_create_reply(
                    &msg.id,
                    ClientSessionCreateResponsePayload {
                        success,
                        session_id,
                        error,
                    },
                ))
            }
            Ok(Err(_)) => Ok(session_create_reply(&msg.id, refusal("Agent disconnected"))),
            Err(_) => Ok(session_create_reply(
                &msg.id,
                refusal("Timeout waiting for agent response"),
            )),
        }
    }
}
