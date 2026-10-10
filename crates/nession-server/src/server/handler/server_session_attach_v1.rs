//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{json, info, warn, ConnectionHandler, ProtocolMessage, HandlerAction, Message, current_timestamp, AgentStatus, CredentialScope, P2pGrantPayload, EnvSnapshot, AddressStatus};

impl ConnectionHandler {
    /// Handle `server.session.attach` - returns P2P agent address or enters relay mode.
    ///
    /// In P2P mode, the response includes the agent's IP:port so the client can
    /// connect directly. In relay mode, the server opens a WebSocket to the agent
    /// and bidirectionally forwards terminal I/O.
    pub(super) async fn handle_client_session_attach(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.session.attach",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": "Not authenticated"
                    }
                })
                .to_string(),
            ))));
        }

        let session_id = msg
            .payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let preferred_mode = msg
            .payload
            .get("preferred_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("p2p");

        // Parse session_id as "agent_id:session_name"
        let (agent_id, session_name) = match session_id.split_once(':') {
            Some((aid, sname)) => (aid.to_string(), sname.to_string()),
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "server.session.attach",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": "Invalid session_id format. Expected 'agent_id:session_name'"
                        }
                    })
                    .to_string(),
                ))));
            }
        };

        // Look up the session in the registry
        let session = self.session_registry.get(session_id).await;
        if session.is_none() {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.session.attach",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": format!("Session '{}' not found", session_id)
                    }
                })
                .to_string(),
            ))));
        }

        // Look up the agent
        let agent = self.agent_registry.get(&agent_id).await;
        let agent = match agent {
            Some(a) if a.status == AgentStatus::Online => a,
            Some(_) => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "server.session.attach",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": format!("Agent '{}' is offline", agent_id)
                        }
                    })
                    .to_string(),
                ))));
            }
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "server.session.attach",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": format!("Agent '{}' not found or offline", agent_id)
                        }
                    })
                    .to_string(),
                ))));
            }
        };

        // Legacy single endpoint for old clients: prefer a tunnel, then any
        // reachable address, then the first. Falls back to the constructed
        // URL when the agent advertised no addresses at all.
        let agent_ws_url = crate::registry::legacy_agent_address(&agent.addresses)
            .or_else(|| agent.connect_url.clone())
            .unwrap_or_else(|| format!("ws://{}:{}/ws", agent.ip_address, agent.port));
        let agent_address = agent_ws_url.clone();

        // Mint the credential, and hand it to the agent that will **verify** it
        // before the client that will **present** it is told the token (#1013).
        //
        // That ordering is the whole design. A client dials the agent the
        // instant it holds a token, so a grant that had not arrived yet would
        // refuse a legitimate attach — a race the client cannot detect and the
        // user cannot act on. Awaiting the acknowledgement first makes it
        // impossible rather than unlikely.
        let credential = self
            .p2p_broker
            .mint(
                &agent_id,
                session_id,
                &agent.ip_address,
                agent.port,
                CredentialScope::for_attach(&session_name),
            )
            .await;

        let grant = P2pGrantPayload {
            // The command transport injects the authoritative one.
            request_id: String::new(),
            credential: credential.token.clone(),
            agent_id: agent_id.clone(),
            session_id: session_id.to_string(),
            scope: credential.scope.clone(),
            expires_at: credential.expires_at.to_rfc3339(),
        };

        // Serialise the full probed-address list for multi-address clients.
        let addresses_json = serde_json::to_value(&agent.addresses).unwrap_or(json!([]));

        info!(
            "Client requested attach to session {} (mode: {}), agent at {} ({} address(es))",
            session_id,
            preferred_mode,
            agent_ws_url,
            agent.addresses.len()
        );

        if preferred_mode == "relay" {
            // Resolve env snapshots if provided in the attach request.
            let attach_env_snapshots: Vec<EnvSnapshot> = msg
                .payload
                .get("env_snapshots")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            if !attach_env_snapshots.is_empty() {
                info!(
                    "Relay attach with {} env snapshot(s) for session {}",
                    attach_env_snapshots.len(),
                    session_name
                );
            }

            // Honour a manually-selected relay address from the browser.
            let _manual_relay_url: Option<String> = msg
                .payload
                .get("relay_url")
                .and_then(|v| v.as_str())
                .map(str::to_string);

            // Build candidate URL list for the server to try when
            // connecting to the agent.  If the browser specified a
            // relay_url, use only that one.  Otherwise auto-select:
            // Reachable > Unknown > Unreachable > legacy fallback.
            let _relay_urls: Vec<String> = if let Some(ref url) = _manual_relay_url {
                info!(
                    "Relay mode: using manual URL {} for session {}",
                    url, session_name
                );
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
                    urls.push(agent_ws_url.clone());
                }
                info!(
                    "Relay mode: {} candidate URL(s) for agent {} (session {})",
                    urls.len(),
                    agent_id,
                    session_name
                );
                urls
            };

            let client_id = uuid::Uuid::new_v4().to_string();
            if let Some(ref sender) = self.client_sender {
                self.client_registry
                    .register(session_id, &client_id, sender.clone())
                    .await;
            } else {
                warn!(
                    "Client attach to session {} in relay mode but no client_sender set",
                    session_id
                );
            }
            self.attached_session_id = Some(session_id.to_string());
            self.attached_client_id = Some(client_id.clone());

            // Send attach response to browser BEFORE entering relay mode,
            // so the browser's requestAttach() resolves instead of timing out.
            if let Some(ref sender) = self.client_sender {
                let response = Message::Text(
                    serde_json::json!({
                        "msg_type": "server.session.attach",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "success",
                            "mode": "relay",
                            // Echo the requested session id: the response
                            // identifies which session it describes (the web
                            // client's SessionRuntime gate keys on it).
                            "session_id": session_id,
                            "session_name": session_name,
                            // Server TCP probe results — the browser shows these
                            // so the user can pick a specific relay endpoint.
                            "addresses": addresses_json,
                        }
                    })
                    .to_string(),
                );
                // The browser's `requestAttach()` is waiting on this frame, so
                // it goes out on the reply lane: `relay.begin` only arrives once
                // the Terminal is mounted, and until then there is nothing else
                // on this connection to answer it. A queue that is closed means
                // the browser is already gone, which `let _` here and nowhere
                // else.
                let _ = sender.send_reply(response).await;
            }

            // Phase 1 complete — relay info returned to browser.
            // The browser will send server.session.relay.begin when the
            // Terminal is mounted and ready to receive terminal output.
            // This avoids the race between server entering relay mode and
            // the browser subscribing to terminal.output.
            Ok(HandlerAction::Reply(None))
        } else {
            // The credential is handed to the client **only here**, so this is
            // the only branch that needs the agent to have been told (#1013).
            // The relay branch mints one too — it did before this change — but
            // nothing presents it until relay carries a credential of its own.
            // A credential the verifier never received can only fail later, in the
            // browser, with less to go on — so a refused grant fails the attach
            // here, where the reason is still in hand.
            if let Err(refusal) = self.grant_p2p_credential(&agent_id, &grant).await {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "server.session.attach",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": format!(
                                "Agent '{agent_id}' would not accept a P2P credential: {refusal}"
                            )
                        }
                    })
                    .to_string(),
                ))));
            }

            let connection_token = credential.token.clone();

            // P2P mode: return the full candidate list (with probe status) plus
            // the legacy single `agent_address` for backward compatibility. The
            // client tests latency across `addresses` and falls back per-address.
            Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.session.attach",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "success",
                        "mode": "p2p",
                        // Echo the requested session id: the response
                        // identifies which session it describes (the web
                        // client's SessionRuntime gate keys on it).
                        "session_id": session_id,
                        "agent_address": agent_address,
                        "addresses": addresses_json,
                        "connection_token": connection_token,
                        "session_name": session_name
                    }
                })
                .to_string(),
            ))))
        }
    }
}
