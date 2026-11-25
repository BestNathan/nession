//! WebSocket runtime telemetry (`#4437`).
//!
//! The runtime already keeps typed snapshots at its owners — lanes, the
//! classified outbound, the lifecycle. This module is the **contract** those
//! owners emit through: bounded label enums, one metric record, an optional
//! sink, and a bounded exporter.
//!
//! Two rules decide the shape:
//!
//! * **Labels are closed enums, never identifiers.** There is no API here that
//!   accepts a session, agent, request, connection, wire, path or command
//!   string, so a high-cardinality label cannot be written by accident.
//! * **Collection is optional and bounded.** The default sink is a no-op. An
//!   exporter is a bounded channel that drops (and counts) rather than waiting:
//!   a missing or stalled collector can never delay message handling.
//!
//! Metric names, kinds and units are owned by [`METRIC_CATALOG`]; the versioned
//! dashboard definitions in `assets/ws-runtime-dashboards.json` are validated
//! against it by a test, so a dashboard cannot name a metric the runtime does
//! not emit.

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use tokio::sync::{mpsc, Notify};

/// Which runtime emitted the metric.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    Server,
    AgentCentral,
    AgentP2p,
    Relay,
    Runtime,
}

impl RuntimeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::AgentCentral => "agent_central",
            Self::AgentP2p => "agent_p2p",
            Self::Relay => "relay",
            Self::Runtime => "runtime",
        }
    }
}

/// The peer a metric is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerKind {
    Browser,
    Agent,
    Relay,
    Local,
}

impl PeerKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Agent => "agent",
            Self::Relay => "relay",
            Self::Local => "local",
        }
    }
}

/// The transport a metric is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    Plain,
    Tls,
}

impl TransportKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Tls => "tls",
        }
    }
}

/// The runtime, peer and transport one emit site belongs to (#4437 SC-02).
///
/// A process hosts more than one connection kind — the Agent serves central and
/// peer-to-peer sockets; the Server serves browser and relay legs. Without this
/// identity every sample of one connection is indistinguishable from another's,
/// so a refused admission cannot be attributed. Every owner that constructs a
/// lane or an outbound path supplies its identity once, beside the code that
/// knows what the connection is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetricsIdentity {
    pub runtime: RuntimeKind,
    pub peer: PeerKind,
    pub transport: TransportKind,
}

impl MetricsIdentity {
    pub const fn new(runtime: RuntimeKind, peer: PeerKind, transport: TransportKind) -> Self {
        Self {
            runtime,
            peer,
            transport,
        }
    }
}

/// The dispatch/ownership domain a metric belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    Control,
    Request,
    Stream,
    Lifecycle,
    Admission,
}

impl Domain {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Control => "control",
            Self::Request => "request",
            Self::Stream => "stream",
            Self::Lifecycle => "lifecycle",
            Self::Admission => "admission",
        }
    }
}

/// The direction of the work a metric is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Inbound,
    Outbound,
    Internal,
}

impl Direction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inbound => "inbound",
            Self::Outbound => "outbound",
            Self::Internal => "internal",
        }
    }
}

/// The terminal outcome a counter is counting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultKind {
    Accepted,
    Refused,
    Completed,
    Timeout,
    Cancelled,
    Failed,
    Closed,
    Dropped,
    Reaped,
    Panicked,
    Stalled,
    TooLarge,
    StaleGeneration,
    Coalesced,
    Gap,
    Replay,
    Recovered,
}

impl ResultKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Refused => "refused",
            Self::Completed => "completed",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
            Self::Closed => "closed",
            Self::Dropped => "dropped",
            Self::Reaped => "reaped",
            Self::Panicked => "panicked",
            Self::Stalled => "stalled",
            Self::TooLarge => "too_large",
            Self::StaleGeneration => "stale_generation",
            Self::Coalesced => "coalesced",
            Self::Gap => "gap",
            Self::Replay => "replay",
            Self::Recovered => "recovered",
        }
    }
}

/// Why a result happened. A bounded vocabulary, not an error string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasonKind {
    None,
    Saturated,
    Overload,
    WriteTimeout,
    WriteError,
    PeerClosed,
    AuthTimeout,
    Shutdown,
    ReadError,
    Protocol,
    Resource,
    Disconnect,
    Replacement,
    Capacity,
    Panic,
    Stalled,
    LocalClose,
    Aborted,
}

