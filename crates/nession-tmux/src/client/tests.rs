//! Deterministic wire tests for [`TmuxClient`].
//!
//! These tests are the client, not a mock of it: the real reader, writer,
//! matcher and event stream run against an in-memory duplex that plays tmux.
//! Nothing here is timing-dependent beyond the explicit budgets, so a red test
//! names an ordering or framing defect rather than a slow machine.

use std::time::Duration;

use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

use super::*;

const WELCOME: &str = "%begin 1 0 0\n%end 1 0 0\n";

/// A writer that never accepts bytes, so the ordered writer task parks in
/// `write_all` exactly as a child that stopped draining stdin would.
struct StalledWriter;

impl tokio::io::AsyncWrite for StalledWriter {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        _buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::task::Poll::Pending
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Pending
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

fn wire() -> (TmuxClient, BufReader<DuplexStream>, DuplexStream) {
    wire_with_limits(EventIngressLimits::default())
}

fn wire_with_limits(
    limits: EventIngressLimits,
) -> (TmuxClient, BufReader<DuplexStream>, DuplexStream) {
    let (client_reader, tmux_tx) = duplex(1 << 16);
    let (client_writer, tmux_rx) = duplex(1 << 16);
    let io = ClientIo {
        reader: Box::new(client_reader),
        writer: Box::new(client_writer),
        child: None,
    };
    (
        TmuxClient::from_io_with_limits("work", io, 1, limits),
        BufReader::new(tmux_rx),
        tmux_tx,
    )
}

async fn send(tx: &mut DuplexStream, text: &str) {
    tx.write_all(text.as_bytes())
        .await
        .expect("fake tmux write");
}

async fn send_bytes(tx: &mut DuplexStream, bytes: &[u8]) {
    tx.write_all(bytes).await.expect("fake tmux write");
}

async fn read_command(rx: &mut BufReader<DuplexStream>) -> String {
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(2), rx.read_line(&mut line))
        .await
        .expect("the client must write its command")
        .expect("fake tmux read");
    line
}

async fn next_event(client: &mut TmuxClient) -> TmuxEvent {
    let events = client.events().expect("the test owns the event stream");
    tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .expect("an event must arrive")
        .expect("the event stream must stay open")
}

/// A client whose ordered writer never drains; the returned half keeps the
/// client's read side open so no accidental source loss resolves the waiters.
fn stalled_client() -> (TmuxClient, DuplexStream) {
    let (client_reader, tmux_tx) = duplex(1 << 16);
    let io = ClientIo {
        reader: Box::new(client_reader),
        writer: Box::new(StalledWriter),
        child: None,
    };
    (TmuxClient::from_io("work", io, 1), tmux_tx)
}

/// Fill the writer channel behind a stalled writer: one operation is held by
/// the writer task and the remaining slots queue behind it. The caller futures
/// are cancelled on return; the queued operations remain in the channel.
async fn stall_with_pending_commands(client: &TmuxClient, count: usize) {
    let fillers = futures_util::future::join_all((0..count).map(|_| {
        client.command_with_timeout(ControlCommand::RefreshClient, Duration::from_secs(60))
    }));
    tokio::pin!(fillers);
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        _ = &mut fillers => panic!("commands behind a stalled writer must stay pending"),
    }
}

/// #2379 SC-01: a full writer behind a non-draining child returns the caller
/// at its configured deadline instead of suspending at channel admission.
#[tokio::test]
async fn a_command_admission_deadline_bounds_a_stalled_writer() {
    let (client, _tmux_tx) = stalled_client();
    stall_with_pending_commands(&client, WRITE_CHANNEL_CAPACITY + 1).await;

    let started = std::time::Instant::now();
    let outcome = client
        .command_with_timeout(ControlCommand::RefreshClient, Duration::from_millis(250))
        .await;
    let elapsed = started.elapsed();

    assert!(
        matches!(outcome, Err(TmuxClientError::AdmissionTimeout(_))),
        "a full writer must report admission timeout, not hang: {outcome:?}"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "admission outlived its configured deadline: {elapsed:?}"
    );
}

