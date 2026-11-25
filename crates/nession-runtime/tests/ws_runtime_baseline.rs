//! Reproducible controlled-load baseline for the WebSocket runtime (`#4437`).
//!
//! This is the "baseline before fixing production SLO" half of the
//! Requirement: a fixed workload over the real execution primitives (query
//! lane, keyed mutation lane, classified outbound), a bounded run, and a
//! captured report with latency percentiles, memory, task/queue high-water
//! and quiescent values.
//!
//! It is deliberately a test rather than a benchmark harness: the repository's
//! Rust test route runs it at the exact PR head, so the numbers are tied to a
//! SHA and a runner class. Candidate latency targets are recorded, never a
//! production SLO.
//!
//! Run: `cargo test -p nession-runtime --test ws_runtime_baseline -- --nocapture`
//! The JSON report is printed on one `WS_RUNTIME_BASELINE {…}` line and written
//! to `$CARGO_TARGET_DIR/ws-runtime-baseline.json` (default `target/`).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nession_runtime::lane::{KeyedLane, QueryLane, Work};
use nession_runtime::metrics::{self, Metric, MetricSink};
use nession_runtime::outbound::{ClassLimits, ClassifiedLimits, Outbound};
use tokio::sync::mpsc;

const QUERIES: usize = 5_000;
const MUTATIONS: usize = 2_000;
const KEYS: usize = 32;
const OUTBOUND_FRAMES: usize = 2_000;
const QUERY_BOUND: usize = 8;
const KEY_DEPTH: usize = 4;
const OUTBOUND_BYTES: usize = 256 * 1024;
const OUTBOUND_FRAME_LIMIT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TestKey(usize);

impl std::fmt::Display for TestKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "key:{}", self.0)
    }
}

/// A non-blocking counting sink: the baseline proves the owners emit, without
/// letting collection change the measurement.
#[derive(Default)]
struct CountingSink {
    counts: Mutex<BTreeMap<&'static str, u64>>,
}

impl MetricSink for CountingSink {
    fn record(&self, metric: Metric) {
        if let Ok(mut counts) = self.counts.lock() {
            *counts.entry(metric.name).or_default() += 1;
        }
    }
}

// A percentile rank is bounded arithmetic on a test's own sample count.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn percentile(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    let index = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted.get(index).copied().unwrap_or(0)
}

fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

fn memory_kb() -> u64 {
    let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
        return 0;
    };
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            if let Some(kb) = rest.split_whitespace().next() {
                return kb.parse().unwrap_or(0);
            }
        }
    }
    0
}

fn processor_class() -> (String, usize) {
    let model = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|cpuinfo| {
            cpuinfo.lines().find_map(|line| {
                line.strip_prefix("model name")
                    .and_then(|rest| rest.split_once(':'))
                    .map(|(_, value)| value.trim().to_string())
            })
        })
        .unwrap_or_else(|| "unknown".to_string());
    let cores = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(0);
    (model, cores)
}

fn source_sha() -> String {
    std::env::var("GITHUB_SHA")
        .ok()
        .or_else(|| std::env::var("CI_COMMIT_SHA").ok())
        .filter(|sha| !sha.is_empty())
        .unwrap_or_else(|| "local".to_string())
}