impl ReasonKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Saturated => "saturated",
            Self::Overload => "overload",
            Self::WriteTimeout => "write_timeout",
            Self::WriteError => "write_error",
            Self::PeerClosed => "peer_closed",
            Self::AuthTimeout => "auth_timeout",
            Self::Shutdown => "shutdown",
            Self::ReadError => "read_error",
            Self::Protocol => "protocol",
            Self::Resource => "resource",
            Self::Disconnect => "disconnect",
            Self::Replacement => "replacement",
            Self::Capacity => "capacity",
            Self::Panic => "panic",
            Self::Stalled => "stalled",
            Self::LocalClose => "local_close",
            Self::Aborted => "aborted",
        }
    }
}

/// The unit a metric value is in. Stated at the owner so a reader never has to
/// infer it from a name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitKind {
    Count,
    Byte,
    Nanosecond,
    Millisecond,
    Ratio,
}

impl UnitKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Count => "count",
            Self::Byte => "byte",
            Self::Nanosecond => "nanosecond",
            Self::Millisecond => "millisecond",
            Self::Ratio => "ratio",
        }
    }
}

/// The aggregation a metric requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetricKind {
    Counter,
    Gauge,
    Histogram,
}

impl MetricKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Counter => "counter",
            Self::Gauge => "gauge",
            Self::Histogram => "histogram",
        }
    }
}

/// One metric the runtime may emit.
///
/// The catalog is the executable owner of names, kinds and units. A dashboard
/// or a metric not in it is a programming error, and the dashboard test says so.
#[derive(Debug, Clone, Copy)]
pub struct MetricDef {
    pub name: &'static str,
    pub kind: MetricKind,
    pub unit: UnitKind,
    pub domain: Domain,
    pub description: &'static str,
}

const fn def(
    name: &'static str,
    kind: MetricKind,
    unit: UnitKind,
    domain: Domain,
    description: &'static str,
) -> MetricDef {
    MetricDef {
        name,
        kind,
        unit,
        domain,
        description,
    }
}

/// The versioned shape of the emitted record and catalog. A breaking change to
/// the enums, units or catalog bumps this; dashboard definitions carry the same
/// version.
pub const METRIC_SCHEMA_VERSION: u32 = 1;

/// Every metric name the runtime emits.
pub const METRIC_CATALOG: &[MetricDef] = &[
    def(
        "ws_connection_active",
        MetricKind::Gauge,
        UnitKind::Count,
        Domain::Lifecycle,
        "connections currently open",
    ),
    def(
        "ws_connection_attempts",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Lifecycle,
        "connection attempts observed by the runtime",
    ),
    def(
        "ws_connection_closed",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Lifecycle,
        "connections closed, by bounded result/reason",
    ),
    def(
        "ws_admission_accepted",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Admission,
        "frames admitted without waiting",
    ),
    def(
        "ws_admission_refused",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Admission,
        "frames refused before acceptance",
    ),
    def(
        "ws_admission_waited",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Admission,
        "admissions that had to wait for room",
    ),
    def(
        "ws_task_active",
        MetricKind::Gauge,
        UnitKind::Count,
        Domain::Request,
        "lane tasks running",
    ),
    def(
        "ws_task_retained",
        MetricKind::Gauge,
        UnitKind::Count,
        Domain::Request,
        "task records held: running plus finished-not-reaped",
    ),
    def(
        "ws_task_reaped",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Request,
        "finished task records reaped in steady state",
    ),
    def(
        "ws_task_panicked",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Request,
        "tasks that ended by panicking",
    ),
    def(
        "ws_request_duration",
        MetricKind::Histogram,
        UnitKind::Millisecond,
        Domain::Request,
        "admitted query execution time, in milliseconds",
    ),
    def(
        "ws_outbound_queued",
        MetricKind::Gauge,
        UnitKind::Byte,
        Domain::Stream,
        "bytes queued for the writer, including in-flight",
    ),
    def(
        "ws_outbound_accepted",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Stream,
        "outbound submissions accepted",
    ),
    def(
        "ws_outbound_refused",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Stream,
        "outbound submissions refused",
    ),
    def(
        "ws_outbound_too_large",
        MetricKind::Counter,
        UnitKind::Byte,
        Domain::Stream,
        "bytes refused because a frame exceeded its class maximum",
    ),
    def(
        "ws_outbound_write_timeout",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Stream,
        "writes that hit their finite deadline",
    ),
    def(
        "ws_stream_credit_lag",
        MetricKind::Gauge,
        UnitKind::Byte,
        Domain::Stream,
        "subscriber credit bytes issued but not yet applied",
    ),
    def(
        "ws_stream_progress_lag",
        MetricKind::Gauge,
        UnitKind::Count,
        Domain::Stream,
        "parser progress events behind the issued frontier",
    ),
    def(
        "ws_stream_gap",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Stream,
        "stream gaps observed; the direction label separates terminal input from output",
    ),
    def(
        "ws_stream_replay",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Stream,
        "replay windows served",
    ),
    def(
        "ws_stream_coalesced",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Stream,
        "latest-state frames replaced by a newer value",
    ),
    def(
        "ws_pending_outcome",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Control,
        "pending request/broker terminal outcomes, by result/reason",
    ),
    def(
        "ws_exporter_dropped",
        MetricKind::Counter,
        UnitKind::Count,
        Domain::Lifecycle,
        "metrics dropped because the exporter queue was full or closed",
    ),
];

