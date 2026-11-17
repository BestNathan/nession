//! The composed MCP Tool catalog (`#3778`).
//!
//! The baseline Tools and every Extension contribution form **one immutable
//! generation**. A generation is built in full — each provider is asked for
//! its Tools, every name is checked for a single semantic owner, and the
//! combined list is validated by [`ToolRegistry::build`] — before it becomes
//! visible. A successful explicit reconfiguration atomically swaps in the new
//! generation and advances its monotonic revision; a rejected update leaves
//! the previous generation exactly as it was.
//!
//! [`McpCatalog::snapshot`] is the only read path. The service takes one
//! snapshot per request, so `tools/list` and `tools/call` never re-enumerate a
//! provider and one request cannot observe a half-composed catalog. An
//! in-flight call keeps executing the generation it started on while a later
//! request sees the swapped one.
//!
//! Reconfiguration is explicit and host-owned: extension install/enable/
//! disable/reconfigure or a capability-manifest update. Live runtime state —
//! a Session being created, an Extension switching between idle and busy, a
//! temporary disconnect — is not a catalog event.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use rmcp::model::Tool;
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::provider::McpToolProvider;
use crate::registry::{RegistryError, ToolRegistry};
use crate::tool::{ToolContext, ToolHandler};

/// The owner label for the Tools every host advertises.
const BASELINE_OWNER: &str = "the baseline catalog";

/// The first generation a catalog publishes.
const FIRST_REVISION: u64 = 1;

/// Why a catalog generation could not be built.
#[derive(Debug, Clone, thiserror::Error)]
pub enum CatalogError {
    /// A provider could not enumerate its contributions.
    #[error("MCP Tool provider `{provider}` could not contribute its Tools: {message}")]
    Provider {
        /// The provider's stable identity.
        provider: String,
        /// Why it refused.
        message: String,
    },
    /// Two owners claim the same MCP Tool name.
    #[error(
        "MCP Tool `{name}` is claimed by multiple owners ({owners}); one Tool name must have one \
         semantic owner"
    )]
    NameConflict {
        /// The contested Tool name.
        name: String,
        /// The owners that claim it, in composition order.
        owners: String,
    },
    /// The combined list violates the Tool contract.
    #[error(transparent)]
    Registry(#[from] RegistryError),
}

/// One immutable generation of the advertised Tool catalog.
pub struct CatalogSnapshot {
    revision: u64,
    registry: ToolRegistry,
}

impl CatalogSnapshot {
    /// The generation number, starting at 1 and advancing on each successful
    /// explicit reconfiguration.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// The advertised `tools/list` definitions, in generation order.
    pub fn tools(&self) -> Vec<Tool> {
        self.registry.list()
    }

    /// Invoke one Tool from this generation.
    pub async fn call(
        &self,
        context: &ToolContext,
        name: &str,
        arguments: Option<Map<String, Value>>,
    ) -> Result<Value, ToolError> {
        self.registry.call(context, name, arguments).await
    }
}

/// The host-owned catalog: the baseline Tools plus explicitly composed
/// Extension contributions.
pub struct McpCatalog {
    baseline: Vec<Arc<dyn ToolHandler>>,
    current: RwLock<Arc<CatalogSnapshot>>,
    /// Serializes reconfigurations so two explicit updates cannot build the
    /// same revision or interleave their swaps.
    update: Mutex<()>,
}

impl McpCatalog {
    /// A catalog with the baseline Tools only.
    pub fn baseline() -> Result<Self, CatalogError> {
        Self::with_providers(&[])
    }

    /// A catalog composed from the baseline Tools plus the given providers.
    ///
    /// The providers are enumerated exactly once, here. Their Tools follow the
    /// baseline in composition order.
    pub fn with_providers(providers: &[Arc<dyn McpToolProvider>]) -> Result<Self, CatalogError> {
        let baseline = crate::tools::baseline_handlers();
        let snapshot = build_snapshot(&baseline, providers, FIRST_REVISION)?;
        Ok(Self {
            baseline,
            current: RwLock::new(Arc::new(snapshot)),
            update: Mutex::new(()),
        })
    }

    /// The current generation.
    pub fn snapshot(&self) -> Arc<CatalogSnapshot> {
        let current = match self.current.read() {
            Ok(current) => current,
            Err(poisoned) => poisoned.into_inner(),
        };
        Arc::clone(&current)
    }

    /// The current generation number.
    pub fn revision(&self) -> u64 {
        self.snapshot().revision()
    }

