//! The explicit Tool registry (`#3264`, `#3735`).
//!
//! One `ToolRegistry` is constructed at service startup. It owns list, lookup
//! and invocation; hosts do not edit the catalog. Registration is explicit and
//! duplicate names are rejected, so a Tool's identity cannot be shadowed by a
//! second module or an accidental double registration.
//!
//! Registration also enforces the Nession Tool contract: every Tool must
//! declare a real, typed `outputSchema`. A missing or placeholder schema is a
//! startup error, so no Tool can enter the Registry — and therefore
//! `tools/list`, the exporter or Pages — without one.

use std::collections::HashMap;
use std::sync::Arc;

use rmcp::model::Tool;
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{ToolContext, ToolHandler};

/// Why a registry could not be built.
#[derive(Debug, Clone, thiserror::Error)]
pub enum RegistryError {
    /// Two Tool modules claim the same MCP name.
    #[error("duplicate MCP Tool registration: `{0}` is registered more than once")]
    Duplicate(String),
    /// A Tool declared no output schema at all.
    #[error("MCP Tool `{0}` declares no outputSchema; every Nession Tool must provide one")]
    MissingOutputSchema(String),
    /// A Tool declared an empty or generic object placeholder.
    #[error("MCP Tool `{0}` declares a placeholder outputSchema: {1}")]
    InvalidOutputSchema(String, &'static str),
}

/// Why a declared output schema is not a contract.
///
/// The check is deliberately structural rather than a full JSON Schema
/// validation: it rejects exactly the shapes `#3735` forbids (an absent or
/// empty object, `{ "type": "object" }`, and fields that say nothing about
/// their value) without pretending to re-implement a schema validator in the
/// Registry.
fn output_schema_problem(schema: &Map<String, Value>) -> Option<&'static str> {
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return Some("the schema does not describe an object");
    }
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Some("the schema declares no named fields");
    };
    if properties.is_empty() {
        return Some("the schema declares no named fields");
    }
    for property in properties.values() {
        let Some(property) = property.as_object() else {
            return Some("a field is not a JSON Schema object");
        };
        let described = [
            "type",
            "$ref",
            "anyOf",
            "oneOf",
            "allOf",
            "enum",
            "properties",
            "items",
        ]
        .iter()
        .any(|key| property.contains_key(*key));
        if !described {
            return Some("a field declares no type or structure");
        }
    }
    None
}

/// The startup-built Tool catalog.
pub struct ToolRegistry {
    handlers: Vec<Arc<dyn ToolHandler>>,
    positions: HashMap<&'static str, usize>,
}

impl ToolRegistry {
    /// Build a registry from explicit registrations, rejecting duplicates and
    /// every Tool that does not declare a real typed output contract.
    pub fn build(
        handlers: impl IntoIterator<Item = Arc<dyn ToolHandler>>,
    ) -> Result<Self, RegistryError> {
        let handlers: Vec<_> = handlers.into_iter().collect();
        let mut positions = HashMap::with_capacity(handlers.len());
        for (position, handler) in handlers.iter().enumerate() {
            let name = handler.name();
            if positions.insert(name, position).is_some() {
                return Err(RegistryError::Duplicate(name.to_string()));
            }
            let output = handler.output_schema();
            if output.is_empty() {
                return Err(RegistryError::MissingOutputSchema(name.to_string()));
            }
            if let Some(problem) = output_schema_problem(&output) {
                return Err(RegistryError::InvalidOutputSchema(
                    name.to_string(),
                    problem,
                ));
            }
        }
        Ok(Self {
            handlers,
            positions,
        })
    }

    /// The advertised catalog, in registration order.
    pub fn list(&self) -> Vec<Tool> {
        self.handlers
            .iter()
            .map(|handler| handler.definition())
            .collect()
    }

    /// Whether a Tool name is registered.
    pub fn contains(&self, name: &str) -> bool {
        self.positions.contains_key(name)
    }

