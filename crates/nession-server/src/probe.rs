//! TCP reachability probing for agent P2P addresses.
//!
//! The server periodically dials each advertised address (issue #43, choice B:
//! "透传 + TCP 可达性探测") so clients can skip endpoints that are known-dead
//! and the UI can show reachability. Probing is a plain TCP connect to the
//! host:port extracted from the WebSocket URL — no handshake, no data sent.

use std::sync::Arc;
use std::time::Duration;

use nession_common::protocol::AddressStatus;
use tokio::net::TcpStream;

use crate::registry::AgentRegistry;

/// How often to sweep all agent addresses.
const PROBE_INTERVAL: Duration = Duration::from_secs(30);
/// Per-address TCP connect timeout.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Extract `host:port` from a WebSocket URL for TCP dialling.
///
/// Handles `ws://`/`wss://` schemes, IPv6 literals in brackets, and default
/// ports (80 for ws, 443 for wss). Strips any path/query. Returns `None` when
/// the URL can't be parsed into a dial target.
pub fn dial_target(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    let default_port = match scheme.to_ascii_lowercase().as_str() {
        "ws" | "http" => 80,
        "wss" | "https" => 443,
        _ => return None,
    };

    // Authority is everything up to the first '/', '?', or '#'.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() {
        return None;
    }

    // IPv6 literal: [::1]:8080 or [::1].
    if let Some(after_bracket) = authority.strip_prefix('[') {
        let (host, port_part) = after_bracket.split_once(']')?;
        let port = port_part
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(default_port);
        return Some(format!("[{host}]:{port}"));
    }

    // IPv4 / hostname.
    match authority.rsplit_once(':') {
        Some((host, port)) if port.parse::<u16>().is_ok() => Some(format!("{host}:{port}")),
        _ => Some(format!("{authority}:{default_port}")),
    }
}

/// Probe a single address once. Returns its status and RTT on success.
async fn probe_once(url: &str) -> (AddressStatus, Option<u64>) {
    let Some(target) = dial_target(url) else {
        return (AddressStatus::Unreachable, None);
    };

    let start = std::time::Instant::now();
    match tokio::time::timeout(PROBE_TIMEOUT, TcpStream::connect(&target)).await {
        Ok(Ok(_stream)) => {
            let rtt = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
            (AddressStatus::Reachable, Some(rtt))
        }
        // Connection error or timeout → unreachable.
        Ok(Err(_)) | Err(_) => (AddressStatus::Unreachable, None),
    }
}

/// Run one full sweep: probe every address of every registered agent and write
/// results back into the registry.
pub async fn run_probe_sweep(registry: &AgentRegistry) {
    let targets = registry.list_probe_targets().await;
    for (agent_id, urls) in targets {
        for url in urls {
            let (status, rtt_ms) = probe_once(&url).await;
            registry
                .update_address_status(&agent_id, &url, status, rtt_ms)
                .await;
        }
    }
}

/// Spawn the periodic probe task. Sweeps every [`PROBE_INTERVAL`]; the first
/// sweep runs one interval after startup (agents need time to register).
pub fn spawn_probe_task(registry: Arc<AgentRegistry>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(PROBE_INTERVAL);
        ticker.tick().await; // consume the immediate first tick
        loop {
            ticker.tick().await;
            run_probe_sweep(&registry).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dial_target_ipv4_with_port() {
        assert_eq!(
            dial_target("ws://192.168.1.5:8080/ws"),
            Some("192.168.1.5:8080".to_string())
        );
    }

    #[test]
    fn dial_target_default_ports() {
        assert_eq!(dial_target("ws://host/ws"), Some("host:80".to_string()));
        assert_eq!(dial_target("wss://host/ws"), Some("host:443".to_string()));
    }

    #[test]
    fn dial_target_ipv6_bracketed() {
        assert_eq!(
            dial_target("ws://[fd00::1]:8080/ws"),
            Some("[fd00::1]:8080".to_string())
        );
        assert_eq!(
            dial_target("wss://[fd00::1]/ws"),
            Some("[fd00::1]:443".to_string())
        );
    }

    #[test]
    fn dial_target_rejects_unknown_scheme() {
        assert_eq!(dial_target("ftp://host/x"), None);
        assert_eq!(dial_target("not-a-url"), None);
    }
}