/// #2379 SC-02: a lost source resolves every pending waiter with a scoped
/// error — written commands report the loss, queued ones report the close —
/// instead of leaving any caller suspended behind a dead attachment.
#[tokio::test]
async fn source_loss_completes_every_pending_waiter() {
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;

    let mut pending = Box::pin(futures_util::future::join_all((0..4).map(|_| {
        client.command_with_timeout(ControlCommand::RefreshClient, Duration::from_secs(60))
    })));
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        _ = &mut pending => panic!("the replies are outstanding"),
    }
    // Consume the four command lines, then lose the source.
    for _ in 0..4 {
        assert_eq!(read_command(&mut rx).await, "refresh-client\n");
    }
    drop(tx);

    let results = pending.await;
    assert_eq!(results.len(), 4);
    for result in results {
        assert!(
            matches!(
                result,
                Err(TmuxClientError::SourceLost(_)) | Err(TmuxClientError::Closed)
            ),
            "a pending waiter must learn the attachment ended: {result:?}"
        );
    }
    assert!(client.is_closed());
    client.close().await;
}

/// #2379 SC-02: `close` is bounded even when the write channel is full and the
/// writer is parked, and the client ends closed.
#[tokio::test]
async fn close_is_bounded_with_a_stalled_writer() {
    let (mut client, _tmux_tx) = stalled_client();
    stall_with_pending_commands(&client, WRITE_CHANNEL_CAPACITY + 1).await;

    let started = std::time::Instant::now();
    client.close().await;
    let elapsed = started.elapsed();

    assert!(client.is_closed(), "close must retire the attachment");
    assert!(
        elapsed < Duration::from_secs(6),
        "close outlived its bounded phases: {elapsed:?}"
    );
}

/// #2379 SC-03: cancelling a caller after its command was written does not let
/// that command's reply be delivered to the next caller.
#[tokio::test]
async fn a_cancelled_command_does_not_steal_the_next_reply() {
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);

    let mut first = Box::pin(client.command(ControlCommand::RefreshClient));
    tokio::select! {
        result = &mut first => panic!("the first command cannot complete yet: {result:?}"),
        line = read_command(&mut rx) => assert_eq!(line, "refresh-client\n"),
    }
    // The caller is gone; its command is still in the reply order.
    drop(first);
    send(&mut tx, "%begin 2 1 0\nfirst\n%end 2 1 0\n").await;

    let (second, ()) = tokio::join!(client.command(ControlCommand::RefreshClient), async {
        let line = read_command(&mut rx).await;
        assert_eq!(line, "refresh-client\n");
        send(&mut tx, "%begin 3 2 0\nsecond\n%end 3 2 0\n").await;
    });

    assert_eq!(
        second.expect("the next caller gets its own block"),
        b"second"
    );
    client.close().await;
}

#[tokio::test]
async fn a_command_is_matched_to_its_response_block() {
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;

    let (result, command) = tokio::join!(client.command(ControlCommand::RefreshClient), async {
        let command = read_command(&mut rx).await;
        send(&mut tx, "%begin 2 1 0\n%end 2 1 0\n").await;
        command
    },);

    assert_eq!(command, "refresh-client\n");
    assert_eq!(result.expect("tmux accepted the command"), b"");
    client.close().await;
}

#[tokio::test]
async fn the_welcome_block_answers_no_command_even_when_one_is_already_queued() {
    // A caller may issue its first command before it has read the welcome
    // pair. Consuming that pair as the command's reply would hand it an empty
    // body and leave its real reply to the next waiter.
    let (mut client, mut rx, mut tx) = wire();

    let (result, command) = tokio::join!(client.command(ControlCommand::RefreshClient), async {
        let command = read_command(&mut rx).await;
        send(&mut tx, WELCOME).await;
        send(&mut tx, "%begin 2 1 0\nreal\n%end 2 1 0\n").await;
        command
    },);

    assert_eq!(command, "refresh-client\n");
    assert_eq!(result.expect("the real reply is the command's"), b"real");
    client.close().await;
}

