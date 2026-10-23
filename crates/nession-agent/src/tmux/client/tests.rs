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

fn wire() -> (TmuxClient, BufReader<DuplexStream>, DuplexStream) {
    let (client_reader, tmux_tx) = duplex(1 << 16);
    let (client_writer, tmux_rx) = duplex(1 << 16);
    let io = ClientIo {
        reader: Box::new(client_reader),
        writer: Box::new(client_writer),
        child: None,
    };
    (
        TmuxClient::from_io("work", io, 1),
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
    tokio::time::timeout(Duration::from_secs(2), client.events().recv())
        .await
        .expect("an event must arrive")
        .expect("the event stream must stay open")
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

#[tokio::test]
async fn output_is_byte_exact_and_size_changes_are_deduplicated() {
    let (mut client, _rx, mut tx) = wire();
    send(&mut tx, WELCOME).await;

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
        tokio::time::timeout(Duration::from_millis(100), client.events().recv())
            .await
            .is_err(),
        "a repeated size must not be a second event",
    );
    client.close().await;
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
        TmuxEvent::SourceLost { .. } => {}
        other => panic!("the source loss must be an event: {other:?}"),
    }
    assert!(client.is_closed());
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
