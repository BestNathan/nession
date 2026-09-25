//! The client against a mock socket: correlation, skipping, and bounds.
//!
//! The mock **echoes the wire name and `id` of the request it is answering**
//! rather than spelling either itself. That is deliberate, and it is the one
//! thing this file does differently from the mock it replaces: the old one
//! replied from a second copy of the same wire literals the client sent, so
//! every name assertion compared a string with itself and a rename could not
//! fail. Echoing makes the mock unable to disagree about a name — which is
//! right, because under #953 a reply carries its request's own name and is
//! correlated by `id`. Proving a wire name is correct is
//! `scripts/protocol-gate.mjs`'s job, not a fixture's.
//!
//! The mock runs *beside* the client under `tokio::join!` rather than in a
//! spawned task, so its failures reach the test: a spawned mock can only fail
//! by going quiet, and going quiet is indistinguishable from the timeout the
//! test is asserting on.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nession_client::{ClientConfig, ClientConnection, ClientError};
use nession_protocol::contracts::agent::v1::AgentListReply;
use nession_protocol::Message;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{accept_async, WebSocketStream};

/// What a helper can fail with. `Box<dyn Error>` rather than `anyhow`: this
/// crate names no error-aggregating library even in dev-dependencies, so the
/// claim in its manifest stays true of everything under `crates/nession-client`.
type TestResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

type ServerSocket = WebSocketStream<tokio::net::TcpStream>;

/// Bind a mock server on an OS-assigned port.
///
/// `127.0.0.1:0` rather than a fixed port: two runs of this suite must not
/// contend for one.
async fn bind() -> TestResult<(TcpListener, String)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("ws://{}", listener.local_addr()?);
    Ok((listener, url))
}

async fn accept(listener: &TcpListener) -> TestResult<ServerSocket> {
    let (stream, _) = listener.accept().await?;
    Ok(accept_async(stream).await?)
}

/// The next text frame, decoded.
///
/// Keepalives are answered rather than skipped past, because a mock that let a
/// `Ping` pass unanswered would exercise the client's keepalive handling with a
/// socket the peer is about to abandon.
async fn next_request(ws: &mut ServerSocket) -> TestResult<Value> {
    loop {
        match ws.next().await {
            Some(Ok(WsMessage::Text(text))) => return Ok(serde_json::from_str(&text)?),
            Some(Ok(WsMessage::Ping(payload))) => ws.send(WsMessage::Pong(payload)).await?,
            Some(Ok(_)) => continue,
            other => return Err(format!("expected a text frame, got {other:?}").into()),
        }
    }
}

/// Answer `request` with `payload`, under the request's own wire name and id.
async fn answer(ws: &mut ServerSocket, request: &Value, payload: Value) -> TestResult<()> {
    let reply = Message::new(
        request["msg_type"].as_str().unwrap_or_default(),
        request["id"].as_str().unwrap_or_default(),
        0,
        payload,
    );
    ws.send(WsMessage::Text(serde_json::to_string(&reply)?))
        .await?;
    Ok(())
}

/// Push an envelope that is not a reply to anything outstanding.
async fn push(ws: &mut ServerSocket, wire: &str, id: &str, payload: Value) -> TestResult<()> {
    let frame = Message::new(wire, id, 0, payload);
    ws.send(WsMessage::Text(serde_json::to_string(&frame)?))
        .await?;
    Ok(())
}

/// Complete the handshake so [`ClientConnection::connect`] returns.
async fn handshake(ws: &mut ServerSocket) -> TestResult<Value> {
    let auth = next_request(ws).await?;
    answer(ws, &auth, json!({ "status": "success", "message": "ok" })).await?;
    Ok(auth)
}

/// Hand the socket back only once the client has had a chance to read what was
/// just written: dropping it sends a close, and the point of most tests here is
/// what arrived *before* that.
async fn linger() {
    tokio::time::sleep(Duration::from_millis(50)).await;
}

// ── Correlation ─────────────────────────────────────────────────────────────

/// A push arriving before the reply must be **skipped**, not fail the call.
///
/// The consumer this replaces read exactly one frame and compared its `id`, so
/// a `server.agents.changed` push landing first turned a working call into
/// "Unexpected reply: id … is not the … request id". A Server may push at any
/// time and does.
#[tokio::test]
async fn a_push_arriving_first_does_not_fail_the_call() {
    let (listener, url) = bind().await.unwrap();

    let server = async {
        let mut ws = accept(&listener).await?;
        handshake(&mut ws).await?;
        push(
            &mut ws,
            "server.agents.changed",
            "not-our-id",
            json!({ "agents": [] }),
        )
        .await?;
        let list = next_request(&mut ws).await?;
        answer(&mut ws, &list, json!({ "agents": [] })).await?;
        linger().await;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    };

    let (server, ()) = tokio::join!(server, async {
        let mut client = ClientConnection::connect(ClientConfig::new(&url, "t"))
            .await
            .unwrap();
        let reply = client.list_agents().await.expect("the reply must arrive");
        assert!(matches!(reply, AgentListReply::Listed(_)));
    });

    server.unwrap();
}

