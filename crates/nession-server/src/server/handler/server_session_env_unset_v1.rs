//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    session_env_reply, ClientSessionEnvResponsePayload, ClientSessionEnvUnsetPayload,
    ConnectionHandler, HandlerAction, ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.session.env.unset` — the pre-#170 per-file unset unit.
    ///
    /// **Compatibility adapter.** The files are removed from the Session's
    /// current desired selection and the remainder is materialized as one new
    /// revision. The removed file's *current* content is never read: cleanup is
    /// derived from what the binding materialized, not from a file that may
    /// have changed since.
    pub(super) async fn handle_client_session_env_unset(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(session_env_reply(
                &msg.id,
                "server.session.env.unset",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some("Not authenticated".to_string()),
                    warnings: Vec::new(),
                },
            ));
        }
        let Ok(ClientSessionEnvUnsetPayload {
            session_id,
            env_files,
        }) = serde_json::from_value(msg.payload)
        else {
            return Ok(session_env_reply(
                &msg.id,
                "server.session.env.unset",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some("session_id is required".to_string()),
                    warnings: Vec::new(),
                },
            ));
        };

        let refs = match self.env_service.bindings.get(&session_id).await {
            Ok(Some(record)) => record
                .profiles
                .into_iter()
                .map(|profile| profile.profile)
                .filter(|profile| {
                    !env_files
                        .iter()
                        .any(|removed| crate::env::binding::same_profile(profile, removed))
                })
                .collect::<Vec<_>>(),
            Ok(None) => Vec::new(),
            Err(e) => {
                return Ok(session_env_reply(
                    &msg.id,
                    "server.session.env.unset",
                    ClientSessionEnvResponsePayload {
                        success: false,
                        error: Some(format!("could not read the Session binding: {e:#}")),
                        warnings: Vec::new(),
                    },
                ))
            }
        };

        match self.set_session_binding(&session_id, &refs, "attach").await {
            Ok((warnings, error, _binding)) => Ok(session_env_reply(
                &msg.id,
                "server.session.env.unset",
                ClientSessionEnvResponsePayload {
                    success: error.is_none(),
                    error,
                    warnings,
                },
            )),
            Err(error) => Ok(session_env_reply(
                &msg.id,
                "server.session.env.unset",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some(error),
                    warnings: Vec::new(),
                },
            )),
        }
    }
}