#[tokio::test]
async fn concurrent_commands_are_resolved_in_wire_order_with_interleaved_output() {
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;

    let fake = async {
        let first = read_command(&mut rx).await;
        let second = read_command(&mut rx).await;
        assert_eq!(first, "send-keys -t work -H 6f 6e 65\n");
        assert_eq!(second, "refresh-client\n");
        // tmux answers in command order; pane output may interleave.
        send(&mut tx, "%begin 2 1 0\nfirst\n%end 2 1 0\n").await;
        send(&mut tx, "%output %0 hi\\015\n").await;
        send(&mut tx, "%begin 3 2 0\nsecond\n%end 3 2 0\n").await;
    };

    let (first, second, ()) = tokio::join!(
        client.command(ControlCommand::SendKeysHex {
            target: "work".to_string(),
            data: b"one".to_vec(),
        }),
        client.command(ControlCommand::RefreshClient),
        fake,
    );

    assert_eq!(first.expect("first reply"), b"first");
    assert_eq!(second.expect("second reply"), b"second");
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);
    assert_eq!(
        next_event(&mut client).await,
        TmuxEvent::Output(PaneOutput {
            pane_id: "%0".to_string(),
            data: b"hi\r".to_vec(),
        }),
    );
    client.close().await;
}

#[tokio::test]
async fn a_timeout_leaves_a_tombstone_so_the_next_command_gets_its_own_reply() {
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;

    let (timed_out, first) = tokio::join!(
        client.command_with_timeout(ControlCommand::RefreshClient, Duration::from_millis(100)),
        read_command(&mut rx),
    );
    assert_eq!(first, "refresh-client\n");
    assert!(
        matches!(timed_out, Err(TmuxClientError::Timeout(_))),
        "the command with no reply must time out: {timed_out:?}",
    );

    let second = client.command_with_timeout(ControlCommand::RefreshClient, Duration::from_secs(2));
    let fake = async {
        let command = read_command(&mut rx).await;
        assert_eq!(command, "refresh-client\n");
        // The late reply to the abandoned command still occupies its place.
        send(&mut tx, "%begin 2 1 0\nstale\n%end 2 1 0\n").await;
        send(&mut tx, "%begin 3 2 0\nfresh\n%end 3 2 0\n").await;
    };
    let (reply, ()) = tokio::join!(second, fake);
    assert_eq!(reply.expect("second reply"), b"fresh");
    client.close().await;
}

#[tokio::test]
async fn an_error_block_reports_tmuxs_own_message() {
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;

    let (result, _) = tokio::join!(
        client.command(ControlCommand::ResizeWindow {
            target: "work".to_string(),
            cols: 10,
            rows: 5,
        }),
        async {
            let command = read_command(&mut rx).await;
            assert_eq!(command, "resize-window -t work -x 10 -y 5\n");
            send(&mut tx, "%begin 2 1 0\nno such window\n%error 2 1 0\n").await;
        },
    );

    assert_eq!(
        result,
        Err(TmuxClientError::Rejected("no such window".to_string())),
    );
    client.close().await;
}

/// #2378 SC-02 (reopened): a notification-shaped line inside an open response
/// block is capture body, not a live source event.
///
/// tmux 3.6b does not escape command output, and it does not interleave
/// notifications inside a response block (measured on both `-C` and `-CC`: a
/// resize driven from another client while `wait-for` held a block open
/// arrived after `%end`). A captured pane line can therefore be exactly
/// `%exit`, `%output …`, `%layout-change …`, `%window-resize …` or `%begin …`.
///
/// The previous behaviour routed those parsed records as notifications. That
/// fabricated output or geometry for `%output`/`%layout-change` and, for a
/// pane line reading `%exit`, closed the whole attachment: the capture command
/// never returned and its bytes were lost. This test is the red-before witness
/// for that collision and now pins the measured contract.
#[tokio::test]
async fn notification_shaped_body_lines_are_content_not_source_events() {
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);

    let body = "%exit\n%output %0 hello\n\
                %layout-change @0 a87d,177x49,0,0,0 a87d,177x49,0,0,0 *\n\
                %window-resize @0 100 30\n%begin 2 9 0\n\n%unknown foo";
    let (result, command) = tokio::join!(client.capture_pane(10), async {
        let command = read_command(&mut rx).await;
        send(&mut tx, &format!("%begin 2 1 0\n{body}\n%end 2 1 0\n")).await;
        command
    });

    assert_eq!(command, "capture-pane -t work -p -S -10 -E - -e -J\n");
    assert_eq!(
        result.expect("a notification-shaped body must not close the attachment"),
        body.as_bytes(),
        "every in-block line, including a well-formed notification, is capture bytes"
    );
    // The barrier pair carries the same bytes; nothing else may be invented.
    assert_eq!(next_event(&mut client).await, TmuxEvent::CaptureStarted);
    assert_eq!(
        next_event(&mut client).await,
        TmuxEvent::Capture {
            body: body.as_bytes().to_vec(),
        }
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            client.events().expect("the stream").recv(),
        )
        .await
        .is_err(),
        "no fabricated resize, output or exit may escape from capture bytes"
    );
    assert!(!client.is_closed());

    // The attachment is still usable for the next command.
    let (result, command) = tokio::join!(client.command(ControlCommand::RefreshClient), async {
        let command = read_command(&mut rx).await;
        send(&mut tx, "%begin 3 2 0\n%end 3 2 0\n").await;
        command
    });
    assert_eq!(command, "refresh-client\n");
    assert_eq!(result.expect("the next reply is matched"), b"");
    client.close().await;
}