    /// Number of registered Tools.
    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    /// Whether the registry is empty (never true for a started service, but a
    /// useful invariant for the type).
    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }

    /// Invoke one registered Tool.
    ///
    /// An unknown name is a tool-level argument error, not a transport failure:
    /// the caller asked for a Tool that does not exist, and every hosting mode
    /// must answer the same way.
    pub async fn call(
        &self,
        context: &ToolContext,
        name: &str,
        arguments: Option<Map<String, Value>>,
    ) -> Result<Value, ToolError> {
        let Some(position) = self.positions.get(name) else {
            return Err(ToolError::invalid_argument(format!(
                "unknown tool `{name}`"
            )));
        };
        let Some(handler) = self.handlers.get(*position) else {
            return Err(ToolError::backend(
                "the Tool registry lost a handler after startup",
            ));
        };
        handler.call(context, arguments.unwrap_or_default()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::UnavailableNodeBackend;
    use crate::tool::schema_for;
    use async_trait::async_trait;
    use serde_json::json;

    #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct EchoOutput {
        /// What the fixture backend answered.
        echo: String,
    }

    struct Echo(&'static str);

    #[async_trait]
    impl ToolHandler for Echo {
        fn name(&self) -> &'static str {
            self.0
        }

        fn description(&self) -> &'static str {
            "echo"
        }

        fn input_schema(&self) -> Map<String, Value> {
            schema_for::<EmptyArgs>()
        }

        fn output_schema(&self) -> Map<String, Value> {
            schema_for::<EchoOutput>()
        }

        async fn call(
            &self,
            _context: &ToolContext,
            _arguments: Map<String, Value>,
        ) -> Result<Value, ToolError> {
            Ok(json!({ "echo": self.0 }))
        }
    }

    /// A Tool that declares no output contract at all.
    struct MissingOutput(&'static str);

    #[async_trait]
    impl ToolHandler for MissingOutput {
        fn name(&self) -> &'static str {
            self.0
        }

        fn description(&self) -> &'static str {
            "missing output"
        }

        fn input_schema(&self) -> Map<String, Value> {
            schema_for::<EmptyArgs>()
        }

        fn output_schema(&self) -> Map<String, Value> {
            Map::new()
        }

        async fn call(
            &self,
            _context: &ToolContext,
            _arguments: Map<String, Value>,
        ) -> Result<Value, ToolError> {
            Ok(json!({}))
        }
    }

    /// A Tool whose output schema is the forbidden generic placeholder.
    struct PlaceholderOutput(&'static str);

    #[async_trait]
    impl ToolHandler for PlaceholderOutput {
        fn name(&self) -> &'static str {
            self.0
        }

        fn description(&self) -> &'static str {
            "placeholder output"
        }

        fn input_schema(&self) -> Map<String, Value> {
            schema_for::<EmptyArgs>()
        }

        fn output_schema(&self) -> Map<String, Value> {
            json!({ "type": "object" })
                .as_object()
                .expect("object")
                .clone()
        }

        async fn call(
            &self,
            _context: &ToolContext,
            _arguments: Map<String, Value>,
        ) -> Result<Value, ToolError> {
            Ok(json!({}))
        }
    }

    #[derive(serde::Deserialize, schemars::JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct EmptyArgs {}

    fn context() -> ToolContext {
        use crate::backend::{ClusterBackend, UnavailableClusterBackend};
        let cluster: Arc<dyn ClusterBackend> =
            Arc::new(UnavailableClusterBackend::new("no server"));
        let node = Arc::new(UnavailableNodeBackend::new("no agent"));
        ToolContext::new(cluster, node)
    }

    #[test]
    fn duplicate_registration_is_rejected() {
        let error = match ToolRegistry::build([
            Arc::new(Echo("a")) as Arc<dyn ToolHandler>,
            Arc::new(Echo("a")) as Arc<dyn ToolHandler>,
        ]) {
            Ok(_) => panic!("duplicate registration must be refused"),
            Err(error) => error,
        };
        assert!(matches!(error, RegistryError::Duplicate(name) if name == "a"));
    }

    #[test]
    fn the_catalog_keeps_registration_order() {
        let registry = ToolRegistry::build([
            Arc::new(Echo("a")) as Arc<dyn ToolHandler>,
            Arc::new(Echo("b")) as Arc<dyn ToolHandler>,
        ])
        .expect("registry");
        let names: Vec<_> = registry.list().into_iter().map(|tool| tool.name).collect();
        assert_eq!(names, vec!["a", "b"]);
        assert_eq!(registry.len(), 2);
        assert!(registry.contains("a"));
        assert!(!registry.contains("c"));
    }

    #[test]
    fn the_advertised_definition_carries_both_typed_schemas() {
        let registry =
            ToolRegistry::build([Arc::new(Echo("a")) as Arc<dyn ToolHandler>]).expect("registry");
        let tool = registry.list().into_iter().next().expect("one tool");
        assert_eq!(tool.input_schema.get("type"), Some(&json!("object")));
        let output = tool.output_schema.expect("mandatory outputSchema");
        assert_eq!(output.get("type"), Some(&json!("object")));
        assert_eq!(
            output["properties"]["echo"]["description"],
            "What the fixture backend answered."
        );
    }

    #[test]
    fn a_tool_without_an_output_schema_cannot_register() {
        let error =
            match ToolRegistry::build([Arc::new(MissingOutput("a")) as Arc<dyn ToolHandler>]) {
                Ok(_) => panic!("a Tool without outputSchema must be refused"),
                Err(error) => error,
            };
        assert!(matches!(error, RegistryError::MissingOutputSchema(name) if name == "a"));
    }

    #[test]
    fn a_placeholder_output_schema_cannot_register() {
        let error =
            match ToolRegistry::build([Arc::new(PlaceholderOutput("a")) as Arc<dyn ToolHandler>]) {
                Ok(_) => panic!("a placeholder outputSchema must be refused"),
                Err(error) => error,
            };
        assert!(matches!(
            error,
            RegistryError::InvalidOutputSchema(name, "the schema declares no named fields")
                if name == "a"
        ));
    }

    #[tokio::test]
    async fn an_unknown_tool_is_an_argument_error() {
        let registry =
            ToolRegistry::build([Arc::new(Echo("a")) as Arc<dyn ToolHandler>]).expect("registry");
        let error = registry
            .call(&context(), "missing", None)
            .await
            .expect_err("unknown");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(error.message.contains("unknown tool"));
    }

    #[tokio::test]
    async fn a_registered_tool_is_invoked_with_its_arguments() {
        let registry =
            ToolRegistry::build([Arc::new(Echo("a")) as Arc<dyn ToolHandler>]).expect("registry");
        let reply = registry
            .call(
                &context(),
                "a",
                Some(json!({}).as_object().expect("object").clone()),
            )
            .await
            .expect("reply");
        assert_eq!(reply["echo"], "a");
    }
}