fn latency_block(samples: &[u64]) -> serde_json::Value {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    serde_json::json!({
        "samples": sorted.len(),
        "p50_ns": percentile(&sorted, 50.0),
        "p95_ns": percentile(&sorted, 95.0),
        "p99_ns": percentile(&sorted, 99.0),
        "max_ns": sorted.last().copied().unwrap_or(0),
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_controlled_load_baseline_is_reproducible_and_settles() {
    let sink = Arc::new(CountingSink::default());
    metrics::set_sink(Some(Arc::clone(&sink) as Arc<dyn MetricSink>));

    let memory_before = memory_kb();

    // ── Query lane: admission + execution, bounded at QUERY_BOUND ──────────
    let mut queries = QueryLane::new(QUERY_BOUND, "baseline ");
    let (query_tx, mut query_rx) = mpsc::channel::<u64>(QUERIES);
    let mut query_admission = Vec::with_capacity(QUERIES);
    for _ in 0..QUERIES {
        let started = Instant::now();
        let tx = query_tx.clone();
        queries
            .dispatch(async move {
                let _ = tx.send(nanos(started.elapsed())).await;
            })
            .await;
        query_admission.push(nanos(started.elapsed()));
    }
    drop(query_tx);
    queries.drain().await;
    let mut query_e2e = Vec::with_capacity(QUERIES);
    while let Some(ns) = query_rx.recv().await {
        query_e2e.push(ns);
    }
    let query_snapshot = queries.snapshot();

    // ── Keyed mutation lane: changing keys, bounded depth ──────────────────
    let mut mutations = KeyedLane::new(KEY_DEPTH, "baseline-key ");
    let (mutation_tx, mut mutation_rx) = mpsc::channel::<u64>(MUTATIONS);
    for n in 0..MUTATIONS {
        let started = Instant::now();
        let tx = mutation_tx.clone();
        let work: Work = Box::pin(async move {
            let _ = tx.send(nanos(started.elapsed())).await;
        });
        mutations.enqueue(TestKey(n % KEYS), work).await;
    }
    drop(mutation_tx);
    mutations.drain().await;
    let mut mutation_e2e = Vec::with_capacity(MUTATIONS);
    while let Some(ns) = mutation_rx.recv().await {
        mutation_e2e.push(ns);
    }
    let key_snapshot = mutations.snapshot().await;

    // ── Classified outbound: bounded queues with a draining writer ─────────
    let limits = ClassifiedLimits {
        control: ClassLimits {
            bytes: OUTBOUND_BYTES,
            frames: OUTBOUND_FRAME_LIMIT,
        },
        response: ClassLimits {
            bytes: OUTBOUND_BYTES,
            frames: OUTBOUND_FRAME_LIMIT,
        },
        stream: ClassLimits {
            bytes: OUTBOUND_BYTES,
            frames: OUTBOUND_FRAME_LIMIT,
        },
    };
    let (outbound, mut receiver) =
        Outbound::new("baseline outbound", limits, Duration::from_secs(1));
    let writer = tokio::spawn(async move {
        while let Some(frame) = receiver.recv().await {
            drop(frame);
        }
    });
    let mut outbound_admission = Vec::with_capacity(OUTBOUND_FRAMES);
    for n in 0..OUTBOUND_FRAMES {
        let frame = nession_runtime::frame::WsFrame::Text(format!("baseline-{n}"));
        let started = Instant::now();
        outbound
            .send_reply(frame)
            .await
            .expect("the baseline queue accepts its own fixed frame");
        outbound_admission.push(nanos(started.elapsed()));
    }
    outbound.close();
    writer.await.expect("the baseline writer stops");
    let outbound_snapshot = outbound.snapshot();

    let memory_after = memory_kb();
    let (cpu, cores) = processor_class();
    let counts = sink
        .counts
        .lock()
        .map(|counts| counts.clone())
        .unwrap_or_default();

    let report = serde_json::json!({
        "schema_version": 1,
        "kind": "ws_runtime_baseline",
        "sha": source_sha(),
        "runner": {
            "class": if std::env::var("CI").is_ok() { "ci" } else { "local" },
            "cores": cores,
            "cpu": cpu,
        },
        "workload": {
            "queries": QUERIES,
            "mutations": MUTATIONS,
            "keys": KEYS,
            "outbound_frames": OUTBOUND_FRAMES,
            "query_bound": QUERY_BOUND,
            "key_depth": KEY_DEPTH,
            "outbound_class_bytes": OUTBOUND_BYTES,
            "outbound_class_frames": OUTBOUND_FRAME_LIMIT,
        },
        "latency": {
            "query_admission": latency_block(&query_admission),
            "query_end_to_end": latency_block(&query_e2e),
            "mutation_end_to_end": latency_block(&mutation_e2e),
            "outbound_admission": latency_block(&outbound_admission),
        },
        "memory_kb": { "before": memory_before, "after": memory_after },
        "high_water": {
            "query_peak_in_flight": query_snapshot.peak_in_flight,
            "query_bound": query_snapshot.bound,
            "key_deepest": key_snapshot.deepest,
            "key_depth": key_snapshot.depth,
            "outbound_queued_bytes": outbound_snapshot.queued_bytes,
            "outbound_byte_budget": outbound_snapshot.byte_budget,
        },
        "quiescent": {
            "query_in_flight": query_snapshot.in_flight,
            "query_retained": query_snapshot.retained,
            "key_keys": key_snapshot.keys,
            "key_queued": key_snapshot.queued,
            "key_retained": key_snapshot.retained,
            "outbound_queued_bytes": outbound_snapshot.queued_bytes,
            "outbound_queued_frames": outbound_snapshot.queued_frames,
        },
        "metrics": counts,
    });

    // Write under the workspace target, not the crate-relative `target/` that
    // `cargo test` uses as cwd — that path is not the workspace's ignored
    // build directory and a previous run accidentally committed it (#4437).
    let target_dir = std::env::var("CARGO_TARGET_DIR")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../target").to_string());
    let path = std::path::Path::new(&target_dir).join("ws-runtime-baseline.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        &path,
        serde_json::to_vec_pretty(&report).unwrap_or_default(),
    );
    println!(
        "WS_RUNTIME_BASELINE {}",
        serde_json::to_string(&report).unwrap_or_default()
    );

    // ── The report is only evidence if the run settled ────────────────────
    assert_eq!(query_snapshot.in_flight, 0, "queries did not settle");
    assert_eq!(
        query_snapshot.retained, 0,
        "finished query records retained"
    );
    assert_eq!(key_snapshot.keys, 0, "a key outlived quiescence");
    assert_eq!(key_snapshot.queued, 0, "mutation work outlived quiescence");
    assert_eq!(key_snapshot.retained, 0, "finished worker records retained");
    assert_eq!(outbound_snapshot.queued_bytes, 0, "outbound bytes retained");
    assert_eq!(
        outbound_snapshot.queued_frames, 0,
        "outbound frames retained"
    );
    assert!(usize::try_from(query_snapshot.peak_in_flight).unwrap_or(usize::MAX) <= QUERY_BOUND);
    assert_eq!(key_snapshot.depth, KEY_DEPTH);

    let latency = &report["latency"];
    for key in [
        "query_admission",
        "query_end_to_end",
        "mutation_end_to_end",
        "outbound_admission",
    ] {
        let p50 = latency[key]["p50_ns"].as_u64().unwrap_or(0);
        let p99 = latency[key]["p99_ns"].as_u64().unwrap_or(0);
        assert_eq!(
            latency[key]["samples"].as_u64(),
            Some(match key {
                "query_admission" => QUERIES as u64,
                "query_end_to_end" => QUERIES as u64,
                "mutation_end_to_end" => MUTATIONS as u64,
                _ => OUTBOUND_FRAMES as u64,
            })
        );
        assert!(p50 <= p99, "{key}: p50 exceeds p99");
    }

    // The owners emitted through the contract; collection stayed non-blocking.
    assert!(
        counts.get("ws_admission_accepted").copied().unwrap_or(0) > 0,
        "lane admissions were not instrumented: {counts:?}"
    );
    assert!(
        counts.get("ws_outbound_accepted").copied().unwrap_or(0) > 0,
        "outbound submissions were not instrumented: {counts:?}"
    );
    assert!(
        counts.get("ws_task_reaped").copied().unwrap_or(0) > 0,
        "steady-state reaping was not instrumented: {counts:?}"
    );
    assert!(
        counts.get("ws_request_duration").copied().unwrap_or(0) > 0,
        "query duration histogram was not instrumented: {counts:?}"
    );
    assert!(path.exists(), "the baseline report was not written");

    metrics::set_sink(None);
}
