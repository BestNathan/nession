//! The tool catalog, its schemas, and argument validation.
//!
//! **This file is the single definition of every MCP tool.** The same names,
//! descriptions and input schemas are served by Standalone, Agent embedded and
//! Server embedded. A host supplies backends; it does not add, rename or reshape
//! a tool. That is what makes "the same tool has one contract in all three
//! modes" structural rather than a convention three adapters must keep.

use serde_json::{json, Map, Value};

use crate::backend::{ClusterBackend, NodeBackend};
use crate::error::ToolError;

/// One catalog entry.
#[derive(Debug, Clone)]
pub struct ToolDefinition {
    /// The MCP tool name.
    pub name: &'static str,
    /// What it answers and which semantic owner it belongs to.
    pub description: &'static str,
    /// JSON Schema for its arguments.
    pub input_schema: Value,
}

impl ToolDefinition {
    /// The shape `tools/list` returns.
    pub fn to_wire(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        })
    }
}

fn empty_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
    })
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn string_property(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

/// The 12 tools of `#565`, in one place.
pub fn catalog() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "nession_server_list_agents",
            description: "List every Agent known to the Nession Server's cluster registry. \
                This is the Server's view (registration, heartbeat, advertised addresses), \
                not a live query of any Agent node.",
            input_schema: empty_schema(),
        },
        ToolDefinition {
            name: "nession_server_list_sessions",
            description: "List Sessions from the Nession Server's cluster registry. \
                `agent_id` scopes the result to one Agent; `force` asks every online Agent \
                for its live state before answering, and `stale_agents` names Agents that \
                did not answer. This is a Server query even when it carries an agent filter.",
            input_schema: schema(
                json!({
                    "agent_id": string_property("Scope the list to one Agent id. Omit for the whole cluster."),
                    "force": {
                        "type": "boolean",
                        "default": false,
                        "description": "Query online Agents for live state before answering."
                    }
                }),
                &[],
            ),
        },
        ToolDefinition {
            name: "nession_server_get_info",
            description: "Return Nession Server version, uptime, Agent/Session counts and \
                the Server's protocol manifest.",
            input_schema: empty_schema(),
        },
        ToolDefinition {
            name: "nession_server_capture_session_preview",
            description: "Capture a read-only scrollback preview of a Session. \
                `session_id` is the Server registry id `agent_id:session_name`. \
                This does not establish a terminal or a PTY.",
            input_schema: schema(
                json!({
                    "session_id": string_property("Server session id, in `agent_id:session_name` form."),
                    "lines": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100000,
                        "default": 2000,
                        "description": "How much scrollback to capture."
                    }
                }),
                &["session_id"],
            ),
        },
        ToolDefinition {
            name: "nession_server_get_session_attach_info",
            description: "Return the non-secret connection facts for a Session: its Agent, \
                advertised endpoints and terminal configuration. It deliberately never returns \
                a P2P credential or any other authentication material. Use it to decide how a \
                separate terminal client could reach the Session; it does not attach.",
            input_schema: schema(
                json!({
                    "session_id": string_property("Server session id, in `agent_id:session_name` form.")
                }),
                &["session_id"],
            ),
        },
        ToolDefinition {
            name: "nession_server_create_session",
            description: "Create a Session on one Agent through the Nession Server. \
                The Server resolves and routes to `agent_id`; it never creates on the Server host.",
            input_schema: schema(
                json!({
                    "agent_id": string_property("The Agent that will own the new Session."),
                    "name": string_property("The Session (tmux session) name.")
                }),
                &["agent_id", "name"],
            ),
        },
        ToolDefinition {
            name: "nession_server_kill_session",
            description: "Kill one Session through the Nession Server. \
                `session_id` is the Server registry id `agent_id:session_name`.",
            input_schema: schema(
                json!({
                    "session_id": string_property("Server session id, in `agent_id:session_name` form.")
                }),
                &["session_id"],
            ),
        },
        ToolDefinition {
            name: "nession_server_rename_agent",
            description: "Set or clear an Agent's display name in the Nession Server registry. \
                Pass `null` to clear it.",
            input_schema: schema(
                json!({
                    "agent_id": string_property("The Agent to rename."),
                    "display_name": {
                        "type": ["string", "null"],
                        "description": "The new display name, or null to clear it."
                    }
                }),
                &["agent_id", "display_name"],
            ),
        },
        ToolDefinition {
            name: "nession_server_delete_agent",
            description: "Permanently remove an offline Agent and its Sessions from the Nession \
                Server registry. An online or degraded Agent is refused.",
            input_schema: schema(
                json!({
                    "agent_id": string_property("The Agent to delete.")
                }),
                &["agent_id"],
            ),
        },
        ToolDefinition {
            name: "nession_agent_list_sessions",
            description: "List the real tmux Sessions on one explicitly named Agent node. \
                This is Agent truth, not the Server registry view. `agent_id` is required; \
                the call never falls back to the host running MCP.",
            input_schema: schema(
                json!({
                    "agent_id": string_property("The Agent node whose Sessions are listed.")
                }),
                &["agent_id"],
            ),
        },
        ToolDefinition {
            name: "nession_agent_create_session",
            description: "Create a tmux Session on one explicitly named Agent node. \
                `agent_id` is required; the call never falls back to the host running MCP.",
            input_schema: schema(
                json!({
                    "agent_id": string_property("The Agent node that will own the Session."),
                    "name": string_property("The Session (tmux session) name."),
                    "working_dir": string_property("Optional initial working directory on that Agent.")
                }),
                &["agent_id", "name"],
            ),
        },
        ToolDefinition {
            name: "nession_agent_kill_session",
            description: "Kill a tmux Session on one explicitly named Agent node. \
                `agent_id` is required; the call never falls back to the host running MCP.",
            input_schema: schema(
                json!({
                    "agent_id": string_property("The Agent node that owns the Session."),
                    "name": string_property("The Session (tmux session) name.")
                }),
                &["agent_id", "name"],
            ),
        },
    ]
}

