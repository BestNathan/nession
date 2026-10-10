//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    agent_list_reply, info, warn, AgentListReply, AgentRefusal, ConnectionHandler, HandlerAction,
    ProtocolMessage, WebAgentsListResponse,
};

impl ConnectionHandler {
    /// Handle `server.agent.list` - returns all registered agents.
    pub(super) async fn handle_client_agents_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary: the list half is built by
        // `agent_view`, whose single builder both this and the `server.agents.changed`
        // push go through, and the refusal half is `AgentRefusal`.
        if !self.authenticated_client {
            warn!("Unauthenticated client requested agents list");
            return Ok(agent_list_reply(
                &msg.id,
                AgentListReply::Refused(AgentRefusal {
                    status: "error".to_string(),
                    message: "Not authenticated".to_string(),
                }),
            ));
        }

        let agents = self.agent_registry.list().await;

        let view: Vec<nession_protocol::contracts::agent::v1::WebAgentInfo> = agents
            .iter()
            .map(crate::server::agent_view::agent_to_view)
            .collect();

        info!(
            "Client requested agents list, returning {} agents",
            view.len()
        );

        Ok(agent_list_reply(
            &msg.id,
            AgentListReply::Listed(WebAgentsListResponse { agents: view }),
        ))
    }
}
