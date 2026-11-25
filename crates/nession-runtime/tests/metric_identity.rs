//! Runtime/peer/transport attribution (#4437 SC-02).
//!
//! A single test in its own binary: the sink is a process fact.

use std::sync::{Arc, Mutex};

use nession_runtime::lane::QueryLane;
use nession_runtime::metrics::{
    self, Direction, Domain, Labels, Metric, MetricSink, MetricsIdentity, PeerKind, RuntimeKind,
    TransportKind,
};
use nession_runtime::outbound::{ClassLimits, ClassifiedLimits, FrameClass, Outbound, WaitPolicy};

#[derive(Default)]
struct Capture(Mutex<Vec<Metric>>);

impl MetricSink for Capture {
    fn record(&self, metric: Metric) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(metric);
    }
}

/// A lane that was told which connection it serves emits that identity on its
/// admission metrics. Without it every connection's sample is indistinguishable
/// from another's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lane_metrics_carry_the_connection_identity() {
    let capture = Arc::new(Capture::default());
    let sink: Arc<dyn MetricSink> = capture.clone();
    metrics::set_sink(Some(sink));

    let identity = MetricsIdentity::new(
        RuntimeKind::AgentCentral,
        PeerKind::Agent,
        TransportKind::Tls,
    );
    let mut lane = QueryLane::new(4, "identity-test").with_metrics_identity(identity);
    lane.dispatch(async {}).await;
    lane.drain().await;

    {
        let metrics = capture
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let accepted = metrics
            .iter()
            .find(|metric| {
                metric.name == "ws_admission_accepted"
                    && metric.labels.domain == Some(Domain::Request)
                    && metric.labels.direction == Some(Direction::Inbound)
            })
            .expect("the lane emitted no accepted admission");
        assert_eq!(accepted.labels.runtime, Some(RuntimeKind::AgentCentral));
        assert_eq!(accepted.labels.peer, Some(PeerKind::Agent));
        assert_eq!(accepted.labels.transport, Some(TransportKind::Tls));

        // The label vocabulary is unchanged: the identity is the bounded enum set.
        assert_eq!(
            accepted.labels,
            Labels::new()
                .identity(identity)
                .domain(Domain::Request)
                .direction(Direction::Inbound)
                .result(nession_runtime::metrics::ResultKind::Accepted)
        );
    }
    // The outbound path carries the same identity on its submissions.
    let limits = ClassifiedLimits {
        control: ClassLimits {
            bytes: 64 * 1024,
            frames: 8,
        },
        response: ClassLimits {
            bytes: 64 * 1024,
            frames: 8,
        },
        stream: ClassLimits {
            bytes: 64 * 1024,
            frames: 8,
        },
    };
    let (outbound, _rx) = Outbound::new(
        "identity-outbound",
        limits,
        std::time::Duration::from_secs(1),
    );
    outbound.set_identity(identity);
    let outcome = outbound
        .submit_current(
            FrameClass::Response,
            nession_runtime::frame::WsFrame::Text("x".into()),
            WaitPolicy::NoWait,
        )
        .await;
    assert_eq!(
        outcome.into_result(),
        Ok(()),
        "the identity-outbound submission was refused"
    );
    let metrics = capture
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let outbound_accepted = metrics
        .iter()
        .find(|metric| metric.name == "ws_outbound_accepted")
        .expect("the outbound path emitted no accepted submission");
    assert_eq!(
        outbound_accepted.labels.runtime,
        Some(RuntimeKind::AgentCentral)
    );
    assert_eq!(outbound_accepted.labels.peer, Some(PeerKind::Agent));
    assert_eq!(outbound_accepted.labels.transport, Some(TransportKind::Tls));

    metrics::set_sink(None);
}
