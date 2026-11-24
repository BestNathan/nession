//! The Server's validated Extension-contributed MCP Tool catalog (`#3778`).
//!
//! The Server owns **discovery and routing** for contributions, not their
//! semantics. Each Agent advertises a typed manifest on registration; this
//! module validates it, keeps the last valid set per Agent, and merges the
//! compatible Tools into the one catalog the Server's MCP endpoint advertises.
//! A call names `agent_id` explicitly and is brokered to exactly that Agent
//! over the canonical `agent.mcp.tool.call` unit.
//!
//! Validation is fail-closed:
//!
//! * an unsupported manifest version is refused;
//! * a name claimed with a different contract by two Agents is refused;
//! * a Tool without a required `agent_id` argument cannot be routed and is
//!   refused by the shared catalog;
//! * a refused update leaves the previous valid generation exactly in place.
//!
//! An Agent going offline does not remove its Tools: `tools/list` keeps
//! advertising the capability and `tools/call` answers the truth for the named
//! Agent. Removal is explicit (Agent deletion or a registration with no
//! manifest), never inferred from a transient disconnect.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use nession_mcp::provider::{McpToolContribution, McpToolProvider, ToolProviderError};
use nession_mcp::{CatalogError, McpCatalog, ToolError, ToolErrorKind};
use nession_protocol::contracts::mcp::v1::{McpToolCallReply, McpToolDescriptor, McpToolManifest};
use serde_json::{Map, Value};
use tokio::time::timeout;

use crate::registry::{AgentRegistry, AgentStatus};
use crate::server::command_broker::CommandBroker;

/// How long the Server waits for the owning Agent to answer one contribution
/// call. The MCP service applies its own outer deadline; this one must be at
/// least as generous so a slow owner is reported by its own lane, not raced.
const AGENT_TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(35);

/// Why an advertised manifest was refused.
#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    /// The Agent used a manifest contract version this Server cannot validate.
    #[error("MCP Tool manifest version {0} is not supported by this Server")]
    UnsupportedVersion(u32),
    /// Two Agents advertise one Tool name with different contracts.
    #[error(
        "MCP Tool `{name}` is advertised with different contracts by Agent `{agent}` and Agent \
         `{other}`; one Tool name must mean one contract across the fleet"
    )]
    Conflict {
        /// The contested Tool name.
        name: String,
        /// The Agent whose manifest was being installed.
        agent: String,
        /// The Agent already advertising a different contract.
        other: String,
    },
    /// The composed catalog rejected the candidate.
    #[error(transparent)]
    Catalog(#[from] CatalogError),
}

