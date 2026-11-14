//! #2839 — bounded address-probe sweeps and registration-generation safety.
//!
//! The sweep must not let the number of blackholed endpoints dictate how long
//! a pass takes, and a result that lands after its Agent re-registered must not
//! write into the successor's status. Both are proven against the real
//! `AgentRegistry`; the dial transport is a controllable fixture so the
//! blackhole and the in-flight race are deterministic rather than dependent on
//! the network or a 30-second schedule.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::Utc;
use nession_protocol::contracts::agent::v1::{
    AddressStatus, AgentAddress, AgentMetadata, NetworkType, ProbedAddress,
};
use nession_server::db::Database;
use nession_server::probe::{run_probe_sweep_with, ProbeDialer};
use nession_server::registry::agent::{AgentInfo, AgentRegistry, AgentStatus};
use tempfile::NamedTempFile;
use tokio::sync::Barrier;

/// A registry backed by a throwaway SQLite file. The guard must outlive it.
async fn test_registry(timeout_secs: u64) -> anyhow::Result<(AgentRegistry, NamedTempFile)> {
    let temp_file = NamedTempFile::new()?;
    let db_path = temp_file
        .path()
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("temp db path is not valid UTF-8"))?
        .to_string();
    let db = Database::new(&db_path).await?;
    Ok((AgentRegistry::new(timeout_secs, Arc::new(db)), temp_file))
}

fn agent_with_urls(agent_id: &str, urls: Vec<String>) -> AgentInfo {
    AgentInfo {
        agent_id: agent_id.to_string(),
        hostname: "probe-host".to_string(),
        ip_address: "10.255.255.1".to_string(),
        port: 9000,
        display_name: None,
        connect_url: None,
        addresses: urls
            .into_iter()
            .map(|url| ProbedAddress {
                address: AgentAddress {
                    url,
                    label: None,
                    network_type: NetworkType::Lan,
                    priority: 0,
                },
                status: AddressStatus::Unknown,
                rtt_ms: None,
            })
            .collect(),
        registered_at: Utc::now(),
        last_heartbeat: Utc::now(),
        status: AgentStatus::Online,
        metadata: AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        },
        session_count: 0,
        active_sessions: 0,
        protocol_manifest: None,
        agent_token: None,
        probe_generation: 0,
        offline_generation: 0,
    }
}

/// Every dial takes the whole per-address timeout and fails — the controlled
/// blackhole. It also records how many dials are in flight at once, which is
/// the sweep's actual concurrency bound.
struct BlackholeDialer {
    timeout: Duration,
    calls: AtomicUsize,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
}

impl BlackholeDialer {
    fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            calls: AtomicUsize::new(0),
            in_flight: AtomicUsize::new(0),
            max_in_flight: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl ProbeDialer for BlackholeDialer {
    async fn dial(&self, _url: &str, _timeout: Duration) -> (AddressStatus, Option<u64>) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let in_flight = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(in_flight, Ordering::SeqCst);
        tokio::time::sleep(self.timeout).await;
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        (AddressStatus::Unreachable, None)
    }
}

/// Holds every dial until the test has re-registered its Agent, then releases
/// all of them.
struct HeldDialer {
    started: Arc<Barrier>,
    release: Arc<Barrier>,
    calls: AtomicUsize,
}

#[async_trait]
impl ProbeDialer for HeldDialer {
    async fn dial(&self, _url: &str, _timeout: Duration) -> (AddressStatus, Option<u64>) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.started.wait().await;
        self.release.wait().await;
        (AddressStatus::Unreachable, None)
    }
}

