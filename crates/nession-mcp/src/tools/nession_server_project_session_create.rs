//! `nession_server_project_session_create` — Server-owned Project-context
//! Session creation.
//!
//! This is a second **creation path**, not a second Session type. The Agent
//! still owns the tmux Session; the Server owns the Project declaration, its
//! validation, Project default resolution and the durable Session→Project
//! association. The Tool therefore routes through the canonical
//! `server.session.create` unit and reports only a create whose Project
//! association the Server confirmed.
//!
//! Two targets are accepted:
//!
//! * `existing` — an Explicit Existing Location `{agent_id, path}` declared by
//!   the Project. The Server validates the pair and the Agent's online state.
//! * `managed` — the existing Managed creation contract. The Server resolves
//!   and authorizes the Project image and every requested artifact; the Agent
//!   owns cache preparation and refuses unsupported capabilities. There is no
//!   Native fallback.

use async_trait::async_trait;
use nession_protocol::contracts::env::v1::EnvFileRef;
use nession_protocol::contracts::project::v1::{is_valid_project_id, ProjectValidationError};
use nession_protocol::contracts::session::v1::{
    ClientManagedCreate, ClientSessionCreatePayload, EnvSelectionMode, ManagedToolchainRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionServerProjectSessionCreate;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// Stable Project identity (`project-<uuid>`).
    project_id: String,
    /// The Agent node that will own the new Session.
    agent_id: String,
    /// The new tmux Session name.
    name: String,
    /// The Project-context creation target.
    target: Target,
    /// Create-time ENV intent. Absent means `inherit`.
    #[serde(default)]
    environment: Option<Environment>,
}

/// A Project-context create target, discriminated by `kind`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
enum Target {
    /// An Existing Location the Project declares.
    Existing(ExistingTarget),
    /// A Managed EROFS-backed creation using the Project image.
    Managed(ManagedTarget),
}

/// `target.kind = "existing"`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ExistingTarget {
    /// Literal `existing`.
    #[serde(rename = "kind")]
    _kind: ExistingKind,
    /// Directory declared as this Project's `{agent_id, path}` location.
    working_dir: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ExistingKind {
    Existing,
}

/// `target.kind = "managed"`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ManagedTarget {
    /// Literal `managed`.
    #[serde(rename = "kind")]
    _kind: ManagedKind,
    /// `sha256:<64 lowercase hex>` Base Runtime image.
    base_digest: String,
    /// Optional read-only toolchain artifacts.
    #[serde(default)]
    toolchains: Vec<ManagedToolchainRequest>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ManagedKind {
    Managed,
}

/// Explicit create-time ENV intent.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Environment {
    /// `inherit` (Project defaults) or `replace` (the explicit list).
    #[serde(default)]
    mode: EnvironmentMode,
    /// Complete ordered ENV selection for `replace`; `[]` binds none.
    /// Must be absent for `inherit`.
    #[serde(default)]
    env_files: Option<Vec<EnvFileRef>>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum EnvironmentMode {
    #[default]
    Inherit,
    Replace,
}

