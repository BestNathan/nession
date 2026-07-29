use nession_common::extension::AgentExtension;
use serde_json::Value;
use std::collections::HashMap;
use tracing::debug;

/// Dispatches server-relayed commands to registered extensions.
/// Built once at startup; shared immutably across all connections.
pub struct ExtensionRegistry {
    /// Lookup: msg_type → (extension_index, command_suffix)
    handlers: HashMap<String, (usize, String)>,
    extensions: Vec<Box<dyn AgentExtension>>,
}

impl ExtensionRegistry {
    pub fn new(extensions: Vec<Box<dyn AgentExtension>>) -> Self {
        let mut handlers = HashMap::new();
        for (idx, ext) in extensions.iter().enumerate() {
            for &msg_type in ext.message_types() {
                // msg_type format: "extension.<name>.<action>"
                // Strip the "extension." prefix to get the command suffix
                let command = msg_type
                    .strip_prefix("extension.")
                    .unwrap_or(msg_type)
                    .to_string();
                handlers.insert(msg_type.to_string(), (idx, command));
            }
        }
        Self {
            handlers,
            extensions,
        }
    }

    /// Try to dispatch a message. Returns Some(response) if handled, None to
    /// fall through to built-in handlers.
    pub async fn dispatch(&self, msg_type: &str, payload: Value) -> Option<anyhow::Result<Value>> {
        let (idx, command) = self.handlers.get(msg_type)?;
        let ext = self.extensions.get(*idx)?;
        debug!(
            "Extension dispatch: {} → {} (msg_type: {})",
            ext.name(),
            command,
            msg_type
        );
        Some(ext.handle_command(command, payload).await)
    }

    /// Check whether a message type belongs to any registered extension.
    pub fn knows(&self, msg_type: &str) -> bool {
        self.handlers.contains_key(msg_type)
    }
}
