//! `nession sessions list` — list Sessions from the Server registry.

use crate::connection::connect;
use anyhow::Result;
use nession_protocol::contracts::session::v1::ServerSessionListReply;

pub async fn run(server_url: &str, auth_token: &str, agent_id: Option<&str>) -> Result<()> {
    // Connect to the server
    let mut client = connect(server_url, auth_token).await?;

    // Fetch sessions. Reading the contract's union is also what fixes a refusal
    // here: the consumer this replaces pulled `payload["sessions"]` out and ran
    // it through `Vec<SessionInfo>`, so a refusal — which has no `sessions` key
    // at all — surfaced as a serde error about a missing field rather than as
    // the sentence the server actually sent.
    let sessions = match client.list_sessions(agent_id).await? {
        ServerSessionListReply::Listed(list) => list.sessions,
        ServerSessionListReply::Refused(refusal) => {
            anyhow::bail!("Server refused to list sessions: {}", refusal.message)
        }
    };

    // Close connection
    client.close().await.ok();

    // Display results
    if sessions.is_empty() {
        if let Some(aid) = agent_id {
            println!("No sessions found for agent '{aid}'.");
        } else {
            println!("No sessions found.");
        }
        return Ok(());
    }

    println!();
    println!("Sessions:");
    println!(
        "{:<34}{:<16}{:<14}{:<12}{:<10}ATTACHED",
        "SESSION ID", "AGENT", "NAME", "STATUS", "WINDOWS"
    );

    for session in &sessions {
        println!(
            "{:<34}{:<16}{:<14}{:<12}{:<10}{}",
            session.session_id,
            session.agent_id,
            session.session_name,
            session.status,
            session.window_count,
            session.attached_clients,
        );
    }
    println!();
    println!("{} session(s) total", sessions.len());

    Ok(())
}