/// The catalog entry for `name`, if the runtime emits it.
pub fn metric_def(name: &str) -> Option<&'static MetricDef> {
    METRIC_CATALOG.iter().find(|def| def.name == name)
}

/// The bounded label set on one metric.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Labels {
    pub runtime: Option<RuntimeKind>,
    pub peer: Option<PeerKind>,
    pub transport: Option<TransportKind>,
    pub domain: Option<Domain>,
    pub direction: Option<Direction>,
    pub result: Option<ResultKind>,
    pub reason: Option<ReasonKind>,
}

impl Labels {
    pub const fn new() -> Self {
        Self {
            runtime: None,
            peer: None,
            transport: None,
            domain: None,
            direction: None,
            result: None,
            reason: None,
        }
    }

    pub const fn runtime(mut self, value: RuntimeKind) -> Self {
        self.runtime = Some(value);
        self
    }

    pub const fn peer(mut self, value: PeerKind) -> Self {
        self.peer = Some(value);
        self
    }

    pub const fn transport(mut self, value: TransportKind) -> Self {
        self.transport = Some(value);
        self
    }

    /// Apply the connection's runtime/peer/transport identity (#4437 SC-02).
    pub const fn identity(mut self, identity: MetricsIdentity) -> Self {
        self.runtime = Some(identity.runtime);
        self.peer = Some(identity.peer);
        self.transport = Some(identity.transport);
        self
    }

    pub const fn domain(mut self, value: Domain) -> Self {
        self.domain = Some(value);
        self
    }

    pub const fn direction(mut self, value: Direction) -> Self {
        self.direction = Some(value);
        self
    }

    pub const fn result(mut self, value: ResultKind) -> Self {
        self.result = Some(value);
        self
    }

    pub const fn reason(mut self, value: ReasonKind) -> Self {
        self.reason = Some(value);
        self
    }

    /// The labels as stable `key="value"` pairs. Every value comes from an enum,
    /// so there is no place for an identifier to enter.
    pub fn pairs(&self) -> Vec<(&'static str, &'static str)> {
        let mut pairs = Vec::with_capacity(7);
        if let Some(v) = self.runtime {
            pairs.push(("runtime", v.as_str()));
        }
        if let Some(v) = self.peer {
            pairs.push(("peer", v.as_str()));
        }
        if let Some(v) = self.transport {
            pairs.push(("transport", v.as_str()));
        }
        if let Some(v) = self.domain {
            pairs.push(("domain", v.as_str()));
        }
        if let Some(v) = self.direction {
            pairs.push(("direction", v.as_str()));
        }
        if let Some(v) = self.result {
            pairs.push(("result", v.as_str()));
        }
        if let Some(v) = self.reason {
            pairs.push(("reason", v.as_str()));
        }
        pairs
    }
}

/// One recorded metric.
#[derive(Debug, Clone, Copy)]
pub struct Metric {
    pub name: &'static str,
    pub kind: MetricKind,
    pub unit: UnitKind,
    pub labels: Labels,
    pub value: f64,
}