/// The success reply of `nession_server_project_session_create`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ProjectSessionCreatedOutput {
    /// Canonical Session identity (`<agent_id>:<session_name>`).
    pub session_id: String,
    /// The created tmux Session name.
    pub name: String,
    /// The Project association the Server confirmed and persisted.
    pub project_id: String,
    /// Non-fatal warnings produced while materializing the Session.
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[async_trait]
impl ToolHandler for NessionServerProjectSessionCreate {
    fn name(&self) -> &'static str {
        "nession_server_project_session_create"
    }

    fn description(&self) -> &'static str {
        "Create a Session through a Project on one explicitly named Agent. This is Server-owned \
         Project-context creation: it validates the Project and its declared Existing Location \
         (or Managed artifacts), resolves Project ENV defaults, delegates the actual create to \
         the Agent through the canonical Server route, and confirms the persisted project_id. \
         `target.kind=existing` needs a declared working_dir; `target.kind=managed` uses the \
         existing Managed contract with the Project image. There is no direct-Agent fallback."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<ProjectSessionCreatedOutput>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let arguments: Arguments = parse_arguments(arguments)?;
        non_empty(&arguments.project_id, "project_id")?;
        if !is_valid_project_id(&arguments.project_id) {
            return Err(ToolError::invalid_argument(
                ProjectValidationError::InvalidProjectId.message(),
            ));
        }
        non_empty(&arguments.agent_id, "agent_id")?;
        non_empty(&arguments.name, "name")?;

        let project_id = arguments.project_id;
        let agent_id = arguments.agent_id;
        let name = arguments.name;

        let (working_dir, managed) = match arguments.target {
            Target::Existing(target) => {
                non_empty(&target.working_dir, "target.working_dir")?;
                (Some(target.working_dir), None)
            }
            Target::Managed(target) => {
                non_empty(&target.base_digest, "target.base_digest")?;
                for (index, toolchain) in target.toolchains.iter().enumerate() {
                    non_empty(
                        &toolchain.digest,
                        &format!("target.toolchains[{index}].digest"),
                    )?;
                }
                (
                    None,
                    Some(ClientManagedCreate {
                        base_digest: target.base_digest,
                        toolchains: target.toolchains,
                    }),
                )
            }
        };

        let (env_selection_mode, env_files) = match arguments.environment {
            None => (EnvSelectionMode::Inherit, Vec::new()),
            Some(environment) => match environment.mode {
                EnvironmentMode::Inherit => {
                    if environment.env_files.is_some() {
                        return Err(ToolError::invalid_argument(
                            "environment.mode 'inherit' does not accept env_files; use 'replace' with an explicit selection (including [] to bind no environment)",
                        ));
                    }
                    (EnvSelectionMode::Inherit, Vec::new())
                }
                EnvironmentMode::Replace => {
                    let Some(env_files) = environment.env_files else {
                        return Err(ToolError::invalid_argument(
                            "environment.mode 'replace' requires env_files, including [] to bind no environment",
                        ));
                    };
                    (EnvSelectionMode::Replace, env_files)
                }
            },
        };

        let payload = ClientSessionCreatePayload {
            agent_id: agent_id.clone(),
            name: name.clone(),
            working_dir,
            env_files,
            env_selection_mode: Some(env_selection_mode),
            sandbox: None,
            project_id: Some(project_id.clone()),
            managed,
            initial_metadata: None,
        };
        let reply = context.cluster.create_project_session(payload).await?;
        if !reply.success {
            return Err(create_refusal(reply.error.unwrap_or_else(|| {
                "the Server refused the Project Session create".to_string()
            })));
        }
        let session_id = reply
            .session_id
            .unwrap_or_else(|| format!("{agent_id}:{name}"));
        // A successful Agent create without the committed Project association
        // is a partial outcome, not a successful Project-context create. The
        // Session may exist; the caller must read back instead of creating a
        // duplicate.
        if reply.project_id.as_deref() != Some(project_id.as_str()) {
            return Err(ToolError::backend(format!(
                "Session '{session_id}' was created, but Project '{project_id}' association could not be confirmed. Read the Project's Sessions before retrying; do not create the Session again."
            )));
        }
        reply_value(&ProjectSessionCreatedOutput {
            session_id,
            name,
            project_id,
            warnings: reply.warnings,
        })
    }
}

