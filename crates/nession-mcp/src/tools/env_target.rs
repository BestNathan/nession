//! Shared ENV source validation; the file's management owner is the Server.
use crate::error::ToolError;
use nession_protocol::contracts::env::v1::EnvSource;
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
}