impl Metric {
    /// Build a metric from a catalog name. `None` for a name the runtime does
    /// not emit, which is how a typo fails at the call site instead of becoming
    /// a dashboard query that can never match.
    pub fn new(name: &'static str, labels: Labels, value: f64) -> Option<Self> {
        let def = metric_def(name)?;
        Some(Self {
            name,
            kind: def.kind,
            unit: def.unit,
            labels,
            value,
        })
    }
}

impl fmt::Display for Metric {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {} ({})", self.name, self.value, self.kind.as_str())?;
        for (key, value) in self.labels.pairs() {
            write!(f, " {key}=\"{value}\"")?;
        }
        Ok(())
    }
}

/// Where metrics go. Implementations must not block the caller: a collector is
/// optional infrastructure and never a message-path dependency.
pub trait MetricSink: Send + Sync + 'static {
    fn record(&self, metric: Metric);
}

/// The default sink: collection is off.
#[derive(Debug, Default)]
pub struct NoopSink;

impl MetricSink for NoopSink {
    fn record(&self, _metric: Metric) {}
}

static SINK: OnceLock<RwLock<Option<Arc<dyn MetricSink>>>> = OnceLock::new();

/// Serializes tests that install a process-wide capture sink. The sink is a
/// process fact, so two tests setting it concurrently would observe each
/// other's emissions or clear each other's sink.
#[cfg(test)]
pub(crate) static TEST_SINK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A capture sink for cross-module instrumentation tests.
#[cfg(test)]
pub(crate) struct TestCapture {
    names: std::sync::Mutex<Vec<&'static str>>,
}

