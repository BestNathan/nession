//! Client-facing CLI commands implementation.

use anyhow::{Context, Result};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::client::connection::ClientConnection;

/// List agents from the server and display them in a formatted table.
pub async fn list_agents(server_url: &str, auth_token: &str) -> Result<()> {
    // Connect to the server
    let mut conn = ClientConnection::connect(server_url, auth_token)
        .await
        .with_context(|| "Failed to connect to server. Is the server running?")?;

    // Fetch agents
    let agents = conn.list_agents().await?;

    // Close connection
    conn.close().await.ok();

    // Display results
    if agents.is_empty() {
        println!("No agents registered.");
        return Ok(());
    }

    println!();
    println!("Agents:");
    println!(
        "{:<16}{:<18}{:<10}{:<12}{:<15}",
        "ID", "HOSTNAME", "STATUS", "SESSIONS", "LAST HEARTBEAT"
    );

    for agent in &agents {
        let heartbeat_ago = format_time_ago(&agent.last_heartbeat);
        println!(
            "{:<16}{:<18}{:<10}{:<12}{:<15}",
            agent.agent_id,
            agent.hostname,
            agent.status,
            agent.session_count,
            heartbeat_ago,
        );
    }
    println!();
    println!("{} agent(s) total", agents.len());

    Ok(())
}

/// List sessions from the server and display them in a formatted table.
pub async fn list_sessions(
    server_url: &str,
    auth_token: &str,
    agent_id: Option<&str>,
) -> Result<()> {
    // Connect to the server
    let mut conn = ClientConnection::connect(server_url, auth_token)
        .await
        .with_context(|| "Failed to connect to server. Is the server running?")?;

    // Fetch sessions
    let sessions = conn.list_sessions(agent_id).await?;

    // Close connection
    conn.close().await.ok();

    // Display results
    if sessions.is_empty() {
        if let Some(aid) = agent_id {
            println!("No sessions found for agent '{}'.", aid);
        } else {
            println!("No sessions found.");
        }
        return Ok(());
    }

    println!();
    println!("Sessions:");
    println!(
        "{:<34}{:<16}{:<14}{:<12}{:<10}{}",
        "SESSION ID", "AGENT", "NAME", "STATUS", "WINDOWS", "ATTACHED"
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
            return format!("{}s ago", secs);
        }
        let mins = secs / 60;
        if mins < 60 {
            return format!("{}m ago", mins);
        }
        let hours = mins / 60;
        if hours < 24 {
            return format!("{}h ago", hours);
        }
        let days = hours / 24;
        return format!("{}d ago", days);
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
            return format!("{}s ago", elapsed);
        }
        let mins = elapsed / 60;
        if mins < 60 {
            return format!("{}m ago", mins);
        }
        let hours = mins / 60;
        if hours < 24 {
            return format!("{}h ago", hours);
        }
        let days = hours / 24;
        return format!("{}d ago", days);
    }

    // Fallback: return the original string
    timestamp.to_string()
}