/// #2378: every response line is a line, including empty ones.
///
/// `OpenBlock::push` used `body.is_empty()` as the "a line was seen" predicate,
/// so a leading (or consecutive) empty line appended zero bytes and every later
/// line lost the separator that distances it from the start.
#[tokio::test]
async fn a_response_body_preserves_leading_and_embedded_empty_lines() {
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);

    let (result, command) = tokio::join!(client.capture_pane(10), async {
        let command = read_command(&mut rx).await;
        send(&mut tx, "%begin 2 1 0\n\n\nLINE\n\nA\n\n%end 2 1 0\n").await;
        command
    });

    assert_eq!(command, "capture-pane -t work -p -S -10 -E - -e -J\n");
    assert_eq!(
        result.expect("the reply still belongs to its own block"),
        b"\n\nLINE\n\nA\n",
        "empty lines before, between and after content are response bytes"
    );
}

/// #2378 SC-02: tmux does not escape command output, so a captured pane line
/// may begin with `%`, may look like a malformed control record, or may even
/// name a different response triple. None of those is a notification or a
/// protocol fault while a block is open; they are body bytes.
#[tokio::test]
async fn percent_prefixed_body_lines_are_content_not_notifications() {
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);

    let (result, command) = tokio::join!(client.capture_pane(10), async {
        let command = read_command(&mut rx).await;
        send(
            &mut tx,
            "%begin 2 1 0\n%hello\n%begin fake\n%end fake\n%%percent\n%end 9 9 9\n%end 2 1 0\n",
        )
        .await;
        command
    });

    assert_eq!(command, "capture-pane -t work -p -S -10 -E - -e -J\n");
    assert_eq!(
        result.expect("a %-prefixed body must not be a protocol fault"),
        b"%hello\n%begin fake\n%end fake\n%%percent\n%end 9 9 9"
    );

    // The block ended only at its own terminator; the attachment is usable.
    let (result, command) = tokio::join!(client.command(ControlCommand::RefreshClient), async {
        let command = read_command(&mut rx).await;
        send(&mut tx, "%begin 3 2 0\nok\n%end 3 2 0\n").await;
        command
    });
    assert_eq!(command, "refresh-client\n");
    assert_eq!(result.expect("the next reply is matched"), b"ok");
    client.close().await;
}

#[tokio::test]
async fn output_is_byte_exact_and_size_changes_are_deduplicated() {
    let (mut client, _rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);

    // A non-UTF-8 byte and an octal-escaped control byte, in one %output.
    send_bytes(&mut tx, b"%output %0 \xff\xfe\\015\n").await;
    send(&mut tx, "%layout-change @0 a87d,100x30,0,0,0\n").await;
    // tmux 3.6b emits two layout lines for one resize; only one is news.
    send(&mut tx, "%layout-change @0 a87d,100x30,0,0,0\n").await;

    assert_eq!(
        next_event(&mut client).await,
        TmuxEvent::Output(PaneOutput {
            pane_id: "%0".to_string(),
            data: vec![0xff, 0xfe, b'\r'],
        }),
    );
    assert_eq!(
        next_event(&mut client).await,
        TmuxEvent::Resize {
            cols: 100,
            rows: 30
        },
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            client.events().expect("the test owns the stream").recv(),
        )
        .await
        .is_err(),
        "a repeated size must not be a second event",
    );
    client.close().await;
}

