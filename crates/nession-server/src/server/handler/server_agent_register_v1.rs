//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    current_timestamp, info, json, AgentInfo, AgentRegisterPayload, AgentStatus, ConnectionHandler,
    HandlerAction, Message, ProtocolMessage,
};

impl ConnectionHandler {
    pub(super) async fn handle_agent_register(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: AgentRegisterPayload = serde_json::from_value(msg.payload)?;

        // Empty server auth_token means no-auth mode: accept any agent
        let auth_ok = self.config.server_auth_token.is_empty()
            || payload.auth_token == self.config.server_auth_token;

        if !auth_ok {
            info!("Agent {} rejected: invalid auth token", payload.agent_id);
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.register",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "rejected",
                        "message": "Invalid auth token"
                    }
                })
                .to_string(),
            ))));
        }

        // Registration is a **state transition, not a rebind**: a connection
        // either has not registered yet or is already somebody. Re-registering
        // is refused rather than applied, because everything downstream keeps
        // one identity per connection — the broker holds the claimed agent, the
        // disconnect path releases exactly this id, and the frames in between
        // are authorized against it. A connection that registered `A` and then
        // `B` would leave the broker claiming `A` from a socket the handler
        // remembers as `B`, and `A` would keep a control channel nobody releases
        // (#960). An agent that wants to come back as somebody else opens a new
        // connection, which is what its own reconnect path does anyway.
        if let Some(bound) = &self.registered_agent_id {
            info!(
                "Agent {} rejected: {} is already registered as '{bound}'",
                payload.agent_id, self.connection_generation
            );
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.register",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "rejected",
                        "message": format!(
                            "This connection is already registered as agent '{bound}'. \
                             Registration is one-shot per connection; reconnect to \
                             register as a different agent."
                        )
                    }
                })
                .to_string(),
            ))));
        }

        // A manifest is required, not optional (`#678`).
        //
        // This is a **breaking upgrade**, chosen deliberately over supporting
        // manifest-less peers through explicit adapters. An agent that
        // advertises nothing is one this server cannot route for: every relay
        // decision below is made by asking the target's manifest whether it
        // carries a wire type, and a peer that has not spoken cannot answer.
        // Relaying to it unconditionally — what this did before — is guessing,
        // and guessing is the failure the whole design exists to remove.
        //
        // Refusing at registration rather than at the first relay is the
        // difference between an agent that never starts and one that connects,
        // looks healthy, and silently drops every request aimed at it.
        //
        // The field stays `Option` on the wire so this is a *clear rejection*
        // rather than a parse error: an old agent's payload deserializes, and
        // the answer it gets says why.
        let Some(protocol_manifest) = payload.protocol_manifest.clone() else {
            info!("Agent {} rejected: no protocol manifest", payload.agent_id);
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.register",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "rejected",
                        "message": "This agent advertised no protocol manifest. \
                                    This server routes only by manifest, so a peer \
                                    without one cannot be served — upgrade the agent."
                    }
                })
                .to_string(),
            ))));
        };

        let addresses = crate::registry::build_probed_addresses(
            payload.addresses.clone(),
            &payload.ip_address,
            payload.port,
            payload.connect_url.as_deref(),
        );
        info!(
            "Agent {} advertised {} P2P address(es)",
            payload.agent_id,
            addresses.len()
        );

        // Keep an existing display_name if it was manually set via Web UI
        // (survives agent restart). Otherwise use the agent's config value.
        let display_name = match self.agent_registry.get(&payload.agent_id).await {
            Some(existing) if existing.display_name.is_some() => {
                info!(
                    "Agent {} keeping existing display_name: {:?}",
                    payload.agent_id, existing.display_name
                );
                existing.display_name
            }
            _ => payload.display_name.clone(),
        };

        let agent_info = AgentInfo {
            agent_id: payload.agent_id.clone(),
            hostname: payload.hostname,
            ip_address: payload.ip_address,
            port: payload.port,
            display_name,
            connect_url: payload.connect_url.clone(),
            addresses,
            registered_at: chrono::Utc::now(),
            last_heartbeat: chrono::Utc::now(),
            status: AgentStatus::Online,
            metadata: payload.metadata,
            session_count: 0,
            active_sessions: 0,
            // What the agent says it can serve, taken from its own composition.
            // Always present: registration is refused without it, above. The
            // field stays `Option` because the *registry* can still hold an
            // agent that registered before this server was upgraded and has not
            // reconnected since — and for that straggler the relay gate refuses
            // rather than guesses.
            protocol_manifest: Some(protocol_manifest),
        };

        self.agent_registry.register(agent_info).await;
        // Binding *this connection* to the agent: from here on it is the
        // authority for every agent-originated message it carries, whatever
        // those payloads name (`authorized_agent_id`). The other half of
        // registration is the broker claim the websocket loop makes for it —
        // see `server/websocket.rs` on why ownership is keyed on the connection.
        self.registered_agent_id = Some(payload.agent_id.clone());

        // Clear any sessions left over from a previous agent instance.
        // On reconnect the agent's tmux state is fresh — the SessionWatcher
        // starts with empty prev_sessions and can only report currently-
        // existing sessions.  Stale entries from the prior run must be
        // removed here or they linger forever.
        let removed = self
            .session_registry
            .remove_by_agent(&payload.agent_id)
            .await;
        if !removed.is_empty() {
            info!(
                "Cleared {} stale session(s) for agent {} after re-registration: {:?}",
                removed.len(),
                payload.agent_id,
                removed
            );
            // Tell web clients the list shrank — otherwise their view keeps
            // showing sessions the registry no longer has.
            self.broadcast_sessions().await;
        }

        info!("Agent {} registered successfully", payload.agent_id);

        Ok(HandlerAction::Reply(Some(Message::Text(
            json!({
                "msg_type": "server.agent.register",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "status": "accepted",
                    "message": "Registration successful",
                    "heartbeat_interval_secs": self.config.heartbeat_interval_secs
                }
            })
            .to_string(),
        ))))
    }
}