#[tokio::test]
async fn sc01_bounded_sweep_settles_twenty_blackholed_addresses_without_unbounded_concurrency() {
    let (registry, _db_guard) = test_registry(30).await.unwrap();

    for agent_id in ["agent-a", "agent-b"] {
        let urls = (0..10)
            .map(|index| format!("ws://10.255.255.1:{}/ws", 9100 + index))
            .collect();
        registry.register(agent_with_urls(agent_id, urls)).await;
    }

    let timeout = Duration::from_millis(100);
    let concurrency = 8;
    let dialer = BlackholeDialer::new(timeout);

    let started = Instant::now();
    let report = run_probe_sweep_with(&registry, timeout, concurrency, &dialer).await;
    let elapsed = started.elapsed();

    assert_eq!(report.probed, 20, "every address must be dialled");
    assert_eq!(
        report.applied, 20,
        "every result belongs to its registration"
    );
    assert_eq!(report.stale, 0);
    assert_eq!(dialer.calls.load(Ordering::SeqCst), 20);
    assert!(
        dialer.max_in_flight.load(Ordering::SeqCst) <= concurrency,
        "at most {concurrency} probes may be in flight, measured {}",
        dialer.max_in_flight.load(Ordering::SeqCst)
    );
    assert_eq!(
        dialer.max_in_flight.load(Ordering::SeqCst),
        concurrency,
        "the fixture must actually fill the concurrency bound"
    );

    let serial_baseline = timeout.saturating_mul(20);
    assert!(
        elapsed < serial_baseline / 2,
        "the sweep took {elapsed:?}; the serial 20x-timeout baseline is {serial_baseline:?}"
    );

    for agent_id in ["agent-a", "agent-b"] {
        let agent = registry.get(agent_id).await.unwrap();
        assert_eq!(agent.addresses.len(), 10);
        assert!(
            agent
                .addresses
                .iter()
                .all(|address| address.status == AddressStatus::Unreachable),
            "every status must settle: {agent_id} -> {:?}",
            agent.addresses
        );
    }

    // The Case's evidence is the measurement, not the assertion text.
    eprintln!(
        "#2839 SC-01 measured: elapsed_ms={} probes={} max_in_flight={} serial_baseline_ms={}",
        elapsed.as_millis(),
        report.probed,
        dialer.max_in_flight.load(Ordering::SeqCst),
        serial_baseline.as_millis()
    );
}

#[tokio::test]
async fn sc02_a_stale_probe_result_cannot_overwrite_a_successor_registration() {
    let (registry, _db_guard) = test_registry(30).await.unwrap();
    let url_a = "ws://10.255.255.1:9200/ws".to_string();
    let url_b = "ws://10.255.255.1:9201/ws".to_string();

    registry
        .register(agent_with_urls("agent-a", vec![url_a.clone()]))
        .await;
    registry
        .register(agent_with_urls("agent-b", vec![url_b]))
        .await;

    let started = Arc::new(Barrier::new(3));
    let release = Arc::new(Barrier::new(3));
    let dialer = HeldDialer {
        started: Arc::clone(&started),
        release: Arc::clone(&release),
        calls: AtomicUsize::new(0),
    };

    let sweep = run_probe_sweep_with(&registry, Duration::from_secs(1), 8, &dialer);
    let re_register = async {
        started.wait().await;
        // Both probes are in flight, holding the generation-1 snapshot. The
        // successor keeps the same URL, which is exactly the case a URL-only
        // match would confuse.
        registry
            .register(agent_with_urls("agent-a", vec![url_a]))
            .await;
        release.wait().await;
    };

    let (report, ()) = tokio::join!(sweep, re_register);

    assert_eq!(report.probed, 2);
    assert_eq!(
        report.applied, 1,
        "only the unchanged Agent's result may apply"
    );
    assert_eq!(
        report.stale, 1,
        "the re-registered Agent's in-flight result must be dropped"
    );

    let successor = registry.get("agent-a").await.unwrap();
    assert_eq!(
        successor.addresses[0].status,
        AddressStatus::Unknown,
        "the stale result must not overwrite the successor's fresh status"
    );
    let unchanged = registry.get("agent-b").await.unwrap();
    assert_eq!(
        unchanged.addresses[0].status,
        AddressStatus::Unreachable,
        "an unchanged registration must still receive its matching result"
    );

    eprintln!(
        "#2839 SC-02 measured: probed={} applied={} stale={} successor={:?} unchanged={:?}",
        report.probed,
        report.applied,
        report.stale,
        successor.addresses[0].status,
        unchanged.addresses[0].status
    );
}