/// The Server's one owner of contribution manifests and their advertised
/// catalog.
pub struct ExtensionToolCatalog {
    agent_registry: Arc<AgentRegistry>,
    broker: Arc<CommandBroker>,
    catalog: Arc<McpCatalog>,
    manifests: RwLock<BTreeMap<String, McpToolManifest>>,
    /// Serializes explicit updates so a candidate is built, validated and
    /// swapped as one transition.
    update: Mutex<()>,
    /// The mounted MCP endpoint's list-change announcer, installed by
    /// `server::mcp::build` after the service exists (`#3778` P2). A
    /// successful explicit reconfigure calls it; nothing else does.
    notifier: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl ExtensionToolCatalog {
    /// A catalog with no contributions and the baseline MCP Tools.
    pub fn new(
        agent_registry: Arc<AgentRegistry>,
        broker: Arc<CommandBroker>,
    ) -> Result<Self, CatalogError> {
        Ok(Self {
            agent_registry,
            broker,
            catalog: Arc::new(McpCatalog::baseline()?),
            manifests: RwLock::new(BTreeMap::new()),
            update: Mutex::new(()),
            notifier: Mutex::new(None),
        })
    }

    /// Install the mounted endpoint's list-change announcer.
    ///
    /// Called once by `server::mcp::build` after both the catalog and the
    /// service exist. A later explicit manifest install/removal calls it so
    /// connected legacy sessions receive `notifications/tools/list_changed`.
    pub fn set_change_notifier(&self, notifier: Arc<dyn Fn() + Send + Sync>) {
        let mut installed = match self.notifier.lock() {
            Ok(installed) => installed,
            Err(poisoned) => poisoned.into_inner(),
        };
        *installed = Some(notifier);
    }

    /// The catalog the Server's MCP endpoint advertises.
    pub fn catalog(&self) -> Arc<McpCatalog> {
        Arc::clone(&self.catalog)
    }

    /// The merged, validated manifest every MCP facing host must reproduce.
    pub fn manifest(&self) -> McpToolManifest {
        self.catalog.manifest()
    }

    /// Install (`Some`) or clear (`None`) one Agent's advertised manifest.
    ///
    /// Validation and the catalog swap happen before the new manifest set is
    /// stored, so a refusal leaves both the live catalog and the stored set
    /// exactly as they were.
    pub fn set_manifest(
        &self,
        agent_id: &str,
        manifest: Option<McpToolManifest>,
    ) -> Result<(), ManifestError> {
        let _update = match self.update.lock() {
            Ok(update) => update,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut candidate = match self.manifests.read() {
            Ok(manifests) => manifests.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        let current = candidate.clone();
        match manifest {
            Some(manifest) => {
                if !manifest.is_supported() {
                    return Err(ManifestError::UnsupportedVersion(manifest.manifest_version));
                }
                candidate.insert(agent_id.to_string(), manifest);
            }
            None => {
                candidate.remove(agent_id);
            }
        }
        // A reconnect that advertises the same manifest is not a catalog
        // event: the generation and its revision stay put.
        if candidate == current {
            return Ok(());
        }
        validate_candidate(&candidate, agent_id)?;
        self.catalog
            .reconfigure(&[Arc::new(CandidateProvider {
                manifests: candidate.clone(),
            })])
            .map_err(ManifestError::Catalog)?;
        match self.manifests.write() {
            Ok(mut manifests) => *manifests = candidate,
            Err(poisoned) => *poisoned.into_inner() = candidate,
        }
        // Announce the new generation only after it is both advertised and
        // stored. This is an explicit manifest update — never a Session or
        // Extension runtime-state change.
        let notify = match self.notifier.lock() {
            Ok(notifier) => notifier.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        if let Some(notify) = notify {
            notify();
        }
        Ok(())
    }

    /// Route one contributed call to the Agent the caller named.
    pub async fn call(
        &self,
        agent_id: &str,
        tool: &str,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let manifest = match self.manifests.read() {
            Ok(manifests) => manifests.get(agent_id).cloned(),
            Err(poisoned) => poisoned.into_inner().get(agent_id).cloned(),
        };
        let Some(manifest) = manifest else {
            return Err(ToolError::not_found(format!(
                "Agent '{agent_id}' advertises no validated MCP Tool manifest"
            )));
        };
        if manifest.tool(tool).is_none() {
            return Err(ToolError::not_found(format!(
                "Agent '{agent_id}' does not advertise contributed Tool `{tool}`"
            )));
        }
        match self.agent_registry.get(agent_id).await {
            Some(agent) if agent.status == AgentStatus::Online => {}
            Some(agent) => {
                return Err(ToolError::unavailable(format!(
                    "Agent '{agent_id}' is {}",
                    agent_status(&agent.status)
                )))
            }
            None => {
                return Err(ToolError::not_found(format!(
                    "Agent '{agent_id}' is not in the registry"
                )))
            }
        }

        let request_id = uuid::Uuid::new_v4().to_string();
        let payload = serde_json::json!({
            "request_id": request_id,
            "agent_id": agent_id,
            "tool": tool,
            "arguments": Value::Object(arguments),
        });
        let receiver = self
            .broker
            .send_command(agent_id, "agent.mcp.tool.call", &request_id, payload)
            .await;
        let response = match timeout(AGENT_TOOL_CALL_TIMEOUT, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                return Err(ToolError::unavailable(format!(
                    "Agent '{agent_id}' disconnected before answering"
                )))
            }
            Err(_) => {
                // Same terminal outcome as the other command callers: the
                // caller's deadline removes the entry so a late reply cannot
                // resolve a request nobody is waiting for (#4434, SC-03).
                self.broker.expire_pending(agent_id, &request_id).await;
                return Err(ToolError::timeout(format!(
                    "Agent '{agent_id}' did not answer `{tool}` in time. The call may already have \
                     started or completed; inspect the target's state before retrying"
                )));
            }
        };
        let reply: McpToolCallReply = serde_json::from_value(response).map_err(|error| {
            ToolError::backend(format!(
                "Agent '{agent_id}' answered `{tool}` outside its typed contract: {error}"
            ))
        })?;
        if reply.success {
            return reply.result.ok_or_else(|| {
                ToolError::backend(format!(
                    "Agent '{agent_id}' reported success for `{tool}` without a result"
                ))
            });
        }
        let error =
            reply
                .error
                .unwrap_or_else(|| nession_protocol::contracts::mcp::v1::McpToolCallError {
                    kind: "backend".to_string(),
                    message: "the owning Agent refused the call without a reason".to_string(),
                });
        Err(ToolError::new(
            ToolErrorKind::from_wire(&error.kind),
            error.message,
        ))
    }
}

fn agent_status(status: &AgentStatus) -> &'static str {
    match status {
        AgentStatus::Online => "online",
        AgentStatus::Offline => "offline",
        AgentStatus::Degraded => "degraded",
    }
}

/// Reject a name whose contract differs from another Agent's.
fn validate_candidate(
    candidate: &BTreeMap<String, McpToolManifest>,
    installing: &str,
) -> Result<(), ManifestError> {
    let mut seen: BTreeMap<String, (String, McpToolDescriptor)> = BTreeMap::new();
    for (agent, manifest) in candidate {
        for tool in &manifest.tools {
            if let Some((other, existing)) = seen.get(&tool.name) {
                if *existing != *tool {
                    return Err(ManifestError::Conflict {
                        name: tool.name.clone(),
                        agent: installing.to_string(),
                        other: other.clone(),
                    });
                }
            } else {
                seen.insert(tool.name.clone(), (agent.clone(), tool.clone()));
            }
        }
    }
    Ok(())
}

/// The candidate generation's provider: one routed Tool per unique name.
struct CandidateProvider {
    manifests: BTreeMap<String, McpToolManifest>,
}

impl McpToolProvider for CandidateProvider {
    fn provider_name(&self) -> &str {
        "server-extension-manifests"
    }

    fn tools(&self) -> Result<Vec<Arc<dyn nession_mcp::ToolHandler>>, ToolProviderError> {
        Ok(self
            .contributions()?
            .into_iter()
            .map(|contribution| contribution.handler)
            .collect())
    }

    fn contributions(&self) -> Result<Vec<McpToolContribution>, ToolProviderError> {
        let mut unique: BTreeMap<String, McpToolDescriptor> = BTreeMap::new();
        for manifest in self.manifests.values() {
            for tool in &manifest.tools {
                match unique.get(&tool.name) {
                    Some(existing) if existing != tool => {
                        return Err(ToolProviderError::new(format!(
                            "Tool `{}` has conflicting contracts across Agents",
                            tool.name
                        )))
                    }
                    Some(_) => {}
                    None => {
                        unique.insert(tool.name.clone(), tool.clone());
                    }
                }
            }
        }
        Ok(unique
            .into_values()
            .map(McpToolContribution::routed)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn descriptor(name: &str, provider: &str, description: &str) -> McpToolDescriptor {
        McpToolDescriptor {
            name: name.to_string(),
            provider: provider.to_string(),
            description: description.to_string(),
            input_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["agent_id", "message"],
                "properties": {
                    "agent_id": { "type": "string", "description": "The owning Agent." },
                    "message": { "type": "string", "description": "The message." }
                }
            }),
            output_schema: json!({
                "type": "object",
                "properties": {
                    "message": { "type": "string", "description": "The echoed message." }
                }
            }),
        }
    }

    fn manifest(tool: McpToolDescriptor) -> McpToolManifest {
        McpToolManifest::new(vec![tool])
    }

    async fn catalog() -> ExtensionToolCatalog {
        let db = Arc::new(
            crate::db::Database::new(":memory:")
                .await
                .expect("in-memory database"),
        );
        ExtensionToolCatalog::new(
            Arc::new(AgentRegistry::new(60, db)),
            Arc::new(CommandBroker::new()),
        )
        .expect("catalog")
    }

    #[tokio::test]
    async fn an_installed_manifest_is_advertised_verbatim() {
        let catalog = catalog().await;
        let tool = descriptor("fixture_echo", "fixture-extension", "echo");
        catalog
            .set_manifest("agent-a", Some(manifest(tool.clone())))
            .expect("manifest installed");

        let advertised = catalog.manifest();
        assert_eq!(advertised.tools, vec![tool]);
        assert_eq!(catalog.catalog().revision(), 2);
    }

    #[tokio::test]
    async fn clearing_a_manifest_removes_its_tools() {
        let catalog = catalog().await;
        catalog
            .set_manifest(
                "agent-a",
                Some(manifest(descriptor("fixture_echo", "ext", "echo"))),
            )
            .expect("manifest installed");
        catalog
            .set_manifest("agent-a", None)
            .expect("manifest cleared");
        assert!(catalog.manifest().tools.is_empty());
    }

    #[tokio::test]
    async fn an_unsupported_manifest_version_is_refused_without_changing_the_catalog() {
        let catalog = catalog().await;
        let mut manifest = manifest(descriptor("fixture_echo", "ext", "echo"));
        manifest.manifest_version = 99;
        let error = catalog
            .set_manifest("agent-a", Some(manifest))
            .expect_err("unsupported version");
        assert!(matches!(error, ManifestError::UnsupportedVersion(99)));
        assert!(catalog.manifest().tools.is_empty());
    }

    #[tokio::test]
    async fn two_agents_cannot_advertise_one_name_with_different_contracts() {
        let catalog = catalog().await;
        catalog
            .set_manifest(
                "agent-a",
                Some(manifest(descriptor("fixture_echo", "ext", "echo"))),
            )
            .expect("first manifest");
        let error = catalog
            .set_manifest(
                "agent-b",
                Some(manifest(descriptor("fixture_echo", "ext", "different"))),
            )
            .expect_err("conflicting contract");
        match error {
            ManifestError::Conflict { name, agent, other } => {
                assert_eq!(name, "fixture_echo");
                assert_eq!(agent, "agent-b");
                assert_eq!(other, "agent-a");
            }
            other => panic!("unexpected error: {other}"),
        }
        // The refused update did not disturb the live generation.
        assert_eq!(
            catalog.manifest().tools,
            vec![descriptor("fixture_echo", "ext", "echo")]
        );
    }

    #[tokio::test]
    async fn identical_same_name_tools_from_two_agents_merge_into_one_definition() {
        let catalog = catalog().await;
        let tool = descriptor("fixture_echo", "ext", "echo");
        catalog
            .set_manifest("agent-a", Some(manifest(tool.clone())))
            .expect("first manifest");
        catalog
            .set_manifest("agent-b", Some(manifest(tool.clone())))
            .expect("second manifest");
        assert_eq!(catalog.manifest().tools, vec![tool]);
    }

    #[tokio::test]
    async fn a_contribution_without_an_agent_id_is_refused() {
        let catalog = catalog().await;
        let mut tool = descriptor("fixture_echo", "ext", "echo");
        tool.input_schema = json!({
            "type": "object",
            "properties": { "message": { "type": "string" } }
        });
        let error = catalog
            .set_manifest("agent-a", Some(manifest(tool)))
            .expect_err("unroutable contribution");
        assert!(matches!(
            error,
            ManifestError::Catalog(CatalogError::MissingRoutingField { .. })
        ));
        assert!(catalog.manifest().tools.is_empty());
    }

    #[tokio::test]
    async fn a_call_for_an_agent_without_a_manifest_fails_closed() {
        let catalog = catalog().await;
        let error = catalog
            .call("agent-unknown", "fixture_echo", serde_json::Map::new())
            .await
            .expect_err("no manifest");
        assert_eq!(error.kind, ToolErrorKind::NotFound);
    }
}