    /// Build and validate a candidate generation, then atomically swap it in.
    ///
    /// This is the **only** way the advertised catalog changes. Provider
    /// enumeration, duplicate-owner detection and schema validation all run
    /// on the candidate first; any failure returns the error and leaves the
    /// current generation untouched.
    pub fn reconfigure(
        &self,
        providers: &[Arc<dyn McpToolProvider>],
    ) -> Result<Arc<CatalogSnapshot>, CatalogError> {
        let _update = match self.update.lock() {
            Ok(update) => update,
            Err(poisoned) => poisoned.into_inner(),
        };
        let revision = self.snapshot().revision().saturating_add(1);
        let snapshot = Arc::new(build_snapshot(&self.baseline, providers, revision)?);
        let mut current = match self.current.write() {
            Ok(current) => current,
            Err(poisoned) => poisoned.into_inner(),
        };
        *current = Arc::clone(&snapshot);
        Ok(snapshot)
    }
}

fn build_snapshot(
    baseline: &[Arc<dyn ToolHandler>],
    providers: &[Arc<dyn McpToolProvider>],
    revision: u64,
) -> Result<CatalogSnapshot, CatalogError> {
    let handlers = collect_handlers(baseline, providers)?;
    let registry = ToolRegistry::build(handlers)?;
    Ok(CatalogSnapshot { revision, registry })
}