/// #2380 SC-01: the ordered ingress is bounded by aggregate payload bytes, and
/// taking an event releases exactly its credit.
#[tokio::test]
async fn event_ingress_is_bounded_by_aggregate_bytes_and_releases_on_take() {
    let limits = EventIngressLimits {
        max_queued_bytes: 4 * 1024,
        admission_timeout: Duration::from_secs(60),
    };
    let (mut client, _rx, mut tx) = wire_with_limits(limits);
    send(&mut tx, WELCOME).await;
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);

    // Each output costs 64 overhead + 2 pane-id bytes + 1001 decoded bytes =
    // 1067; three fit in 4096, a fourth does not.
    let payload = "x".repeat(1000);
    for _ in 0..10 {
        send(&mut tx, &format!("%output %0 {payload}\015\n")).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    let queued = client.events().expect("the stream").rx.len();
    assert_eq!(
        queued, 3,
        "the aggregate byte budget, not the item count, bounds the queue"
    );

    // Taking one releases its credit, so the reader admits the next in order.
    let first = client
        .events()
        .expect("the stream")
        .recv()
        .await
        .expect("an admitted event");
    assert!(matches!(first, TmuxEvent::Output(_)));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        client.events().expect("the stream").rx.len(),
        3,
        "the released credit admitted exactly one more event"
    );
}

/// #2380 SC-02: an event larger than the whole budget cannot be admitted; the
/// attachment fails closed and states the loss instead of buffering it.
#[tokio::test]
async fn an_event_larger_than_the_budget_fails_closed() {
    let limits = EventIngressLimits {
        max_queued_bytes: 1024,
        admission_timeout: Duration::from_secs(60),
    };
    let (mut client, mut rx, mut tx) = wire_with_limits(limits);
    send(&mut tx, WELCOME).await;
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);

    let oversized = "y".repeat(4096);
    let (result, line) = tokio::join!(client.command(ControlCommand::RefreshClient), async {
        let line = read_command(&mut rx).await;
        send(&mut tx, &format!("%output %0 {oversized}\015\n")).await;
        line
    });
    assert_eq!(line, "refresh-client\n");
    match result {
        Err(TmuxClientError::SourceLost(reason)) => {
            assert!(
                reason.contains("budget"),
                "the loss names the budget: {reason}"
            );
        }
        other => panic!("an oversized event must fail closed: {other:?}"),
    }
    assert!(client.is_closed());
    assert!(matches!(
        next_event(&mut client).await,
        TmuxEvent::SourceLost { .. }
    ));
}

/// #2380 SC-02/SC-03: a consumer that stops taking events makes the reader
/// fail closed at its admission deadline; the events already admitted stay in
/// order and the stated loss is the terminal event (control events are not
/// starved past the bound).
#[tokio::test]
async fn a_stalled_consumer_fails_closed_at_the_admission_deadline() {
    let limits = EventIngressLimits {
        max_queued_bytes: 4 * 1024,
        admission_timeout: Duration::from_millis(150),
    };
    let (mut client, mut rx, mut tx) = wire_with_limits(limits);
    send(&mut tx, WELCOME).await;
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);

    let payload = "z".repeat(1000);
    let (result, line) = tokio::join!(client.command(ControlCommand::RefreshClient), async {
        let line = read_command(&mut rx).await;
        for _ in 0..10 {
            send(&mut tx, &format!("%output %0 {payload}\015\n")).await;
        }
        line
    });
    assert_eq!(line, "refresh-client\n");
    match result {
        Err(TmuxClientError::SourceLost(reason)) => {
            assert!(
                reason.contains("consumer stalled"),
                "the loss names the stalled consumer: {reason}"
            );
        }
        other => panic!("a stalled consumer must fail closed: {other:?}"),
    }

    let mut last = None;
    while let Ok(Some(event)) = tokio::time::timeout(
        Duration::from_millis(500),
        client.events().expect("the stream").recv(),
    )
    .await
    {
        last = Some(event);
    }
    assert!(
        matches!(last, Some(TmuxEvent::SourceLost { .. })),
        "the terminal event must state the loss: {last:?}"
    );
}

