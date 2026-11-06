//! TCP reachability probing for agent P2P addresses.
//!
//! The server periodically dials each advertised address (issue #43, choice B:
//! "透传 + TCP 可达性探测") so clients can skip endpoints that are known-dead
//! and the UI can show reachability. Probing is a plain TCP connect to the
//! host:port extracted from the WebSocket URL — no handshake, no data sent.

use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use nession_protocol::contracts::agent::v1::AddressStatus;
use tokio::net::TcpStream;

use crate::registry::AgentRegistry;

/// How often to sweep all agent addresses.
const PROBE_INTERVAL: Duration = Duration::from_secs(30);
/// Per-address TCP connect timeout.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How many address probes may be in flight across one sweep.
///
/// The bound is **global to the sweep**, not per Agent: the documented limit is
/// ten addresses per Agent, not ten in total, so a per-Agent bound would still
/// let the sweep duration grow with the deployment. With this many in flight,
/// a wave of blackholed endpoints costs one timeout instead of one per
/// endpoint, and the periodic sweep keeps its 30-second intent (#2839).
pub const PROBE_CONCURRENCY: usize = 32;

/// The dial behind one probe. Production uses [`TcpProbeDialer`]; tests supply
/// a controllable one so a blackholed endpoint and an in-flight registration
/// replacement are deterministic rather than network- and timing-dependent.
#[async_trait::async_trait]
pub trait ProbeDialer: Send + Sync {
    /// Whether `url`'s host answers a TCP connect within `timeout`, with its
    /// round-trip time on success.
    async fn dial(&self, url: &str, timeout: Duration) -> (AddressStatus, Option<u64>);
}

/// The real TCP dialer. No handshake, no data sent.
#[derive(Debug, Clone, Copy, Default)]
pub struct TcpProbeDialer;

#[async_trait::async_trait]
impl ProbeDialer for TcpProbeDialer {
    async fn dial(&self, url: &str, timeout: Duration) -> (AddressStatus, Option<u64>) {
        probe_once(url, timeout).await
    }
}

/// What one sweep did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProbeSweepReport {
    /// Addresses dialled.
    pub probed: usize,
    /// Results written into the registry.
    pub applied: usize,
    /// Results discarded because the Agent re-registered, or the address was
    /// removed, while the probe was in flight.
    pub stale: usize,
}

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
async fn probe_once(url: &str, timeout: Duration) -> (AddressStatus, Option<u64>) {
    let Some(target) = dial_target(url) else {
        return (AddressStatus::Unreachable, None);
    };

    let start = std::time::Instant::now();
    match tokio::time::timeout(timeout, TcpStream::connect(&target)).await {
        Ok(Ok(_stream)) => {
            let rtt = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
            (AddressStatus::Reachable, Some(rtt))
        }
        // Connection error or timeout → unreachable.
        Ok(Err(_)) | Err(_) => (AddressStatus::Unreachable, None),
    }
}

/// Run one full sweep: probe every address of every registered Agent and write
/// results back into the registry.
pub async fn run_probe_sweep(registry: &AgentRegistry) -> ProbeSweepReport {
    run_probe_sweep_with(registry, PROBE_TIMEOUT, PROBE_CONCURRENCY, &TcpProbeDialer).await
}

/// Run one sweep with an explicit timeout, concurrency bound and dialer.
///
/// Every address is dialled through the same bounded stream: at most
/// `concurrency` probes are in flight, no task per address is spawned, and a
/// slow endpoint costs its own timeout rather than the whole sweep's
/// completion (#2839). Each result carries the registration generation the
/// snapshot observed, so a result that lands after the Agent re-registered is
/// counted as `stale` and writes nothing.
pub async fn run_probe_sweep_with<D: ProbeDialer>(
    registry: &AgentRegistry,
    timeout: Duration,
    concurrency: usize,
    dialer: &D,
) -> ProbeSweepReport {
    let targets = registry.list_probe_targets().await;
    let concurrency = concurrency.max(1);

    let probes = targets.into_iter().flat_map(|target| {
        let agent_id = target.agent_id;
        let generation = target.generation;
        target
            .urls
            .into_iter()
            .map(move |url| (agent_id.clone(), generation, url))
    });

    let mut results = stream::iter(probes)
        .map(|(agent_id, generation, url)| async move {
            let (status, rtt_ms) = dialer.dial(&url, timeout).await;
            registry
                .update_address_status(&agent_id, generation, &url, status, rtt_ms)
                .await
        })
        // Polls at most `concurrency` futures; it does not spawn a task per
        // address.
        .buffer_unordered(concurrency);

    let mut report = ProbeSweepReport::default();
    while let Some(applied) = results.next().await {
        report.probed += 1;
        if applied {
            report.applied += 1;
        } else {
            report.stale += 1;
        }
    }
    report
}

/// Spawn the periodic probe task. Sweeps every [`PROBE_INTERVAL`]; the first
/// sweep runs one interval after startup (agents need time to register).
pub fn spawn_probe_task(registry: Arc<AgentRegistry>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(PROBE_INTERVAL);
        ticker.tick().await; // consume the immediate first tick
        loop {
            ticker.tick().await;
            let report = run_probe_sweep(&registry).await;
            tracing::debug!(
                probed = report.probed,
                applied = report.applied,
                stale = report.stale,
                "address probe sweep complete"
            );
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

    #[test]
    fn dial_target_http_https() {
        assert_eq!(dial_target("http://host/x"), Some("host:80".to_string()));
        assert_eq!(dial_target("https://host/x"), Some("host:443".to_string()));
    }

    #[test]
    fn dial_target_empty_authority() {
        assert_eq!(dial_target("ws:///path"), None);
    }

    #[test]
    fn dial_target_hostname_with_port() {
        assert_eq!(
            dial_target("ws://example.com:9000/path"),
            Some("example.com:9000".to_string())
        );
    }

    #[test]
    fn dial_target_query_and_fragment() {
        assert_eq!(
            dial_target("ws://host:8080?query=1"),
            Some("host:8080".to_string())
        );
        assert_eq!(
            dial_target("ws://host:8080#fragment"),
            Some("host:8080".to_string())
        );
    }

    #[test]
    fn dial_target_invalid_port_falls_back_to_default() {
        // When port isn't numeric, fall back to default
        assert_eq!(
            dial_target("ws://host:invalid/ws"),
            Some("host:invalid:80".to_string())
        );
    }

    #[test]
    fn dial_target_trimmed_whitespace() {
        assert_eq!(
            dial_target("  ws://host:8080/ws  "),
            Some("host:8080".to_string())
        );
    }

    #[test]
    fn dial_target_case_insensitive_scheme() {
        assert_eq!(dial_target("WS://host/ws"), Some("host:80".to_string()));
        assert_eq!(dial_target("WSS://host/ws"), Some("host:443".to_string()));
    }

    #[tokio::test]
    async fn probe_once_invalid_url() {
        let (status, rtt) = probe_once("not-a-url", PROBE_TIMEOUT).await;
        assert_eq!(status, AddressStatus::Unreachable);
        assert!(rtt.is_none());
    }

    #[tokio::test]
    async fn probe_once_unreachable_address() {
        // Reserved address (TEST-NET-1, RFC 5737) that should always be unreachable
        let (status, rtt) = probe_once("ws://192.0.2.1:12345/ws", PROBE_TIMEOUT).await;
        assert_eq!(status, AddressStatus::Unreachable);
        assert!(rtt.is_none());
    }
}