/// Keepalives are transport chatter, not answers.
#[tokio::test]
async fn a_keepalive_does_not_fail_the_call() {
    let (listener, url) = bind().await.unwrap();

    let server = async {
        let mut ws = accept(&listener).await?;
        handshake(&mut ws).await?;
        ws.send(WsMessage::Ping(vec![1, 2, 3])).await?;
        let list = next_request(&mut ws).await?;
        answer(&mut ws, &list, json!({ "agents": [] })).await?;
        linger().await;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    };

    let (server, ()) = tokio::join!(server, async {
        let mut client = ClientConnection::connect(ClientConfig::new(&url, "t"))
            .await
            .unwrap();
        client.list_agents().await.unwrap();
    });

    server.unwrap();
}

/// Two requests on one connection carry **different** ids.
///
/// The consumer this replaces built ids as `{prefix}_{millis}`, so two calls
/// inside one millisecond produced the same id and the second reply was
/// correlated against the first request. Issued back to back here, which is the
/// timing the old scheme lost to.
#[tokio::test]
async fn two_requests_in_a_row_carry_different_ids() {
    let (listener, url) = bind().await.unwrap();

    let server = async {
        let mut ws = accept(&listener).await?;
        handshake(&mut ws).await?;
        let mut ids = Vec::new();
        for _ in 0..2 {
            let list = next_request(&mut ws).await?;
            ids.push(list["id"].as_str().unwrap_or_default().to_string());
            answer(&mut ws, &list, json!({ "agents": [] })).await?;
        }
        linger().await;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(ids)
    };

    let (ids, ()) = tokio::join!(server, async {
        let mut client = ClientConnection::connect(ClientConfig::new(&url, "t"))
            .await
            .unwrap();
        client.list_agents().await.expect("first");
        client.list_agents().await.expect("second");
    });

    let ids = ids.unwrap();
    assert_ne!(
        ids[0], ids[1],
        "two requests on one connection must not share an id"
    );
}

/// A server that never answers must **time out**, not hang.
#[tokio::test]
async fn a_silent_server_times_out() {
    let (listener, url) = bind().await.unwrap();

    let server = async {
        let mut ws = accept(&listener).await?;
        handshake(&mut ws).await?;
        // Read the request and answer nothing at all.
        let _ = next_request(&mut ws).await?;
        // Outlast the client's bound, then let the socket go.
        tokio::time::sleep(Duration::from_millis(500)).await;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    };

    let (server, ()) = tokio::join!(server, async {
        let mut client = ClientConnection::connect(ClientConfig::new(&url, "t"))
            .await
            .unwrap();
        let error = client
            .request_within(
                nession_client::proto_msg(
                    nession_client::wire::SERVER_AGENT_LIST,
                    nession_protocol::contracts::agent::v1::AgentListPayload {},
                ),
                Duration::from_millis(200),
            )
            .await
            .expect_err("a silent server must not answer");

        match error {
            ClientError::Timeout { wire, .. } => assert_eq!(wire, "server.agent.list"),
            other => panic!("expected a timeout, got {other:?}"),
        }
    });

    server.unwrap();
}

/// A refusal is the Server's sentence, carried out to the caller.
#[tokio::test]
async fn an_auth_refusal_carries_the_servers_message() {
    let (listener, url) = bind().await.unwrap();

    let server = async {
        let mut ws = accept(&listener).await?;
        let auth = next_request(&mut ws).await?;
        answer(
            &mut ws,
            &auth,
            json!({ "status": "error", "message": "invalid token" }),
        )
        .await?;
        linger().await;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    };

    let (server, ()) = tokio::join!(server, async {
        let error = match ClientConnection::connect(ClientConfig::new(&url, "wrong")).await {
            Ok(_) => panic!("a refused handshake must not produce a connection"),
            Err(error) => error,
        };

        match error {
            ClientError::Auth { message } => assert_eq!(message, "invalid token"),
            other => panic!("expected an auth error, got {other:?}"),
        }
    });

    server.unwrap();
}

/// A reply whose payload does not match the contract it answered under.
///
/// The interesting case in production is a Server and a consumer disagreeing
/// about a version. It is reported rather than retried because no retry fixes
/// it, and it is distinguishable from a frame that is not an envelope at all —
/// here there *is* a matching `id`, so the envelope is fine and only the
/// payload is wrong.
#[tokio::test]
async fn a_payload_that_misses_its_contract_is_reported() {
    let (listener, url) = bind().await.unwrap();

    let server = async {
        let mut ws = accept(&listener).await?;
        handshake(&mut ws).await?;
        let list = next_request(&mut ws).await?;
        // The right name and id, a payload neither arm of the union accepts.
        answer(&mut ws, &list, json!({ "nothing": "like a list" })).await?;
        linger().await;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    };

    let (server, ()) = tokio::join!(server, async {
        let mut client = ClientConnection::connect(ClientConfig::new(&url, "t"))
            .await
            .unwrap();
        match client.list_agents().await {
            Err(ClientError::Reply { wire, .. }) => assert_eq!(wire, "server.agent.list"),
            other => panic!("expected a decode failure, got {other:?}"),
        }
    });

    server.unwrap();
}

