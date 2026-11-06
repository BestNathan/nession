//! `nession agents list` — list every Agent the Server knows about.

use crate::connection::connect;
use anyhow::Result;
use nession_protocol::contracts::agent::v1::{AgentListReply, WebAgentInfo};
use std::time::{SystemTime, UNIX_EPOCH};

pub async fn run(server_url: &str, auth_token: &str) -> Result<()> {
    // Connect to the server
    let mut client = connect(server_url, auth_token).await?;

    // Fetch agents. The reply is the contract's union — the list, or the
    // server's refusal — and the refusal's own sentence is what a reader needs,
    // so it is printed rather than described.
    let agents = match client.list_agents().await? {
        AgentListReply::Listed(list) => list.agents,
        AgentListReply::Refused(refusal) => {
            anyhow::bail!("Server refused to list agents: {}", refusal.message)
        }
    };

    // Close connection
    client.close().await.ok();

    // Display results
    if agents.is_empty() {
        println!("No agents registered.");
        return Ok(());
    }

    println!();
    println!("Agents:");
    println!(
        "{:<16}{:<18}{:<10}{:<12}{:<10}{:<15}",
        "ID", "HOSTNAME", "STATUS", "SESSIONS", "PROTOCOLS", "LAST HEARTBEAT"
    );

    for agent in &agents {
        let heartbeat_ago = format_time_ago(&agent.last_heartbeat);
        println!(
            "{:<16}{:<18}{:<10}{:<12}{:<10}{:<15}",
            agent.agent_id,
            agent.hostname,
            agent.status,
            agent.session_count,
            protocol_summary(agent),
            heartbeat_ago,
        );
    }
    println!();
    println!("{} agent(s) total", agents.len());

    Ok(())
}

/// How an agent's advertised protocol set reads in one column (`#678`).
///
/// `no manifest` rather than `0`: a peer this server has no manifest for is not
/// a peer that serves nothing, and printing `0` would report the second as the
/// first — they resolve differently.
///
/// Since `#678` became a breaking upgrade, registration refuses an agent that
/// advertises nothing, so this is a straggler that has not reconnected since
/// the server was upgraded. It is worth naming rather than hiding: every call
/// to that agent will come back `contract_not_supported`, and a reader looking
/// at this column should be able to see why.
fn protocol_summary(agent: &WebAgentInfo) -> String {
    match &agent.protocols {
        Some(manifest) => format!("{} units", manifest.protocols.len()),
        None => "no manifest".to_string(),
    }
}
/// Format a timestamp string (ISO 8601 or Unix seconds) into "Xs ago" or "Xm ago".
fn format_time_ago(timestamp: &str) -> String {
    // Try to parse as a datetime
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(timestamp) {
        let now = chrono::Utc::now();
        let dt_utc = dt.with_timezone(&chrono::Utc);
        let elapsed = now.signed_duration_since(dt_utc);
        let secs = elapsed.num_seconds();

        if secs < 0 {
            return "just now".to_string();
        }
        if secs < 60 {
            return format!("{secs}s ago");
        }
        let mins = secs / 60;
        if mins < 60 {
            return format!("{mins}m ago");
        }
        let hours = mins / 60;
        if hours < 24 {
            return format!("{hours}h ago");
        }
        let days = hours / 24;
        return format!("{days}d ago");
    }

    // Try to parse as unix timestamp (seconds)
    if let Ok(unix_secs) = timestamp.parse::<i64>() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let elapsed = now - unix_secs;

        if elapsed < 0 {
            return "just now".to_string();
        }
        if elapsed < 60 {
            return format!("{elapsed}s ago");
        }
        let mins = elapsed / 60;
        if mins < 60 {
            return format!("{mins}m ago");
        }
        let hours = mins / 60;
        if hours < 24 {
            return format!("{hours}h ago");
        }
        let days = hours / 24;
        return format!("{days}d ago");
    }

    // Fallback: return the original string
    timestamp.to_string()
}
