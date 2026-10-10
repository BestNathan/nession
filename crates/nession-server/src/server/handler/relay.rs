//! Generic agent relay is runtime mechanism.
//! Route identity, version and execution policy are owned by routes.rs.

use super::*;

impl ConnectionHandler {
    /// Relay a message to the agent it names.
    ///
    /// Named for what it does rather than for what it used to recognise: the
    /// caller has already established that this target's manifest carries the
    /// wire, and nothing here inspects the message type beyond using it as the
    /// lookup key and echoing it back. Whether the far side implements it with
    /// a plugin is not visible from here and does not need to be.
    ///
    /// Uses agent_command() which injects request_id into the payload so the agent
    /// can correlate its response via server.agent.command-response.
    pub(super) async fn handle_relayed_message(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // The pipeline's first step (`#678`), and the one that was missing
        // until `#877`.
        //
        // **Before the payload is read, deliberately.** Everything below this
        // point answers differently depending on which agent was named — a
        // target that does not exist and a target that exists but does not
        // advertise the unit are both `contract_not_supported`, with different
        // text. An unauthenticated caller must not be able to tell those apart,
        // so the refusal cannot consult the payload at all: it is the same
        // answer for every request, which is also the answer that tells the
        // caller nothing about the fleet.
        //
        // Every other client-facing handler in this file has had this gate all
        // along; the relay reaches further than any of them — it crosses into
        // another machine and can read that machine's repositories and
        // `~/.claude/` — and was the one path that did not check.
        //
        // `server.auth` sets `authenticated_client` (see `handle_client_auth`),
        // and the Web sends it as a handshake before the socket is usable, so
        // nothing that works today stops working.
        if !self.authenticated_client {
            warn!(
                "Rejected unauthenticated relayed request `{}` id={}",
                msg.msg_type, msg.id
            );
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": msg.msg_type,
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "error": "not_authenticated",
                        "available": false,
                        "message": "this connection has not authenticated; send `client.auth` first",
                    },
                })
                .to_string(),
            ))));
        }

        let agent_id = msg
            .payload
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if agent_id.is_empty() {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": msg.msg_type,
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "error": "missing agent_id",
                        "available": false,
                    }
                })
                .to_string(),
            ))));
        }

        // The reply travels under the request's own wire name — one wire per
        // operation, correlated by the envelope's `id`. It used to be
        // `<wire>.response`, and the client had to know both names to hear an
        // answer to one call.
        let reply_wire = msg.msg_type.as_str();

        // Does the target say it can carry this? (`#678`)
        //
        // The pipeline's "verify target manifest supports contract" step, and
        // the first thing that consults the manifest an agent advertised.
        //
        // A target with **no** manifest is refused, not relayed. Registration
        // already turns away an agent that advertises nothing, so reaching this
        // means a straggler: one that registered before this server was
        // upgraded and has not reconnected since. Relaying to it would be
        // guessing at a shape nobody declared — the thing the manifest exists
        // to stop — and the guess would be invisible, because the relay would
        // look exactly like a working one.
        //
        // Refusing here is a *unit-scoped* answer, not a connection-level one —
        // the design is explicit that a unit with no intersection disables that
        // unit and does not take the connection with it. The client gets a
        // response correlated to its own request id and everything else on the
        // socket is untouched.
        let Some(manifest) = self
            .agent_registry
            .get(agent_id)
            .await
            .and_then(|agent| agent.protocol_manifest)
        else {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": reply_wire,
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "error": "contract_not_supported",
                        "available": false,
                        // Names the fix: the agent has to come back with a
                        // manifest, which means an upgrade, not a retry.
                        "message": format!(
                            "`{agent_id}` advertised no protocol manifest, so this server \
                             will not route `{}` to it. It predates manifests — upgrade it.",
                            msg.msg_type
                        ),
                    },
                })
                .to_string(),
            ))));
        };

        let Some(unit) = manifest.unit_for_wire(&msg.msg_type) else {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": reply_wire,
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "error": "contract_not_supported",
                        "available": false,
                        "message": format!(
                            "`{}` does not advertise `{}`",
                            agent_id, msg.msg_type
                        ),
                    },
                })
                .to_string(),
            ))));
        };

        // If the caller named a contract version, the target must offer it.
        //
        // A caller that names one has already resolved — it read the manifest
        // this server serves and picked a version. Refusing here is not a
        // second negotiation; it is checking that the manifest the caller
        // resolved against is still the one the target advertises, which is the
        // "target manifest stale" case the design lists.
        //
        // No version named means the caller has not resolved, and it relays as
        // it always did. Absence is not a claim about versions any more than it
        // is about wire types.
        if let Some(named) = msg.payload.get("contract_version").and_then(Value::as_u64) {
            let offered = manifest
                .support(unit)
                .map(|support| support.versions.clone())
                .unwrap_or_default();
            let known = offered.iter().any(|v| u64::from(v.get()) == named);
            if !known {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": reply_wire,
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "error": "contract_not_supported",
                            "available": false,
                            // Both sides, so a reader can see who has to move
                            // rather than only that something did not line up.
                            "message": format!(
                                "`{agent_id}` offers `{unit}` at {offered:?}, not v{named}"
                            ),
                            "protocol": unit.as_str(),
                            "named_version": named,
                            "offered_versions": offered.iter().map(|v| v.get()).collect::<Vec<_>>(),
                        },
                    })
                    .to_string(),
                ))));
            }
        } else {
            // No version named. Refused **only when the target serves more than
            // one generation of this unit**, because that is the one case where
            // the silence is genuinely ambiguous: the caller could have meant
            // either, and nothing on the wire says which.
            //
            // Refusing everywhere was the alternative, and it is not a smaller
            // change — it is a different one. Every `agent.file.*`,
            // `agent.env.*` and `agent.session.*` call is unversioned today and
            // every one of those units is in the target's manifest, so a blanket
            // refusal refuses essentially all traffic. A unit with exactly one
            // version has only one thing an unversioned call can mean; refusing
            // that would break every caller while catching nothing.
            //
            // So the rule is the ambiguity, not the absence. `#963` Scope 2's
            // literal wording asks for the second; this is the first, chosen
            // because it targets the failure that scope names — a manifest-backed
            // operation whose version nobody checked — without the repository-wide
            // caller migration the literal reading implies.
            let offered = manifest
                .support(unit)
                .map(|support| support.versions.clone())
                .unwrap_or_default();
            if offered.len() > 1 {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": reply_wire,
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "error": "contract_not_supported",
                            "available": false,
                            "message": format!(
                                "`{agent_id}` serves `{unit}` at {offered:?}, so this call has \
                                 to name one — an unversioned request to a unit with more than \
                                 one generation does not say which"
                            ),
                            "protocol": unit.as_str(),
                            "offered_versions": offered.iter().map(|v| v.get()).collect::<Vec<_>>(),
                        },
                    })
                    .to_string(),
                ))));
            }
        }

        match self
            // not-protocol: the relay forwards the wire the client named, so the
            // id arrives as data. `agent_command` takes it as a parameter.
            .agent_command(agent_id, &msg.msg_type, msg.payload.clone())
            .await
        {
            Ok(response) => {
                // agent_command returns { request_id, command, result }.
                // Extract just the result for the client response.
                let result = response.get("result").cloned().unwrap_or(response);
                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": reply_wire,
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": result,
                    })
                    .to_string(),
                ))))
            }
            Err(e) => {
                warn!("Extension command failed for agent {}: {}", agent_id, e);
                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": reply_wire,
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": { "error": "agent_disconnected", "available": false },
                    })
                    .to_string(),
                ))))
            }
        }
    }
}
