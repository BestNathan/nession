//! Shared ENV source and Session identity validation; the file's management
//! owner and the Session's binding owner are both the Server.
use crate::error::ToolError;
use nession_protocol::contracts::env::v1::{EnvFileRef, EnvSource};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Source {
    #[default]
    Server,
    Agent,
}

impl Source {
    /// The Server knows both sources. An Agent file must name its owning node;
    /// a Server file must not silently discard an irrelevant agent_id.
    pub(crate) fn resolve(
        self,
        agent_id: Option<&str>,
    ) -> Result<(EnvSource, Option<String>), ToolError> {
        match (self, agent_id) {
            (Self::Server, None) => Ok((EnvSource::Server, None)),
            (Self::Server, Some(_)) => Err(ToolError::invalid_argument(
                "`agent_id` is only valid when `source` is `agent`",
            )),
            (Self::Agent, Some(agent)) if !agent.trim().is_empty() => {
                Ok((EnvSource::Agent, Some(agent.to_string())))
            }
            (Self::Agent, _) => Err(ToolError::invalid_argument(
                "`agent_id` is required when `source` is `agent`",
            )),
        }
    }
}

/// Refuse a Session identity the Server would not resolve.
///
/// The canonical form is `agent_id:session_name`; the Server splits on the
/// first colon. An empty part is not a wildcard or "this host", so it is
/// rejected here rather than being sent as a lookup for a Session that cannot
/// exist.
pub(crate) fn canonical_session_id(session_id: &str) -> Result<(), ToolError> {
    let Some((agent_id, session_name)) = session_id.split_once(':') else {
        return Err(ToolError::invalid_argument(
            "`session_id` must be the canonical `agent_id:session_name` form",
        ));
    };
    if agent_id.trim().is_empty() || session_name.trim().is_empty() {
        return Err(ToolError::invalid_argument(
            "`session_id` must name both an Agent and a Session",
        ));
    }
    Ok(())
}

/// One profile argument as the canonical `EnvFileRef`.
///
/// The same source/`agent_id` rule as the single-file Tools: an Agent profile
/// names its owning node, and a Server profile must not carry a misleading
/// `agent_id`.
pub(crate) fn env_file_ref(
    name: String,
    source: Source,
    agent_id: Option<String>,
) -> Result<EnvFileRef, ToolError> {
    if name.trim().is_empty() {
        return Err(ToolError::invalid_argument(
            "every profile must have a non-empty `name`",
        ));
    }
    let (source, agent_id) = source.resolve(agent_id.as_deref())?;
    Ok(EnvFileRef {
        name,
        source,
        agent_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_never_falls_back_to_the_host() {
        assert!(Source::Agent.resolve(None).is_err());
        assert!(Source::Agent.resolve(Some(" ")).is_err());
        assert!(Source::Server.resolve(Some("a")).is_err());
        assert_eq!(
            Source::Agent.resolve(Some("a")).unwrap().1.as_deref(),
            Some("a")
        );
    }

    #[test]
    fn a_session_id_must_be_the_canonical_joined_identity() {
        canonical_session_id("agent-1:dev").expect("canonical identity");
        for invalid in ["", "agent-1", ":dev", "agent-1:", " : "] {
            assert!(canonical_session_id(invalid).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn a_profile_carries_its_own_source_identity() {
        let server = env_file_ref("common.env".into(), Source::Server, None).unwrap();
        assert_eq!(server.source, EnvSource::Server);
        assert!(server.agent_id.is_none());

        let agent = env_file_ref("dev.env".into(), Source::Agent, Some("a1".into())).unwrap();
        assert_eq!(agent.source, EnvSource::Agent);
        assert_eq!(agent.agent_id.as_deref(), Some("a1"));

        assert!(env_file_ref(" ".into(), Source::Server, None).is_err());
        assert!(env_file_ref("x.env".into(), Source::Agent, None).is_err());
        assert!(env_file_ref("x.env".into(), Source::Server, Some("a1".into())).is_err());
    }
}
