//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{info, ConnectionHandler, ProtocolMessage, HandlerAction, ClientAuthPayload, auth_reply, AuthResponsePayload};

impl ConnectionHandler {
    pub(super) async fn handle_client_auth(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary, and the type is the Agent's
        // `client.auth` payload: a browser sends the same two fields to
        // whichever end it is talking to, so the two ends share one shape.
        //
        // An unreadable payload becomes an empty token rather than an error,
        // which is what the old field-by-field read did (`unwrap_or("")`): it
        // fails authentication except in no-auth mode, and that is the intended
        // behaviour for a malformed handshake.
        let payload: ClientAuthPayload =
            serde_json::from_value(msg.payload).unwrap_or(ClientAuthPayload {
                auth_token: String::new(),
                client_id: None,
            });

        // Empty server auth_token means no-auth mode: accept any client
        let auth_ok = self.config.server_auth_token.is_empty()
            || payload.auth_token == self.config.server_auth_token;

        if auth_ok {
            self.authenticated_client = true;
            // The browser's stable identity, kept for the relay to present to
            // the Agent (#1429) — see `browser_client_id`. The Server still
            // assigns no id of its own and reports none: this is the client's,
            // echoed back only by the Agent, and only for the connection the
            // relay opens on its behalf.
            self.browser_client_id = payload.client_id;
            // Subscribe web client for real-time push (server.agents.changed, etc.)
            if let Some(ref sender) = self.client_sender {
                self.web_client_registry.subscribe(sender.clone());
            }
            info!("Client authenticated successfully");

            Ok(auth_reply(
                &msg.id,
                AuthResponsePayload {
                    status: "success".to_string(),
                    message: "Authentication successful".to_string(),
                    // The Server assigns no client id and never did. The
                    // contract used to require one, which is why the field is
                    // optional now — this branch has nothing honest to put here.
                    client_id: None,
                },
            ))
        } else {
            info!("Client authentication failed");

            Ok(auth_reply(
                &msg.id,
                AuthResponsePayload {
                    status: "failed".to_string(),
                    message: "Invalid auth token".to_string(),
                    client_id: None,
                },
            ))
        }
    }
}