fn object(args: Option<&Value>) -> Result<Map<String, Value>, ToolError> {
    match args {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(_) => Err(ToolError::invalid_argument(
            "arguments must be a JSON object",
        )),
    }
}

fn required_string(map: &Map<String, Value>, key: &str) -> Result<String, ToolError> {
    match map.get(key).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(value.to_string()),
        Some(_) => Err(ToolError::invalid_argument(format!(
            "`{key}` must be a non-empty string"
        ))),
        None => Err(ToolError::invalid_argument(format!("`{key}` is required"))),
    }
}

fn optional_string(map: &Map<String, Value>, key: &str) -> Result<Option<String>, ToolError> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(ToolError::invalid_argument(format!(
            "`{key}` must be a string"
        ))),
    }
}

fn optional_bool(map: &Map<String, Value>, key: &str) -> Result<bool, ToolError> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(ToolError::invalid_argument(format!(
            "`{key}` must be a boolean"
        ))),
    }
}

fn optional_u32(
    map: &Map<String, Value>,
    key: &str,
    default: u32,
    min: u32,
    max: u32,
) -> Result<u32, ToolError> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => {
            let Some(number) = value.as_u64() else {
                return Err(ToolError::invalid_argument(format!(
                    "`{key}` must be a non-negative integer"
                )));
            };
            let Ok(number) = u32::try_from(number) else {
                return Err(ToolError::invalid_argument(format!(
                    "`{key}` is out of range"
                )));
            };
            if !(min..=max).contains(&number) {
                return Err(ToolError::invalid_argument(format!(
                    "`{key}` must be in [{min}, {max}]"
                )));
            }
            Ok(number)
        }
    }
}

/// Validate arguments and dispatch one tool call.
///
/// The returned [`Value`] is the business reply. [`crate::service`] decides
/// whether it represents a delivered refusal and sets `isError` accordingly.
pub async fn call(
    name: &str,
    args: Option<&Value>,
    cluster: &dyn ClusterBackend,
    node: &dyn NodeBackend,
) -> Result<Value, ToolError> {
    let args = object(args)?;
    match name {
        "nession_server_list_agents" => cluster.list_agents().await,
        "nession_server_list_sessions" => {
            let agent_id = optional_string(&args, "agent_id")?;
            let force = optional_bool(&args, "force")?;
            cluster.list_sessions(agent_id.as_deref(), force).await
        }
        "nession_server_get_info" => cluster.get_info().await,
        "nession_server_capture_session_preview" => {
            let session_id = required_string(&args, "session_id")?;
            let lines = optional_u32(&args, "lines", 2000, 1, 100_000)?;
            cluster.capture_session_preview(&session_id, lines).await
        }
        "nession_server_get_session_attach_info" => {
            let session_id = required_string(&args, "session_id")?;
            cluster.get_session_attach_info(&session_id).await
        }
        "nession_server_create_session" => {
            let agent_id = required_string(&args, "agent_id")?;
            let name = required_string(&args, "name")?;
            cluster.create_session(&agent_id, &name).await
        }
        "nession_server_kill_session" => {
            let session_id = required_string(&args, "session_id")?;
            cluster.kill_session(&session_id).await
        }
        "nession_server_rename_agent" => {
            let agent_id = required_string(&args, "agent_id")?;
            if !args.contains_key("display_name") {
                return Err(ToolError::invalid_argument(
                    "`display_name` is required (use null to clear)",
                ));
            }
            let display_name = optional_string(&args, "display_name")?;
            cluster
                .rename_agent(&agent_id, display_name.as_deref())
                .await
        }
        "nession_server_delete_agent" => {
            let agent_id = required_string(&args, "agent_id")?;
            cluster.delete_agent(&agent_id).await
        }
        "nession_agent_list_sessions" => {
            let agent_id = required_string(&args, "agent_id")?;
            node.list_sessions(&agent_id).await
        }
        "nession_agent_create_session" => {
            let agent_id = required_string(&args, "agent_id")?;
            let name = required_string(&args, "name")?;
            let working_dir = optional_string(&args, "working_dir")?;
            node.create_session(&agent_id, &name, working_dir.as_deref())
                .await
        }
        "nession_agent_kill_session" => {
            let agent_id = required_string(&args, "agent_id")?;
            let name = required_string(&args, "name")?;
            node.kill_session(&agent_id, &name).await
        }
        other => Err(ToolError::invalid_argument(format!(
            "unknown tool `{other}`"
        ))),
    }
}

/// Whether a delivered business reply represents a refusal.
///
/// Three established reply conventions exist in this tree (`status: error`,
/// `success: false`, and a top-level `error`). The check is intentionally
/// shape-based: it must classify a refusal from any existing owner without
/// every host adapter inventing its own mapping.
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