/// #2380 SC-02 (reopened): byte credit alone does not bound a stalled
/// consumer.
///
/// With a large byte budget and tiny events, the 256-slot event channel fills
/// while most of the credit is still free. Bounding only the credit
/// acquisition left `tx.send` able to park a live-but-stalled consumer
/// forever: no terminal `SourceLost` was produced within any deadline. The
/// send now shares the admission deadline, and the loss is stated either as
/// the terminal event in order or as the failure record `recv` surfaces when
/// the queue was too full to carry it.
#[tokio::test]
async fn a_full_event_queue_fails_closed_at_the_admission_deadline() {
    let limits = EventIngressLimits {
        max_queued_bytes: 1024 * 1024,
        admission_timeout: Duration::from_millis(150),
    };
    let (mut client, mut rx, mut tx) = wire_with_limits(limits);
    send(&mut tx, WELCOME).await;
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);

    let started = std::time::Instant::now();
    let (result, line) = tokio::join!(client.command(ControlCommand::RefreshClient), async {
        let line = read_command(&mut rx).await;
        // 67 charged bytes each (64 overhead + 2 pane-id + 1 payload): far
        // inside the byte budget, but past the count-bounded channel.
        for _ in 0..(EVENT_CHANNEL_CAPACITY + 8) {
            send(&mut tx, "%output %0 x\r\n").await;
        }
        line
    });
    let elapsed = started.elapsed();

    assert_eq!(line, "refresh-client\n");
    match result {
        Err(TmuxClientError::SourceLost(reason)) => assert!(
            reason.contains("consumer stalled"),
            "the loss names the stalled consumer: {reason}"
        ),
        other => panic!("a full event queue must fail closed: {other:?}"),
    }
    assert!(
        elapsed < Duration::from_secs(3),
        "the waiter must learn the loss within the admission deadline: {elapsed:?}"
    );
    assert!(client.is_closed());

    // The admitted events stay ordered. The terminal loss is observable even
    // though the full queue could not carry the terminal event at admission
    // time, and every admitted charge is released exactly once.
    let mut events = client.take_events().expect("the test owns the stream");
    let mut count = 0usize;
    let mut last = None;
    while let Ok(Some(event)) =
        tokio::time::timeout(Duration::from_millis(500), events.recv()).await
    {
        count += 1;
        last = Some(event);
    }
    assert_eq!(
        count,
        EVENT_CHANNEL_CAPACITY + 1,
        "the count bound admits exactly its slots plus the terminal loss"
    );
    assert!(
        matches!(last, Some(TmuxEvent::SourceLost { .. })),
        "the terminal event states the loss: {last:?}"
    );
    assert_eq!(
        events.budget.queued.load(Ordering::Acquire),
        0,
        "every admitted charge is released on take; the failed send refunded its own"
    );
}

/// #2380 SC-02 (reopened): the admission permit owns one event's byte charge.
/// Dropping it — a failed, timed-out or cancelled send — refunds that charge
/// instead of leaking budget.
#[tokio::test]
async fn a_dropped_admission_permit_refunds_its_credit() {
    let budget = EventBudget::new(1024);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    let permit = match budget.acquire_until(100, deadline).await {
        Admission::Granted(permit) => permit,
        Admission::Overloaded | Admission::Closed => panic!("the credit is available"),
    };
    assert_eq!(budget.queued.load(Ordering::Acquire), 100);
    drop(permit);
    assert_eq!(
        budget.queued.load(Ordering::Acquire),
        0,
        "an unarmed permit refunds its charge"
    );

    // Disarming transfers the charge to the queued event instead.
    let permit = match budget.acquire_until(100, deadline).await {
        Admission::Granted(permit) => permit,
        Admission::Overloaded | Admission::Closed => panic!("the credit is available"),
    };
    permit.disarm();
    assert_eq!(
        budget.queued.load(Ordering::Acquire),
        100,
        "a disarmed permit leaves the charge to the consumer's release"
    );
}

/// #2380 SC-02 (reopened): a source that failed states its loss exactly once,
/// even when the queue was too full to carry the terminal event. Admitted
/// events come first, in order; the recorded loss is terminal; the stream
/// then ends.
#[tokio::test]
async fn a_recorded_source_loss_is_stated_after_the_admitted_events() {
    let budget = Arc::new(EventBudget::new(1024));
    let (tx, rx) = mpsc::channel(1);
    let mut stream = EventStream {
        rx,
        budget: Arc::clone(&budget),
    };
    tx.send(BudgetedEvent {
        event: TmuxEvent::Output(PaneOutput {
            pane_id: "%0".to_string(),
            data: b"kept".to_vec(),
        }),
        bytes: 0,
    })
    .await
    .expect("the admitted event");
    drop(tx);
    budget.record_failure("event ingress budget exhausted; consumer stalled");

    assert!(matches!(
        stream.recv().await,
        Some(TmuxEvent::Output(output)) if output.data == b"kept"
    ));
    assert!(matches!(
        stream.recv().await,
        Some(TmuxEvent::SourceLost { ref reason }) if reason.contains("consumer stalled")
    ));
    assert!(stream.recv().await.is_none(), "the loss is stated once");
}

