//! `server.mcp.tool.call` — one authorized Extension Tool call (`#3778`).
//! Route identity, version and policy are owned by `routes.rs`.

use super::{current_timestamp, ConnectionHandler, HandlerAction, ProtocolMessage, WsFrame};
use nession_protocol::contracts::mcp::v1::{McpToolCallPayload, McpToolCallReply};
use serde_json::{json, Value};

impl ConnectionHandler {
    pub(super) async fn handle_client_mcp_tool_call(
        &mut self,
        msg: ProtocolMessage<Value>,
    ) -> anyhow::Result<HandlerAction> {
        let reply = if !self.authenticated_client {
            McpToolCallReply::failure("invalid_argument", "Not authenticated")
        } else {
            match serde_json::from_value::<McpToolCallPayload>(msg.payload.clone()) {
                Ok(call) => self.route_extension_tool(call).await,
                Err(error) => McpToolCallReply::failure(
                    "invalid_argument",
                    format!("the call does not match its contract: {error}"),
                ),
            }
        };
        Ok(HandlerAction::Reply(Some(WsFrame::Text(
            json!({
                "msg_type": "server.mcp.tool.call",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": reply,
            })
            .to_string(),
        ))))
    }

    async fn route_extension_tool(&self, call: McpToolCallPayload) -> McpToolCallReply {
        if call.agent_id.trim().is_empty() {
            return McpToolCallReply::failure(
                "invalid_argument",
                "`agent_id` must name the owning Agent",
            );
        }
        let Some(arguments) = call.arguments.as_object().cloned() else {
            return McpToolCallReply::failure("invalid_argument", "`arguments` must be an object");
        };
        // The routing identity and the Tool's own `agent_id` argument must be
        // the same target. Two spellings of one call could otherwise route to
        // one Agent while validating the arguments against another.
        let argument_agent = arguments
            .get("agent_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if argument_agent != call.agent_id {
            return McpToolCallReply::failure(
                "invalid_argument",
                "`arguments.agent_id` must match the routing `agent_id`",
            );
        }
        let Some(tools) = self.extension_tools.as_ref() else {
            return McpToolCallReply::failure(
                "unavailable",
                "this Server does not host Extension-contributed Tools",
            );
        };
        match tools.call(&call.agent_id, &call.tool, arguments).await {
            Ok(result) => McpToolCallReply::success(result),
            Err(error) => McpToolCallReply::failure(error.kind.as_str(), error.message),
        }
    }
}
