//! `nession sessions kill` — kill one Session through the Server.

use crate::connection::connect;
use anyhow::{Context, Result};

/// Kill a tmux session on an agent.
///
/// Parses the session_id (format: `agent_id:session_name`) and asks the
/// Server, which resolves the agent and routes the kill.
pub async fn kill_session(server_url: &str, auth_token: &str, session_id: &str) -> Result<()> {
    let (agent_id, session_name) = session_id.split_once(':').with_context(|| {
        format!("Invalid session ID '{session_id}'. Expected format: agent_id:session_name")
    })?;

    let mut client = connect(server_url, auth_token).await?;
    println!("Killing session '{session_name}' on agent '{agent_id}'...");

    let reply = client.kill_session(session_id).await.with_context(|| {
        format!("Failed to kill session '{session_name}' on agent '{agent_id}'")
    })?;
    client.close().await.ok();

    if !reply.success {
        let reason = reply.error.unwrap_or_else(|| "no reason given".to_string());
        anyhow::bail!("Server refused to kill session '{session_name}': {reason}");
    }

    println!("Session '{session_name}' killed successfully.");

    Ok(())
}

/// The leaf entry point: confirm unless forced, then kill.
pub async fn run(server_url: &str, auth_token: &str, session_id: &str, force: bool) -> Result<()> {
    if !force {
        print!("Are you sure you want to kill session '{session_id}'? [y/N] ");
        use std::io::Write;
        std::io::stdout().flush()?;
        let mut input = String::new();
        std::io::stdin().read_line(&mut input)?;
        let input = input.trim().to_lowercase();
        if input != "y" && input != "yes" {
            println!("Aborted.");
            return Ok(());
        }
    }
    kill_session(server_url, auth_token, session_id).await
}
