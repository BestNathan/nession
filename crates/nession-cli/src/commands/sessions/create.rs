//! `nession sessions create` — create a Session on one Agent.

use crate::connection::connect;
use anyhow::{Context, Result};

pub async fn run(
    server_url: &str,
    auth_token: &str,
    agent_id: &str,
    session_name: &str,
) -> Result<()> {
    let mut client = connect(server_url, auth_token).await?;
    println!("Creating session '{session_name}' on agent '{agent_id}'...");

    let reply = client
        .create_session(agent_id, session_name)
        .await
        .with_context(|| {
            format!("Failed to create session '{session_name}' on agent '{agent_id}'")
        })?;
    client.close().await.ok();

    if !reply.success {
        // The Server's own sentence, not a paraphrase of it. It knows which of
        // the cases this is — an unknown agent, an offline one, a name already
        // taken — and a client that restates it can only be less specific.
        let reason = reply.error.unwrap_or_else(|| "no reason given".to_string());
        anyhow::bail!("Server refused to create session '{session_name}': {reason}");
    }

    println!(
        "Session '{}' created successfully.",
        reply.session_id.as_deref().unwrap_or(session_name)
    );

    Ok(())
}
