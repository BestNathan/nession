//! `git.log` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GitResponseV1, SessionTargetV1};

/// One commit, as the history view reads it.
///
/// `camelCase` for the same reason `ChangedFile` is: the client reads camelCase,
/// and a field named `short_hash` would arrive as `undefined` with nothing to
/// say so.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// Full object name.
    pub hash: String,
    /// Abbreviated, as git would print it.
    pub short_hash: String,
    pub author: String,
    /// git's own relative phrasing ("3 days ago"). Not re-derived here: the
    /// agent host's clock and the browser's are not the same clock, and a view
    /// that computed "3 days ago" from a timestamp would disagree with `git log`
    /// run in the Session beside it.
    pub relative_date: String,
    /// Committer date, ISO-8601 with the author's offset.
    pub date: String,
    /// First line of the commit message.
    pub subject: String,
    /// Decoration git would print — branch and tag names pointing here.
    pub refs: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub commits: Vec<Commit>,
    /// The count that was asked for, so the view can offer "more" honestly.
    pub limit: usize,
    /// Bytes the cap dropped. Non-zero means this is a prefix of the answer.
    pub truncated_bytes: usize,
    pub truncated: bool,
}

pub const WIRE: &str = "extension.git.log";

#[derive(Debug, Clone, Deserialize)]
pub struct LogRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// How many commits to return.
    ///
    /// A request, not a guarantee: the agent clamps it to
    /// `MAX_LOG_LIMIT` whatever arrives, and an unrepresentable number is
    /// treated as absent rather than wrapped by a cast.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogOkV1 {
    pub history: History,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type LogResponseV1 = GitResponseV1<LogOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limit_is_optional_and_a_request_rather_than_a_requirement() {
        let without: LogRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s"})).unwrap();
        assert_eq!(without.limit, None);

        let with: LogRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s", "limit": 10})).unwrap();
        assert_eq!(with.limit, Some(10));
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.log");
        assert_eq!(d.contracts[0].wire, vec!["extension.git.log".to_string()]);
        assert!(d.validate().is_ok());
    }
}