/// A text frame that is not an envelope is reported, not skipped.
///
/// Skipping is for frames that are *ours to ignore* — a push, a keepalive. A
/// frame with no readable envelope has no `id`, so there is nothing to decide
/// it by, and on a Server connection it means something is wrong.
#[tokio::test]
async fn a_frame_that_is_not_an_envelope_is_reported() {
    let (listener, url) = bind().await.unwrap();

    let server = async {
        let mut ws = accept(&listener).await?;
        handshake(&mut ws).await?;
        let _ = next_request(&mut ws).await?;
        ws.send(WsMessage::Text("this is not a protocol message".into()))
            .await?;
        linger().await;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    };

    let (server, ()) = tokio::join!(server, async {
        let mut client = ClientConnection::connect(ClientConfig::new(&url, "t"))
            .await
            .unwrap();
        match client.list_agents().await {
            Err(ClientError::Frame { wire, .. }) => assert_eq!(wire, "server.agent.list"),
            other => panic!("expected a frame error, got {other:?}"),
        }
    });

    server.unwrap();
}

/// The relay-mode request carries `"relay"`, and the reply's union decodes.
///
/// Also the only test that exercises the reply as a *union* on the mock side:
/// `Refused` and `Attached` are told apart by `message` against `mode`, and a
/// refusal has neither of the success fields — which is exactly what the flat
/// struct this replaced could not express.
#[tokio::test]
async fn a_relay_attach_decodes_as_the_union() {
    let (listener, url) = bind().await.unwrap();

    let server = async {
        let mut ws = accept(&listener).await?;
        handshake(&mut ws).await?;
        let attach = next_request(&mut ws).await?;
        assert_eq!(
            attach["payload"]["preferred_mode"], "relay",
            "the mode the caller chose must reach the wire"
        );
        answer(
            &mut ws,
            &attach,
            json!({ "status": "success", "mode": "relay", "session_id": "a:work" }),
        )
        .await?;
        linger().await;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    };

    let (server, ()) = tokio::join!(server, async {
        let mut client = ClientConnection::connect(ClientConfig::new(&url, "t"))
            .await
            .unwrap();
        let reply = client
            .request_attach("a:work", nession_client::AttachMode::Relay)
            .await
            .expect("the server answered");
        match reply {
            nession_protocol::contracts::session::v1::ClientSessionAttachReply::Attached(a) => {
                assert_eq!(a.mode, "relay");
                assert_eq!(a.session_id, "a:work");
            }
            other => panic!("expected an attach plan, got {other:?}"),
        }

        client.close().await.expect("closing is not a failure");
    });

    server.unwrap();
}

/// The socket can be handed to a caller that takes it over.
///
/// Asserted by using it: the handoff is a move of the whole socket, so a client
/// that had split it would have nothing to give back, and a frame written on
/// what came out has to reach the peer.
#[tokio::test]
async fn the_socket_can_be_handed_over() {
    let (listener, url) = bind().await.unwrap();

    let server = async {
        let mut ws = accept(&listener).await?;
        handshake(&mut ws).await?;
        // The relayed frame, read straight off the socket the client gave up.
        let relayed = next_request(&mut ws).await?;
        assert_eq!(relayed["msg_type"], "agent.attach");
        linger().await;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    };

    let (server, ()) = tokio::join!(server, async {
        let client = ClientConnection::connect(ClientConfig::new(&url, "t"))
            .await
            .unwrap();
        let mut socket = client.into_relay_transport();
        let frame = Message::new(
            "agent.attach",
            "relay-1",
            0,
            json!({ "session_name": "work" }),
        );
        socket
            .send(WsMessage::Text(serde_json::to_string(&frame).unwrap()))
            .await
            .unwrap();
        linger().await;
    });

    server.unwrap();
}

/// Closing mid-call is reported as closed — not a hang, not a decode failure.
#[tokio::test]
async fn a_close_mid_call_is_reported() {
    let (listener, url) = bind().await.unwrap();

    let server = async {
        let mut ws = accept(&listener).await?;
        handshake(&mut ws).await?;
        let _ = next_request(&mut ws).await?;
        ws.close(None).await?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    };

    let (server, ()) = tokio::join!(server, async {
        let mut client = ClientConnection::connect(ClientConfig::new(&url, "t"))
            .await
            .unwrap();
        let error = client.list_agents().await.expect_err("closed");

        match error {
            ClientError::Closed { wire } => assert_eq!(wire, "server.agent.list"),
            other => panic!("expected a closed error, got {other:?}"),
        }
    });

    server.unwrap();
}
