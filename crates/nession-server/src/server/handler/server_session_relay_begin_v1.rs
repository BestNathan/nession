//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::*;

impl ConnectionHandler {
    /// Handle `server.session.relay.begin` — Phase 2 of relay attach.
    ///
    /// Phase 1 (server.session.attach, relay mode) returned the candidate
    /// addresses but did NOT enter relay forwarding.  Now the Terminal is
    /// mounted and subscribed — the browser sends this to actually start
    /// the relay data flow.
    pub(super) async fn handle_client_session_relay_begin(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(relay_begin_reply(
                &msg.id,
                SessionRefusal {
                    status: "error".to_string(),
                    message: "Not authenticated".to_string(),
                },
            ));
        }

        // A payload that does not parse is treated as an unusable session id
        // rather than as a hard error, which is exactly what the field-by-field
        // read did (`unwrap_or("")`): it falls through to the "Invalid
        // session_id format" refusal below, the same way a missing `session_id`
        // always has. The literals restate the serde defaults so the two cannot
        // disagree.
        let payload: ClientRelayBeginPayload =
            serde_json::from_value(msg.payload).unwrap_or(ClientRelayBeginPayload {
                session_id: String::new(),
                relay_url: None,
                cols: 80,
                rows: 24,
                // Restates the serde default like the two above it: absent is
                // the old meaning, "these columns are the browser's own". The
                // literal is unreachable anyway — an unparseable payload has no
                // `session_id` to split, so it is refused before any attach.
                size_known: None,
                // An unparseable payload has no opinion to forward; the agent's
                // own rule is what a caller that says nothing already gets.
                needs_bootstrap: None,
            });

        let session_id = payload.session_id.as_str();
        let (agent_id, session_name) = match session_id.split_once(':') {
            Some((aid, sname)) => (aid.to_string(), sname.to_string()),
            None => {
                return Ok(relay_begin_reply(
                    &msg.id,
                    SessionRefusal {
                        status: "error".to_string(),
                        message: "Invalid session_id format".to_string(),
                    },
                ));
            }
        };

        let session = self.session_registry.get(session_id).await;
        if session.is_none() {
            return Ok(relay_begin_reply(
                &msg.id,
                SessionRefusal {
                    status: "error".to_string(),
                    message: format!("Session not found: {session_id}"),
                },
            ));
        }

        let agent = self.agent_registry.get(&agent_id).await;
        let agent = match agent {
            Some(a) if a.status == AgentStatus::Online => a,
            _ => {
                return Ok(relay_begin_reply(
                    &msg.id,
                    SessionRefusal {
                        status: "error".to_string(),
                        message: format!("Agent '{agent_id}' is offline"),
                    },
                ));
            }
        };

        // Manual relay URL override from the browser.
        let manual_relay_url: Option<String> = payload.relay_url.clone();

        // Build URL list: respect manual override, otherwise auto-select.
        let agent_ws_url = crate::registry::legacy_agent_address(&agent.addresses)
            .or_else(|| agent.connect_url.clone())
            .unwrap_or_else(|| format!("ws://{}:{}/ws", agent.ip_address, agent.port));

        let relay_urls: Vec<String> = if let Some(ref url) = manual_relay_url {
            vec![url.clone()]
        } else {
            let mut urls: Vec<String> = agent
                .addresses
                .iter()
                .filter(|p| p.status == AddressStatus::Reachable)
                .map(|p| p.address.url.clone())
                .chain(
                    agent
                        .addresses
                        .iter()
                        .filter(|p| p.status == AddressStatus::Unknown)
                        .map(|p| p.address.url.clone()),
                )
                .chain(
                    agent
                        .addresses
                        .iter()
                        .filter(|p| p.status == AddressStatus::Unreachable)
                        .map(|p| p.address.url.clone()),
                )
                .collect();
            if urls.is_empty() {
                urls.push(agent_ws_url);
            }
            urls
        };

        info!(
            "Relay begin: {} URL(s) for session '{}'",
            relay_urls.len(),
            session_name
        );

        // Mint the relay credential and hand it to the agent that will verify
        // it, **before any dial** (#1013). Same ordering as the p2p path, for
        // the same reason: the dial is what presents it.
        //
        // The credential rides **on the URLs** rather than beside them, and that
        // is what makes both relay dials work without knowing about it — the
        // attach dial iterates this list, and the detach dial reuses the one that
        // succeeded. A credential threaded alongside would have to reach both
        // sites and stay in step with them; this way there is one place it can
        // be forgotten, and it is here.
        let credential = self
            .p2p_broker
            .mint(
                &agent_id,
                session_id,
                &agent.ip_address,
                agent.port,
                CredentialScope::for_relay(&session_name),
            )
            .await;

        let grant = P2pGrantPayload {
            request_id: String::new(),
            credential: credential.token.clone(),
            agent_id: agent_id.clone(),
            session_id: session_id.to_string(),
            scope: credential.scope.clone(),
            expires_at: credential.expires_at.to_rfc3339(),
        };

        if let Err(refusal) = self.grant_p2p_credential(&agent_id, &grant).await {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.session.attach",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": format!(
                            "Agent '{agent_id}' would not accept a relay credential: {refusal}"
                        )
                    }
                })
                .to_string(),
            ))));
        }

        let relay_urls: Vec<String> = relay_urls
            .into_iter()
            .map(|url| agent_url_with_credential(&url, &credential.token))
            .collect();

        let client_id = uuid::Uuid::new_v4().to_string();
        if let Some(ref sender) = self.client_sender {
            self.client_registry
                .register(session_id, &client_id, sender.clone())
                .await;
        }
        self.attached_session_id = Some(session_id.to_string());
        self.attached_client_id = Some(client_id.clone());

        // No separate response — the server enters relay forwarding immediately.
        // terminal.output flows back through this WebSocket.

        // Terminal dimensions from the browser viewport (via ResizeObserver).
        // The 80×24 fallback for a browser that has not measured anything yet
        // lives on the type now, so a caller that omits them and a caller that
        // sends them cannot disagree about the default — and `size_known` is
        // what keeps that fallback from being *acted on* as if the browser had
        // chosen it (#1265).
        let cols = payload.cols;
        let rows = payload.rows;

        Ok(HandlerAction::Relay {
            agent_ws_urls: relay_urls,
            session_id: session_id.to_string(),
            session_name,
            client_id,
            browser_client_id: self.browser_client_id.clone(),
            env_snapshots: Vec::new(),
            cols,
            rows,
            size_known: payload.size_known,
            needs_bootstrap: payload.needs_bootstrap,
        })
    }
}
