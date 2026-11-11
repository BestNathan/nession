//! The one-Tool contract (`#3264`).
//!
//! A Tool module owns its name, description, typed argument contract, emitted
//! JSON Schema and execution. The registry owns lookup; the MCP service owns
//! protocol lifecycle, transport, authentication, concurrency and deadlines.
//! A Tool never decides which host it runs in — it receives the
//! [`ToolContext`] the host built.

use std::sync::Arc;

use async_trait::async_trait;
use rmcp::model::Tool;
use serde_json::{Map, Value};

use crate::backend::{ClusterBackend, NodeBackend};
use crate::error::ToolError;

/// The semantic backends a Tool may use.
///
/// A Tool uses exactly the seam its semantic owner names: Server-owned
/// discovery reads [`ToolContext::cluster`], Agent-owned Session operations use
/// [`ToolContext::node`]. The same context is supplied by all three hosts;
/// only the backend bindings differ.
pub struct ToolContext {
    /// The Server-owned cluster view.
    pub cluster: Arc<dyn ClusterBackend>,
    /// The Agent-owned Session state for an explicitly named Agent.
    pub node: Arc<dyn NodeBackend>,
}

impl ToolContext {
    /// Build a context from the host's backends.
    pub fn new(cluster: Arc<dyn ClusterBackend>, node: Arc<dyn NodeBackend>) -> Self {
        Self { cluster, node }
    }
}

/// One registered MCP Tool.
#[async_trait]
pub trait ToolHandler: Send + Sync {
    /// The exact MCP Tool name and Rust module stem.
    fn name(&self) -> &'static str;

    /// What the Tool answers and which owner it belongs to.
    fn description(&self) -> &'static str;

    /// The JSON Schema emitted for its typed argument contract.
    fn input_schema(&self) -> Map<String, Value>;

    /// Validate the arguments, execute the business operation and return the
    /// owner's reply.
    ///
    /// Invalid arguments are [`ToolError::InvalidArgument`]; they are a tool
    /// result, not a JSON-RPC transport failure, so the caller sees the same
    /// structured error in every hosting mode.
    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError>;

    /// The `tools/list` definition.
    fn definition(&self) -> Tool {
        Tool::new(self.name(), self.description(), self.input_schema())
    }
}

/// Turn a typed argument contract into the emitted input schema.
///
/// The schema and the runtime validation come from the same `serde` type, so
/// they cannot drift: `deny_unknown_fields` becomes `additionalProperties:
/// false`, and a rejected field is rejected by both.
pub fn schema_for<T: schemars::JsonSchema>() -> Map<String, Value> {
    let schema = schemars::schema_for!(T);
    // A `schemars::Schema` has no value shape that fails JSON serialization;
    // the empty-object fallback keeps the function total, and the contract
    // tests assert the emitted schema on a real typed fixture.
    let value = serde_json::to_value(schema).unwrap_or(Value::Null);
    let mut map = match value {
        Value::Object(map) => map,
        _ => return Map::new(),
    };
    // MCP's `inputSchema` is the argument contract itself; these two JSON
    // Schema document keys carry no meaning for a Tool caller.
    map.remove("$schema");
    map.remove("title");
    map
}

/// Deserialize typed arguments, reporting the same kind of failure the schema
/// would reject.
pub fn parse_arguments<T>(arguments: Map<String, Value>) -> Result<T, ToolError>
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_value(Value::Object(arguments))
        .map_err(|error| ToolError::invalid_argument(error.to_string()))
}

/// Whether a delivered business reply represents a refusal.
///
/// Three established reply conventions exist in this tree (`status: error`,
/// `success: false`, and a top-level `error`). The check is intentionally
/// shape-based: it classifies a refusal from any existing owner without every
/// host adapter inventing its own mapping.
pub fn reply_is_error(value: &Value) -> bool {
    if value.get("success").and_then(Value::as_bool) == Some(false) {
        return true;
    }
    if value.get("status").and_then(Value::as_str) == Some("error") {
        return true;
    }
    match value.get("error") {
        Some(Value::Null) | None => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// Refuse an empty identity string.
///
/// JSON Schema cannot state "non-empty" portably, and an empty `agent_id` must
/// never be interpreted as "the local host" — so every identity string is
/// checked here, next to the typed contract.
pub fn non_empty(value: &str, field: &str) -> Result<(), ToolError> {
    if value.trim().is_empty() {
        return Err(ToolError::invalid_argument(format!(
            "`{field}` must be a non-empty string"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct Fixture {
        name: String,
        #[serde(default)]
        working_dir: Option<String>,
    }

    #[test]
    fn the_emitted_schema_and_the_typed_parser_agree() {
        let schema = schema_for::<Fixture>();
        assert_eq!(schema.get("type"), Some(&Value::String("object".into())));
        assert_eq!(
            schema.get("additionalProperties"),
            Some(&Value::Bool(false)),
            "deny_unknown_fields must reach the emitted schema"
        );
        let required = schema
            .get("required")
            .and_then(Value::as_array)
            .expect("required");
        assert_eq!(required, &vec![Value::String("name".into())]);

        let valid = serde_json::json!({ "name": "work" });
        let parsed = parse_arguments::<Fixture>(valid.as_object().unwrap().clone())
            .expect("valid arguments");
        assert_eq!(parsed.name, "work");
        assert!(parsed.working_dir.is_none());

        let unknown = serde_json::json!({ "name": "work", "extra": true });
        let error = parse_arguments::<Fixture>(unknown.as_object().unwrap().clone())
            .expect_err("an unexpected key must be refused");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
    }
}
