//! `claude-code.list` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::read::Scope;
use crate::protocol::v1_descriptor;

pub const WIRE: &str = "extension.claude_code.list";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct ListRequestV1 {
    #[serde(default)]
    pub scope: Scope,
    #[serde(default)]
    pub session_id: Option<String>,
}

/// One group of config files, as the view renders it.
///
/// Here rather than in `scanner` — which is where it was — for the reason the
/// git provider records: a shape the wire carries belongs to the contract, and
/// a generator asked "what shape is `claude-code.list`?" has to be able to
/// answer from the contract alone.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct ConfigCategory {
    pub name: String,
    pub icon: Option<String>,
    pub files: Vec<ConfigFile>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct ConfigFile {
    pub path: String,
    pub size: usize,
    pub content_type: String,
}

/// The listing, or the statement that there is nothing to list.
///
/// `available: false` with an empty list is this provider's answer for "that
/// directory does not exist" — an answer rather than an error, on the same
/// principle as git's `not_a_repository`. It is typed as two fields on one
/// struct rather than a variant because that is what ships; a discriminated
/// shape would be a contract change.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct ListResponseV1 {
    pub available: bool,
    pub categories: Vec<ConfigCategory>,
}

impl ListResponseV1 {
    pub fn unavailable() -> Self {
        Self {
            available: false,
            categories: Vec::new(),
        }
    }

    pub fn listing(categories: Vec<ConfigCategory>) -> Self {
        Self {
            available: true,
            categories,
        }
    }
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_scope_defaults_to_global_and_is_typed() {
        let request: ListRequestV1 = serde_json::from_value(json!({})).unwrap();
        assert_eq!(request.scope, Scope::Global);
        assert_eq!(request.session_id, None);
    }

    #[test]
    fn an_unavailable_directory_is_an_answer_with_an_empty_list() {
        // Not an error: "there is no .claude/ here" is a fact about the host.
        let value = serde_json::to_value(ListResponseV1::unavailable()).unwrap();
        assert_eq!(value, json!({"available": false, "categories": []}));
    }

    #[test]
    fn a_listing_serialises_its_categories() {
        let value = serde_json::to_value(ListResponseV1::listing(vec![ConfigCategory {
            name: "Settings".to_string(),
            icon: Some("settings".to_string()),
            files: Vec::new(),
        }]))
        .unwrap();
        assert_eq!(value["available"], true);
        assert_eq!(value["categories"][0]["name"], "Settings");
        assert_eq!(value["categories"][0]["icon"], "settings");
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "claude-code.list");
        assert_eq!(d.owner, "nession-claude-code");
        assert_eq!(
            d.contracts[0].wire,
            vec!["extension.claude_code.list".to_string()]
        );
        assert!(d.validate().is_ok());
    }
}