/// A refusal that may hide a completed Agent create is never presented as a
/// plain failure: the caller is told to read back before retrying.
fn create_refusal(message: String) -> ToolError {
    if message.contains("disconnected") || message.starts_with("Timeout") {
        ToolError::backend(format!(
            "{message}. The create outcome is unknown; read the Project's Sessions before retrying — do not create the Session again blindly."
        ))
    } else {
        ToolError::backend(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use serde_json::json;
    use std::sync::Arc;

    const PROJECT_ID: &str = "project-123e4567-e89b-42d3-a456-426614174000";

    fn existing_arguments() -> Value {
        json!({
            "project_id": PROJECT_ID,
            "agent_id": "agent-1",
            "name": "dev",
            "target": { "kind": "existing", "working_dir": "/srv/project" }
        })
    }

    fn created_payload(recorder: &Recording) -> Value {
        recorder
            .calls()
            .into_iter()
            .find_map(|call| match call {
                Recorded::CreateProjectSession(payload) => Some(payload),
                _ => None,
            })
            .expect("the create reached the backend")
    }

    #[tokio::test]
    async fn existing_target_inherits_project_defaults_by_default() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerProjectSessionCreate
            .call(&context(&recorder), arguments(existing_arguments()))
            .await
            .expect("reply");
        assert_eq!(reply["session_id"], "agent-1:dev");
        assert_eq!(reply["name"], "dev");
        assert_eq!(reply["project_id"], PROJECT_ID);

        let payload = created_payload(&recorder);
        assert_eq!(payload["project_id"], PROJECT_ID);
        assert_eq!(payload["working_dir"], "/srv/project");
        assert_eq!(payload["env_selection_mode"], "inherit");
        assert_eq!(payload["env_files"], json!([]));
        assert!(payload.get("managed").is_none());
    }

    #[tokio::test]
    async fn replace_uses_the_explicit_env_selection() {
        let recorder = Arc::new(Recording::default());
        let mut input = existing_arguments();
        input["environment"] = json!({
            "mode": "replace",
            "env_files": [{ "name": "prod.env", "source": "server" }]
        });
        NessionServerProjectSessionCreate
            .call(&context(&recorder), arguments(input))
            .await
            .expect("reply");
        let payload = created_payload(&recorder);
        assert_eq!(payload["env_selection_mode"], "replace");
        assert_eq!(payload["env_files"][0]["name"], "prod.env");
    }

    #[tokio::test]
    async fn replace_accepts_an_explicit_empty_selection() {
        let recorder = Arc::new(Recording::default());
        let mut input = existing_arguments();
        input["environment"] = json!({ "mode": "replace", "env_files": [] });
        NessionServerProjectSessionCreate
            .call(&context(&recorder), arguments(input))
            .await
            .expect("reply");
        let payload = created_payload(&recorder);
        assert_eq!(payload["env_selection_mode"], "replace");
        assert_eq!(payload["env_files"], json!([]));
    }

    #[tokio::test]
    async fn replace_without_an_explicit_selection_is_refused() {
        let recorder = Arc::new(Recording::default());
        let mut input = existing_arguments();
        input["environment"] = json!({ "mode": "replace" });
        let error = NessionServerProjectSessionCreate
            .call(&context(&recorder), arguments(input))
            .await
            .expect_err("missing env_files");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(error.message.contains("requires env_files"));
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn inherit_with_an_explicit_selection_is_refused() {
        let recorder = Arc::new(Recording::default());
        let mut input = existing_arguments();
        input["environment"] = json!({
            "mode": "inherit",
            "env_files": [{ "name": "prod.env", "source": "server" }]
        });
        let error = NessionServerProjectSessionCreate
            .call(&context(&recorder), arguments(input))
            .await
            .expect_err("inherit with env_files");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn managed_target_reuses_the_canonical_managed_contract() {
        let recorder = Arc::new(Recording::default());
        let digest = format!("sha256:{}", "a".repeat(64));
        let input = json!({
            "project_id": PROJECT_ID,
            "agent_id": "agent-1",
            "name": "dev",
            "target": {
                "kind": "managed",
                "base_digest": digest,
                "toolchains": [{ "digest": digest, "target": "/opt/node" }]
            }
        });
        NessionServerProjectSessionCreate
            .call(&context(&recorder), arguments(input))
            .await
            .expect("reply");
        let payload = created_payload(&recorder);
        assert!(payload.get("working_dir").is_none());
        assert_eq!(payload["managed"]["base_digest"], digest);
        assert_eq!(payload["managed"]["toolchains"][0]["target"], "/opt/node");
    }

    #[tokio::test]
    async fn an_unconfirmed_project_association_is_not_reported_as_success() {
        let recorder = Arc::new(Recording::default());
        recorder.set_create_project_session_reply(json!({
            "success": true,
            "session_id": "agent-1:dev",
            "project_id": null,
            "warnings": []
        }));
        let error = NessionServerProjectSessionCreate
            .call(&context(&recorder), arguments(existing_arguments()))
            .await
            .expect_err("unconfirmed association");
        assert_eq!(error.kind, crate::error::ToolErrorKind::Backend);
        assert!(error.message.contains("could not be confirmed"));
        assert!(error.message.contains("do not create the Session again"));
    }

    #[tokio::test]
    async fn an_ambiguous_create_requires_readback_before_retry() {
        let recorder = Arc::new(Recording::default());
        recorder.set_create_project_session_reply(json!({
            "success": false,
            "error": "Agent disconnected",
            "warnings": []
        }));
        let error = NessionServerProjectSessionCreate
            .call(&context(&recorder), arguments(existing_arguments()))
            .await
            .expect_err("ambiguous create");
        assert_eq!(error.kind, crate::error::ToolErrorKind::Backend);
        assert!(error
            .message
            .contains("read the Project's Sessions before retrying"));
    }

    #[tokio::test]
    async fn a_malformed_project_identity_never_reaches_the_backend() {
        let recorder = Arc::new(Recording::default());
        let mut input = existing_arguments();
        input["project_id"] = json!("not-a-project");
        let error = NessionServerProjectSessionCreate
            .call(&context(&recorder), arguments(input))
            .await
            .expect_err("malformed project id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[test]
    fn its_schema_is_closed_and_requires_the_create_identity() {
        let schema = NessionServerProjectSessionCreate.input_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["required"],
            json!(["project_id", "agent_id", "name", "target"])
        );
        assert!(schema["properties"]["target"].is_object());
    }

    #[test]
    fn the_target_schema_is_a_typed_discriminated_input() {
        let schema = NessionServerProjectSessionCreate.input_schema();
        let rendered = serde_json::to_string(&schema).expect("schema json");
        assert!(rendered.contains("\"existing\""), "{rendered}");
        assert!(rendered.contains("\"managed\""), "{rendered}");
        assert!(rendered.contains("\"kind\""), "{rendered}");
        assert!(
            !rendered.contains("_kind"),
            "the serde rename must reach the emitted schema: {rendered}"
        );
    }

    #[tokio::test]
    async fn an_unexpected_argument_is_refused() {
        let recorder = Arc::new(Recording::default());
        let mut input = existing_arguments();
        input["project_id"] = json!(PROJECT_ID);
        input["sandbox"] = json!(true);
        let error = NessionServerProjectSessionCreate
            .call(&context(&recorder), arguments(input))
            .await
            .expect_err("unexpected argument");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