#[cfg(test)]
impl TestCapture {
    pub(crate) fn new() -> Self {
        Self {
            names: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn names(&self) -> Vec<&'static str> {
        self.names
            .lock()
            .map(|names| names.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
impl MetricSink for TestCapture {
    fn record(&self, metric: Metric) {
        if let Ok(mut names) = self.names.lock() {
            names.push(metric.name);
        }
    }
}
/// Fast path: the hot message path checks one relaxed load and returns when
/// collection is off, before building any labels.
static ENABLED: AtomicBool = AtomicBool::new(false);

fn sink_slot() -> &'static RwLock<Option<Arc<dyn MetricSink>>> {
    SINK.get_or_init(|| RwLock::new(None))
}

/// Install (or remove) the process sink. Callers own this; the runtime only
/// consumes it.
pub fn set_sink(sink: Option<Arc<dyn MetricSink>>) {
    // Drop a replaced sink outside the process-wide write lock: a sink's Drop
    // is arbitrary code and may block or take its own locks.
    let previous = match sink_slot().write() {
        Ok(mut slot) => {
            ENABLED.store(sink.is_some(), Ordering::Release);
            let previous = slot.take();
            *slot = sink;
            previous
        }
        Err(_) => None,
    };
    drop(previous);
}

/// Whether a sink is installed. Owners use this to skip building labels.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Acquire)
}

/// Record one metric through the installed sink. With no sink installed this
/// is one atomic load and a return.
pub fn record(name: &'static str, labels: Labels, value: f64) {
    if !enabled() {
        return;
    }
    let Some(metric) = Metric::new(name, labels, value) else {
        return;
    };
    // Clone the sink under the read lock, then release the process-wide lock
    // before calling sink code. A sink is arbitrary code and may block or
    // acquire its own locks; holding the global slot lock across it can
    // deadlock with `set_sink` (observed as the rust-coverage hang, #4515).
    let sink = match sink_slot().read() {
        Ok(slot) => slot.as_ref().cloned(),
        Err(_) => None,
    };
    if let Some(sink) = sink {
        sink.record(metric);
    }
}

/// Record a counter increment.
pub fn counter(name: &'static str, labels: Labels) {
    record(name, labels, 1.0);
}

/// Record a gauge sample.
pub fn gauge(name: &'static str, labels: Labels, value: f64) {
    record(name, labels, value);
}

/// A bounded exporter over another sink.
///
/// `record` is a `try_send`: when the queue is full (a stalled collector) the
/// metric is dropped and counted, never awaited. The forwarder is a single task
/// that drains the queue into `inner`.
pub struct BoundedExporter {
    tx: mpsc::Sender<Metric>,
    drops: Arc<AtomicU64>,
    /// Wakes the forwarder when a drop occurred, so the loss metric is
    /// published promptly instead of waiting for the next batch.
    wake: Arc<Notify>,
}

impl BoundedExporter {
    /// Start a bounded exporter of `capacity` metrics into `inner`.
    ///
    /// Must be called inside a Tokio runtime (the forwarder is a task).
    ///
    /// The forwarder is also the **emit owner** for `ws_exporter_dropped`: it
    /// publishes the delta of [`drops`](Self::drops) into `inner` directly
    /// (never through the bounded queue, so the loss metric cannot itself be
    /// dropped or counted twice). While the collector is stalled the loss
    /// cannot be delivered — nothing can — but it is accrued and published in
    /// full once the collector makes progress again.
    pub fn spawn(inner: Arc<dyn MetricSink>, capacity: usize) -> Arc<Self> {
        let (tx, mut rx) = mpsc::channel::<Metric>(capacity.max(1));
        let drops = Arc::new(AtomicU64::new(0));
        let exporter_drops = Arc::clone(&drops);
        let wake = Arc::new(Notify::new());
        let exporter_wake = Arc::clone(&wake);
        tokio::spawn(async move {
            let mut reported = 0u64;
            loop {
                tokio::select! {
                    maybe = rx.recv() => match maybe {
                        Some(metric) => inner.record(metric),
                        None => break,
                    },
                    () = exporter_wake.notified() => {}
                }
                // Publish whatever was dropped since the last report. This is
                // the owner `ws_exporter_dropped` was missing (#4501).
                let total = exporter_drops.load(Ordering::Relaxed);
                if total > reported {
                    let delta = total - reported;
                    reported = total;
                    if let Some(metric) = Metric::new(
                        "ws_exporter_dropped",
                        Labels::new().domain(Domain::Lifecycle),
                        delta as f64,
                    ) {
                        inner.record(metric);
                    }
                }
            }
            // A drop can land between the last observation and the senders
            // going away; report it before the task ends.
            let total = exporter_drops.load(Ordering::Relaxed);
            if total > reported {
                let delta = total - reported;
                if let Some(metric) = Metric::new(
                    "ws_exporter_dropped",
                    Labels::new().domain(Domain::Lifecycle),
                    delta as f64,
                ) {
                    inner.record(metric);
                }
            }
        });
        Arc::new(Self { tx, drops, wake })
    }

    /// Metrics dropped because the queue was full or closed.
    pub fn drops(&self) -> u64 {
        self.drops.load(Ordering::Relaxed)
    }
}

impl MetricSink for BoundedExporter {
    fn record(&self, metric: Metric) {
        if self.tx.try_send(metric).is_err() {
            self.drops.fetch_add(1, Ordering::Relaxed);
            self.wake.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Capture {
        metrics: Mutex<Vec<Metric>>,
    }

    impl MetricSink for Capture {
        fn record(&self, metric: Metric) {
            if let Ok(mut metrics) = self.metrics.lock() {
                metrics.push(metric);
            }
        }
    }

    #[test]
    fn the_catalog_is_unique_and_bounded() {
        let mut names: Vec<&str> = METRIC_CATALOG.iter().map(|def| def.name).collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count, "a metric name is declared twice");
        for def in METRIC_CATALOG {
            assert!(
                def.name.starts_with("ws_"),
                "unowned namespace: {}",
                def.name
            );
        }
    }

    #[test]
    fn labels_are_only_the_bounded_vocabulary() {
        let labels = Labels::new()
            .runtime(RuntimeKind::Server)
            .peer(PeerKind::Browser)
            .transport(TransportKind::Tls)
            .domain(Domain::Request)
            .direction(Direction::Inbound)
            .result(ResultKind::Refused)
            .reason(ReasonKind::Saturated);
        let pairs = labels.pairs();
        assert_eq!(pairs.len(), 7);
        // There is no API that accepts a free-form value, so this is the whole
        // label surface.
        for (key, value) in pairs {
            assert!(!key.contains('='));
            assert!(!value.is_empty());
            assert!(!value.contains('/'), "a path-like label leaked: {value}");
        }
    }

    const DASHBOARDS: &str = include_str!("../assets/ws-runtime-dashboards.json");

    fn bounded_label(key: &str, value: &str) -> bool {
        match key {
            "runtime" => {
                ["server", "agent_central", "agent_p2p", "relay", "runtime"].contains(&value)
            }
            "peer" => ["browser", "agent", "relay", "local"].contains(&value),
            "transport" => ["plain", "tls"].contains(&value),
            "domain" => ["control", "request", "stream", "lifecycle", "admission"].contains(&value),
            "direction" => ["inbound", "outbound", "internal"].contains(&value),
            "result" => [
                "accepted",
                "refused",
                "completed",
                "timeout",
                "cancelled",
                "failed",
                "closed",
                "dropped",
                "reaped",
                "panicked",
                "stalled",
                "too_large",
                "stale_generation",
                "coalesced",
                "gap",
                "replay",
                "recovered",
            ]
            .contains(&value),
            "reason" => [
                "none",
                "saturated",
                "overload",
                "write_timeout",
                "write_error",
                "peer_closed",
                "auth_timeout",
                "shutdown",
                "read_error",
                "protocol",
                "resource",
                "disconnect",
                "replacement",
                "capacity",
                "panic",
                "stalled",
                "local_close",
                "aborted",
            ]
            .contains(&value),
            _ => false,
        }
    }

    #[test]
    fn dashboards_reference_declared_metrics_and_bounded_labels() {
        let doc: serde_json::Value =
            serde_json::from_str(DASHBOARDS).expect("dashboards are valid JSON");
        assert_eq!(doc["schema_version"].as_u64(), Some(1));
        let dashboards = doc["dashboards"].as_array().expect("dashboards array");
        let ids: Vec<&str> = dashboards.iter().filter_map(|d| d["id"].as_str()).collect();
        for required in ["overview", "request", "stream", "lifecycle"] {
            assert!(ids.contains(&required), "missing dashboard {required}");
        }
        for dashboard in dashboards {
            let panels = dashboard["panels"].as_array().expect("panels array");
            assert!(!panels.is_empty(), "a dashboard has no panels");
            for panel in panels {
                let name = panel["metric"].as_str().expect("panel metric");
                let def = metric_def(name)
                    .unwrap_or_else(|| panic!("dashboard names unemitted metric {name}"));
                assert_eq!(
                    panel["kind"].as_str(),
                    Some(def.kind.as_str()),
                    "kind mismatch for {name}"
                );
                if let Some(labels) = panel.get("labels") {
                    for (key, value) in labels.as_object().expect("labels object") {
                        let value = value.as_str().expect("label value is a string");
                        assert!(
                            bounded_label(key, value),
                            "dashboard uses an unbounded label {key}={value}"
                        );
                    }
                }
            }
        }
    }

    /// #4502: a byte counter must not be presented as a frame count, and the
    /// gap metric's two surfaces must stay visibly separate in the panels.
    #[test]
    fn dashboards_keep_gap_directions_and_byte_units_honest() {
        let doc: serde_json::Value =
            serde_json::from_str(DASHBOARDS).expect("dashboards are valid JSON");
        let dashboards = doc["dashboards"].as_array().expect("dashboards array");
        let mut gap_directions = Vec::new();
        for dashboard in dashboards {
            for panel in dashboard["panels"].as_array().expect("panels array") {
                let name = panel["metric"].as_str().expect("panel metric");
                let def = metric_def(name).expect("panel names a catalogued metric");
                let title = panel["title"]
                    .as_str()
                    .expect("panel title")
                    .to_ascii_lowercase();
                if def.unit == UnitKind::Byte {
                    assert!(
                        !title.contains("frame") || title.contains("byte"),
                        "panel {name} measures bytes but its title claims frames: {title}"
                    );
                }
                if name == "ws_stream_gap" {
                    let direction = panel["labels"]["direction"]
                        .as_str()
                        .expect("a gap panel names its direction");
                    gap_directions.push(direction.to_string());
                }
            }
        }
        gap_directions.sort();
        gap_directions.dedup();
        assert_eq!(
            gap_directions,
            vec!["inbound".to_string(), "outbound".to_string()],
            "input and output gaps are not separately observable"
        );
    }

    #[tokio::test]
    async fn an_unknown_metric_name_is_not_recorded() {
        let _guard = TEST_SINK_LOCK.lock().await;
        let capture = Arc::new(Capture::default());
        set_sink(Some(Arc::clone(&capture) as Arc<dyn MetricSink>));
        record("ws_not_a_metric", Labels::new(), 1.0);
        record(
            "ws_admission_refused",
            Labels::new().domain(Domain::Admission),
            1.0,
        );
        // Other crate tests may emit through the same process sink while this
        // one runs; the assertion is about the named events, not the total.
        let metrics = capture.metrics.lock().expect("capture lock");
        assert!(
            metrics
                .iter()
                .all(|metric| metric.name != "ws_not_a_metric"),
            "an un-catalogued name was recorded"
        );
        let recorded = metrics
            .iter()
            .find(|metric| metric.name == "ws_admission_refused")
            .expect("the catalogued metric was not recorded");
        assert_eq!(recorded.kind, MetricKind::Counter);
        // Release the capture lock before `set_sink` takes the global write
        // lock. Holding it across `set_sink` deadlocks with a concurrent
        // `record` that holds the sink read lock and waits for this mutex
        // (#4515 rust-coverage hang).
        drop(metrics);
        set_sink(None);
    }

    #[tokio::test]
    async fn a_stalled_exporter_drops_and_counts_instead_of_blocking() {
        // A sink that never returns: the forwarder parks inside `record`, so
        // the bounded channel fills and subsequent records must be refused
        // without awaiting.
        struct Stalled;
        impl MetricSink for Stalled {
            fn record(&self, _metric: Metric) {
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
        }

        let exporter = BoundedExporter::spawn(Arc::new(Stalled), 2);
        for _ in 0..10 {
            let started = std::time::Instant::now();
            exporter.record(
                Metric::new("ws_admission_refused", Labels::new(), 1.0).expect("catalog name"),
            );
            assert!(
                started.elapsed() < std::time::Duration::from_millis(100),
                "a stalled collector delayed the caller"
            );
        }
        assert!(exporter.drops() >= 8, "drops were not counted");
    }

    /// #4501: the exporter's own loss has a real emit owner. A stalled
    /// collector accrues drops; once it makes progress the forwarder publishes
    /// `ws_exporter_dropped` directly to it, and the deltas sum to the drop
    /// counter without double counting.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exporter_drops_are_published_to_the_inner_sink() {
        use std::sync::{Condvar, Mutex as StdMutex};

        struct Gated {
            open: Arc<(StdMutex<bool>, Condvar)>,
            recorded: StdMutex<Vec<Metric>>,
            loss: Arc<Notify>,
        }

        impl MetricSink for Gated {
            fn record(&self, metric: Metric) {
                let (open, wake) = &*self.open;
                let mut ready = open.lock().expect("gate");
                while !*ready {
                    ready = wake.wait(ready).expect("gate wait");
                }
                drop(ready);
                let loss = metric.name == "ws_exporter_dropped";
                // Record before notifying: a waiter that wakes must be able to
                // read the metric it was told about.
                self.recorded.lock().expect("recorded").push(metric);
                if loss {
                    self.loss.notify_waiters();
                }
            }
        }

        let gate = Arc::new((StdMutex::new(false), Condvar::new()));
        let sink = Arc::new(Gated {
            open: Arc::clone(&gate),
            recorded: StdMutex::new(Vec::new()),
            loss: Arc::new(Notify::new()),
        });
        let exporter = BoundedExporter::spawn(Arc::clone(&sink) as Arc<dyn MetricSink>, 2);

        // The forwarder takes one metric and parks inside the stalled sink;
        // the two-slot queue fills and the rest are dropped by `record`.
        for _ in 0..10 {
            exporter.record(
                Metric::new("ws_admission_refused", Labels::new(), 1.0).expect("catalog name"),
            );
        }
        let dropped = exporter.drops();
        assert!(dropped >= 5, "the bounded queue did not drop: {dropped}");

        let notified = sink.loss.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        {
            let (open, wake) = &*gate;
            *open.lock().expect("gate") = true;
            wake.notify_all();
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), notified)
            .await
            .expect("the loss metric was never published");

        let recorded = sink.recorded.lock().expect("recorded");
        let reported: f64 = recorded
            .iter()
            .filter(|metric| metric.name == "ws_exporter_dropped")
            .map(|metric| metric.value)
            .sum();
        assert_eq!(
            reported, dropped as f64,
            "loss deltas do not sum to the drop counter"
        );
    }
}
