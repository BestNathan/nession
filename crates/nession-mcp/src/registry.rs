//! The explicit Tool registry (`#3264`).
//!
//! One `ToolRegistry` is constructed at service startup. It owns list, lookup
//! and invocation; hosts do not edit the catalog. Registration is explicit and
//! duplicate names are rejected, so a Tool's identity cannot be shadowed by a
//! second module or an accidental double registration.

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
}

/// The startup-built Tool catalog.
pub struct ToolRegistry {
    handlers: Vec<Arc<dyn ToolHandler>>,
    positions: HashMap<&'static str, usize>,
}

impl ToolRegistry {
    /// Build a registry from explicit registrations, rejecting duplicates.
    pub fn build(
        handlers: impl IntoIterator<Item = Arc<dyn ToolHandler>>,
    ) -> Result<Self, RegistryError> {
        let handlers: Vec<_> = handlers.into_iter().collect();
        let mut positions = HashMap::with_capacity(handlers.len());
        for (position, handler) in handlers.iter().enumerate() {
            if positions.insert(handler.name(), position).is_some() {
                return Err(RegistryError::Duplicate(handler.name().to_string()));
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

        async fn call(
            &self,
            _context: &ToolContext,
            _arguments: Map<String, Value>,
        ) -> Result<Value, ToolError> {
            Ok(json!({ "echo": self.0 }))
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