#[tokio::test]
async fn source_loss_fails_every_pending_command_and_is_stated() {
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;

    // Drop the fake's write half while the command is in flight; awaiting the
    // command first would only time out, which is a different failure.
    let (result, command) = tokio::join!(client.command(ControlCommand::RefreshClient), async {
        let command = read_command(&mut rx).await;
        drop(tx);
        command
    },);
    assert_eq!(command, "refresh-client\n");

    match result {
        Err(TmuxClientError::SourceLost(reason)) => {
            assert!(reason.contains("ended"), "reason names the loss: {reason}");
        }
        other => panic!("a lost source must fail the waiter: {other:?}"),
    }
    match next_event(&mut client).await {
        TmuxEvent::Handshaken => {}
        other => panic!("the welcome must precede the loss: {other:?}"),
    }
    match next_event(&mut client).await {
        TmuxEvent::SourceLost { .. } => {}
        other => panic!("the source loss must be an event: {other:?}"),
    }
    assert!(client.is_closed());
    client.close().await;
}

#[tokio::test]
async fn a_capture_is_published_in_stream_order_between_output() {
    // The bootstrap barrier is an ordering fact, not a race: output before the
    // capture's block, the capture body, and output after it arrive on one
    // stream, so the consumer can drop exactly the pre-capture prefix.
    let (mut client, mut rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;
    assert_eq!(next_event(&mut client).await, TmuxEvent::Handshaken);

    let queued = client.send_command_queued(
        ControlCommand::CapturePane {
            target: "work".to_string(),
            lines: 10,
        },
        true,
    );
    let fake = async {
        let command = read_command(&mut rx).await;
        assert_eq!(command, "capture-pane -t work -p -S -10 -E - -e -J\n");
        send(&mut tx, "%output %0 before\\015\n").await;
        // tmux does not interleave live output inside a response block
        // (measured on both transports), so an output-shaped line there is
        // capture body — not a live event and not a second copy (#2378).
        send(
            &mut tx,
            "%begin 2 1 0\nline one\n%output %0 inside\\015\nline two\n%end 2 1 0\n",
        )
        .await;
        send(&mut tx, "%output %0 after\\015\n").await;
    };
    let (accepted, ()) = tokio::join!(queued, fake);
    accepted.expect("the capture command was written");

    assert_eq!(
        next_event(&mut client).await,
        TmuxEvent::Output(PaneOutput {
            pane_id: "%0".to_string(),
            data: b"before\r".to_vec(),
        }),
    );
    // The barrier boundary: everything before this event is inside the pane
    // read, everything after it is live.
    assert_eq!(next_event(&mut client).await, TmuxEvent::CaptureStarted);
    assert_eq!(
        next_event(&mut client).await,
        TmuxEvent::Capture {
            body: b"line one\n%output %0 inside\\015\nline two".to_vec(),
        },
    );
    assert_eq!(
        next_event(&mut client).await,
        TmuxEvent::Output(PaneOutput {
            pane_id: "%0".to_string(),
            data: b"after\r".to_vec(),
        }),
    );
    client.close().await;
}

#[tokio::test]
async fn the_pending_queue_is_bounded_and_the_bound_fails_closed() {
    let (mut client, mut rx, _tx) = wire();
    // No welcome is needed: commands are written and never answered.
    let mut queue_full = false;
    for _ in 0..=MAX_PENDING_COMMANDS {
        let result = client
            .command_with_timeout(ControlCommand::RefreshClient, Duration::from_millis(1))
            .await;
        match result {
            Err(TmuxClientError::Timeout(_)) => {}
            Err(TmuxClientError::QueueFull) => {
                queue_full = true;
                break;
            }
            other => panic!("unexpected command result: {other:?}"),
        }
        // Drain the written line so the duplex's buffer does not back up.
        let mut line = String::new();
        let _ = tokio::time::timeout(Duration::from_millis(10), rx.read_line(&mut line)).await;
    }
    assert!(queue_full, "the queue must refuse work past its bound");
    client.close().await;
}
