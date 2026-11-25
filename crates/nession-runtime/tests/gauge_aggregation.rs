//! Process-wide task gauge aggregation (#4437).
//!
//! A single test in its own binary: the sink is a process fact, so this must
//! not share a process with the unit tests that also move the task gauges.

use std::sync::{Arc, Mutex};

use nession_runtime::lane::QueryLane;
use nession_runtime::metrics::{self, Metric, MetricSink};

#[derive(Default)]
struct Capture(Mutex<Vec<(&'static str, f64)>>);

impl Capture {
    fn last(&self, name: &str) -> Option<f64> {
        let metrics = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        metrics
            .iter()
            .rev()
            .find(|(recorded, _)| *recorded == name)
            .map(|(_, value)| *value)
    }
}

impl MetricSink for Capture {
    fn record(&self, metric: Metric) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((metric.name, metric.value));
    }
}

/// Two independent lanes are one process aggregate: the emitted gauge is 2,
/// and after both lanes settle the emitted gauge returns to 0. A per-lane
/// gauge would be last-writer-wins and never settle.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn emitted_task_gauges_aggregate_across_lanes_and_settle() {
    let capture = Arc::new(Capture::default());
    let sink: Arc<dyn MetricSink> = capture.clone();
    metrics::set_sink(Some(sink));

    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let mut first = QueryLane::new(2, "gauge-first");
    let mut second = QueryLane::new(2, "gauge-second");
    {
        let gate = Arc::clone(&gate);
        first
            .dispatch(async move {
                let _permit = gate.acquire().await;
            })
            .await;
    }
    {
        let gate = Arc::clone(&gate);
        second
            .dispatch(async move {
                let _permit = gate.acquire().await;
            })
            .await;
    }

    assert_eq!(
        capture.last("ws_task_active"),
        Some(2.0),
        "two lanes did not aggregate into one active gauge"
    );
    assert_eq!(
        capture.last("ws_task_retained"),
        Some(2.0),
        "two lanes did not aggregate into one retained gauge"
    );

    gate.add_permits(2);
    first.drain().await;
    second.drain().await;

    assert_eq!(
        capture.last("ws_task_active"),
        Some(0.0),
        "the emitted active gauge did not settle to zero"
    );
    assert_eq!(
        capture.last("ws_task_retained"),
        Some(0.0),
        "the emitted retained gauge did not settle to zero"
    );

    metrics::set_sink(None);
}