/// Gather the baseline and every provider contribution, enforcing one
/// semantic owner per Tool name before the Registry sees the list.
fn collect_handlers(
    baseline: &[Arc<dyn ToolHandler>],
    providers: &[Arc<dyn McpToolProvider>],
) -> Result<Vec<Arc<dyn ToolHandler>>, CatalogError> {
    let mut owners: HashMap<&'static str, String> = HashMap::new();
    let mut handlers = Vec::new();
    for handler in baseline {
        owners.insert(handler.name(), BASELINE_OWNER.to_string());
        handlers.push(Arc::clone(handler));
    }
    for provider in providers {
        let provider_name = provider.provider_name();
        let tools = provider.tools().map_err(|error| CatalogError::Provider {
            provider: provider_name.to_string(),
            message: error.to_string(),
        })?;
        for tool in tools {
            let name = tool.name();
            if let Some(existing) = owners.get(name) {
                return Err(CatalogError::NameConflict {
                    name: name.to_string(),
                    owners: format!("{existing} and provider `{provider_name}`"),
                });
            }
            owners.insert(name, format!("provider `{provider_name}`"));
            handlers.push(tool);
        }
    }
    Ok(handlers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ToolProviderError;
    use crate::tool::{parse_arguments, reply_value, schema_for};
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(serde::Serialize, schemars::JsonSchema)]
    struct EchoOutput {
        /// The message the Tool echoed.
        message: String,
        /// The provider that answered.
        provider: String,
    }

    #[derive(serde::Deserialize, schemars::JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct EchoInput {
        /// The message to echo.
        message: String,
    }

    struct EchoTool(&'static str);

    #[async_trait]
    impl ToolHandler for EchoTool {
        fn name(&self) -> &'static str {
            self.0
        }

        fn description(&self) -> &'static str {
            "echo one message"
        }

        fn input_schema(&self) -> Map<String, Value> {
            schema_for::<EchoInput>()
        }

        fn output_schema(&self) -> Map<String, Value> {
            schema_for::<EchoOutput>()
        }

        async fn call(
            &self,
            _context: &ToolContext,
            arguments: Map<String, Value>,
        ) -> Result<Value, ToolError> {
            let input = parse_arguments::<EchoInput>(arguments)?;
            reply_value(&EchoOutput {
                message: input.message,
                provider: "fixture".to_string(),
            })
        }
    }

    /// A Tool with no output contract at all.
    struct UntypedTool(&'static str);

    #[async_trait]
    impl ToolHandler for UntypedTool {
        fn name(&self) -> &'static str {
            self.0
        }

        fn description(&self) -> &'static str {
            "untyped"
        }

        fn input_schema(&self) -> Map<String, Value> {
            schema_for::<EchoInput>()
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

    struct FixtureProvider {
        name: &'static str,
        tools: Vec<Arc<dyn ToolHandler>>,
        enumerations: AtomicUsize,
    }

    impl FixtureProvider {
        fn new(name: &'static str, tools: Vec<Arc<dyn ToolHandler>>) -> Arc<Self> {
            Arc::new(Self {
                name,
                tools,
                enumerations: AtomicUsize::new(0),
            })
        }

        fn enumerations(&self) -> usize {
            self.enumerations.load(Ordering::SeqCst)
        }
    }

    impl McpToolProvider for FixtureProvider {
        fn provider_name(&self) -> &str {
            self.name
        }

        fn tools(&self) -> Result<Vec<Arc<dyn ToolHandler>>, ToolProviderError> {
            self.enumerations.fetch_add(1, Ordering::SeqCst);
            Ok(self.tools.clone())
        }
    }

    struct FailingProvider;

    impl McpToolProvider for FailingProvider {
        fn provider_name(&self) -> &str {
            "failing"
        }

        fn tools(&self) -> Result<Vec<Arc<dyn ToolHandler>>, ToolProviderError> {
            Err(ToolProviderError::new("the Extension is not installed"))
        }
    }

    fn echo(name: &'static str) -> Arc<dyn ToolHandler> {
        Arc::new(EchoTool(name))
    }

    fn provider_of_one(name: &'static str, tool: &'static str) -> Arc<FixtureProvider> {
        FixtureProvider::new(name, vec![echo(tool)])
    }

    fn context() -> ToolContext {
        use crate::backend::{ClusterBackend, UnavailableClusterBackend, UnavailableNodeBackend};
        let cluster: Arc<dyn ClusterBackend> =
            Arc::new(UnavailableClusterBackend::new("no server"));
        ToolContext::new(cluster, Arc::new(UnavailableNodeBackend::new("no agent")))
    }

    fn names(snapshot: &CatalogSnapshot) -> Vec<String> {
        snapshot
            .tools()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect()
    }

    #[test]
    fn the_baseline_generation_keeps_the_existing_tools_and_contracts() {
        let catalog = McpCatalog::baseline().expect("baseline catalog");
        let snapshot = catalog.snapshot();
        assert_eq!(snapshot.revision(), FIRST_REVISION);

        let baseline = crate::tools::registry().expect("baseline registry");
        let expected: Vec<Value> = baseline
            .list()
            .iter()
            .map(|tool| serde_json::to_value(tool).expect("serialized Tool"))
            .collect();
        let actual: Vec<Value> = snapshot
            .tools()
            .iter()
            .map(|tool| serde_json::to_value(tool).expect("serialized Tool"))
            .collect();
        assert_eq!(actual, expected, "the baseline catalog must not drift");
        assert_eq!(names(&snapshot), crate::tools::TOOL_NAMES);
    }

    #[test]
    fn a_provider_appends_its_typed_tools_after_the_baseline() {
        let provider = provider_of_one("fixtures", "fixture_echo");
        let catalog = McpCatalog::with_providers(&[provider.clone() as Arc<dyn McpToolProvider>])
            .expect("catalog");
        let snapshot = catalog.snapshot();

        let mut expected = crate::tools::TOOL_NAMES.to_vec();
        expected.push("fixture_echo");
        assert_eq!(names(&snapshot), expected);

        let tool = snapshot
            .tools()
            .into_iter()
            .find(|tool| tool.name == "fixture_echo")
            .expect("contributed Tool");
        assert_eq!(tool.description.as_deref(), Some("echo one message"));
        assert_eq!(tool.input_schema.get("type"), Some(&json!("object")));
        assert_eq!(
            tool.input_schema["properties"]["message"]["description"],
            "The message to echo."
        );
        let output = tool.output_schema.expect("typed output schema");
        assert_eq!(
            output["properties"]["provider"]["description"],
            "The provider that answered."
        );
        assert_eq!(provider.enumerations(), 1);
    }

    #[tokio::test]
    async fn a_contributed_tool_validates_its_arguments_and_stable_reply() {
        let provider = provider_of_one("fixtures", "fixture_echo");
        let catalog = McpCatalog::with_providers(&[provider]).expect("catalog");
        let snapshot = catalog.snapshot();

        let reply = snapshot
            .call(
                &context(),
                "fixture_echo",
                Some(json!({ "message": "hello" }).as_object().unwrap().clone()),
            )
            .await
            .expect("reply");
        assert_eq!(reply, json!({ "message": "hello", "provider": "fixture" }));

        let refusal = snapshot
            .call(
                &context(),
                "fixture_echo",
                Some(json!({ "wrong": "hello" }).as_object().unwrap().clone()),
            )
            .await;
        let error = refusal.expect_err("a contract mismatch must not execute");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
    }

    #[test]
    fn a_provider_name_cannot_shadow_a_baseline_tool() {
        let provider = provider_of_one("fixtures", "nession_server_list_agents");
        let error = match McpCatalog::with_providers(&[provider]) {
            Ok(_) => panic!("a baseline name must not be shadowed"),
            Err(error) => error,
        };
        match error {
            CatalogError::NameConflict { name, owners } => {
                assert_eq!(name, "nession_server_list_agents");
                assert!(owners.contains("baseline catalog"), "{owners}");
                assert!(owners.contains("provider `fixtures`"), "{owners}");
            }
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn two_providers_cannot_claim_one_name_with_different_contracts() {
        let first = provider_of_one("first", "fixture_echo");
        let second = provider_of_one("second", "fixture_echo");
        let error = match McpCatalog::with_providers(&[first, second]) {
            Ok(_) => panic!("a second owner must be refused even with the same schema"),
            Err(error) => error,
        };
        assert!(matches!(error, CatalogError::NameConflict { name, .. } if name == "fixture_echo"));
    }

    #[test]
    fn a_provider_without_a_typed_output_is_rejected() {
        let provider = FixtureProvider::new(
            "untyped",
            vec![Arc::new(UntypedTool("fixture_untyped")) as Arc<dyn ToolHandler>],
        );
        let error = match McpCatalog::with_providers(&[provider]) {
            Ok(_) => panic!("an untyped contribution must be refused"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            CatalogError::Registry(RegistryError::MissingOutputSchema(name))
                if name == "fixture_untyped"
        ));
    }

    #[test]
    fn a_failing_provider_is_reported_and_preserves_the_live_generation() {
        let catalog = McpCatalog::with_providers(&[provider_of_one("fixtures", "fixture_echo")])
            .expect("catalog");
        let before = catalog.snapshot();

        let error = match catalog.reconfigure(&[Arc::new(FailingProvider)]) {
            Ok(_) => panic!("a failing provider must not swap the catalog"),
            Err(error) => error,
        };
        assert!(matches!(error, CatalogError::Provider { provider, .. } if provider == "failing"));

        let after = catalog.snapshot();
        assert!(
            Arc::ptr_eq(&before, &after),
            "the generation must be reused"
        );
        assert_eq!(after.revision(), FIRST_REVISION);
        assert_eq!(names(&after), {
            let mut expected = crate::tools::TOOL_NAMES.to_vec();
            expected.push("fixture_echo");
            expected
        });
    }

    #[test]
    fn a_rejected_conflict_leaves_the_live_catalog_and_revision_untouched() {
        let catalog = McpCatalog::with_providers(&[provider_of_one("fixtures", "fixture_echo")])
            .expect("catalog");
        let before = catalog.snapshot();

        let error = match catalog.reconfigure(&[
            provider_of_one("fixtures", "fixture_echo"),
            provider_of_one("intruder", "fixture_echo"),
        ]) {
            Ok(_) => panic!("a conflicting regeneration must be refused"),
            Err(error) => error,
        };
        assert!(matches!(error, CatalogError::NameConflict { .. }));

        let after = catalog.snapshot();
        assert!(Arc::ptr_eq(&before, &after));
        assert_eq!(after.revision(), FIRST_REVISION);
    }

    #[test]
    fn an_explicit_reconfiguration_swaps_generations_atomically() {
        let catalog = McpCatalog::with_providers(&[provider_of_one("fixtures", "fixture_echo")])
            .expect("catalog");
        let first = catalog.snapshot();

        let second = catalog
            .reconfigure(&[
                provider_of_one("fixtures", "fixture_echo"),
                provider_of_one("extra", "fixture_extra"),
            ])
            .expect("reconfigured catalog");
        assert_eq!(second.revision(), FIRST_REVISION + 1);
        assert_eq!(catalog.revision(), FIRST_REVISION + 1);

        // The generation a request already took is immutable, so its view
        // cannot change under it when a later reconfiguration lands.
        assert!(!names(&first).contains(&"fixture_extra".to_string()));
        assert!(names(&second).contains(&"fixture_extra".to_string()));
        assert_eq!(first.revision(), FIRST_REVISION);
    }

    #[test]
    fn providers_are_enumerated_only_by_explicit_composition() {
        let provider = provider_of_one("fixtures", "fixture_echo");
        let catalog = McpCatalog::with_providers(&[provider.clone() as Arc<dyn McpToolProvider>])
            .expect("catalog");
        assert_eq!(provider.enumerations(), 1);

        for _ in 0..10 {
            let snapshot = catalog.snapshot();
            let _ = snapshot.tools();
            let _ = snapshot.revision();
        }
        assert_eq!(
            provider.enumerations(),
            1,
            "reading the catalog must not re-enumerate a provider"
        );

        catalog
            .reconfigure(&[provider.clone() as Arc<dyn McpToolProvider>])
            .expect("explicit reconfiguration");
        assert_eq!(provider.enumerations(), 2);
    }
}
