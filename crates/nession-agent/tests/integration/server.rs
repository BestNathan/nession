//! Integration tests for the agent WebSocket server.
//!
//! These tests exercise the public API of [`AgentServer`] end-to-end:
//! bind, connect, send requests, and receive responses. They require a
//! working tmux installation (same as the tmux manager / pty tests).

use super::{
    browser_scope, connect, connect_all_sessions, connect_for, mint_credential,
    unique_session_name, TestSession, WsSink, WsStream, TEST_AGENT_ID, TEST_CREDENTIAL,
};
use futures_util::{SinkExt, StreamExt};
use nession_agent::config::AttachMode;
use nession_agent::p2p_credentials::P2pCredentials;
use nession_agent::server::websocket::{
    msg_types, new_message, AgentServer, AgentServerContext, AuthResponsePayload,
    ClientAttachPayload, ClientAttachResponse, ClientAuthPayload, ClientDetachPayload,
    ClientDetachResponse, OkPayload, SessionCreatePayload, SessionCreateResponse,
    SessionKillPayload, SessionKillResponse,
};
use nession_agent::tmux::manager::SessionManager;
use nession_agent::tmux::ops::TmuxDep;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Start a test server (OS picks a free port) and return the real bound
/// address + handle, together with the credential store its listener checks.
///
/// The store is returned rather than kept here because a credential bound to a
/// session's **name** can only be minted once the test has generated that name —
/// see [`connect_for`]. It is the same `Arc` the listener holds, so a grant made
/// after this returns is one the listener honours.
async fn start_server(
    _port: u16,
) -> anyhow::Result<(
    SocketAddr,
    nession_agent::server::ServerHandle,
    Arc<P2pCredentials>,
)> {
    let tmp = Box::leak(Box::new(tempfile::tempdir()?));
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    // Built, granted into, and only then handed to the listener — the store the
    // listener checks has to be the one the credential was granted into
    // ([`mint_credential`]).
    let credentials = Arc::new(P2pCredentials::new());
    mint_credential(
        &credentials,
        TEST_AGENT_ID,
        TEST_CREDENTIAL,
        browser_scope(),
    )?;
    let server = AgentServer::new(
        "127.0.0.1:0",
        TEST_AGENT_ID,
        None,
        "/tmp".to_string(),
        tmp.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        AgentServerContext {
            resize,
            credentials: Arc::clone(&credentials),
            mutations: nession_agent::execution::mutation_scheduler(),
            memory_threshold_percent: None,
        },
    )?;
    let (handle, addr) = server.start().await?;
    Ok((addr, handle, credentials))
}

/// Send a request and receive the next text response, deserialised.
async fn round_trip<Req: Serialize, Resp: serde::de::DeserializeOwned>(
    sink: &mut WsSink,
    stream: &mut WsStream,
    req: &nession_agent::server::websocket::Message<Req>,
) -> anyhow::Result<nession_agent::server::websocket::Message<Resp>> {
    use anyhow::Context;

    let json = serde_json::to_string(req)?;
    let request_id = req.id.clone();
    sink.send(WsMessage::Text(json)).await?;
    loop {
        match stream.next().await.context("websocket stream ended")?? {
            WsMessage::Text(text) => {
                // Parse as raw value to check the request id - skip
                // unsolicited messages like terminal.output from
                // background tasks.
                let raw: serde_json::Value = serde_json::from_str(&text)?;
                if raw.get("id").and_then(|v| v.as_str()) == Some(&request_id) {
                    return Ok(serde_json::from_value(raw)?);
                }
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn integration_server_startup() {
    // Verify that the server binds, starts, and can be cleanly shut down.
    let (_, handle, _) = start_server(19081).await.unwrap();
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn integration_session_list() {
    let (addr, handle, credentials) = start_server(19082).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let req = new_message(msg_types::SESSION_LIST, serde_json::json!({}));
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();

    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(resp.payload.get("sessions").is_some());

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_session_create_and_kill() {
    let (addr, handle, credentials) = start_server(19083).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let session = TestSession::new("create-kill");
    let session_name = session.name().to_string();
    let create = SessionCreatePayload {
        name: session_name.to_string(),
        width: 80,
        height: 24,
        working_dir: None,
        env_snapshots: Vec::new(),
    };
    let req = new_message(msg_types::SESSION_CREATE, create);
    let resp: nession_agent::server::websocket::Message<SessionCreateResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.name, session_name);

    let kill = SessionKillPayload {
        name: session_name.to_string(),
    };
    let req = new_message(msg_types::SESSION_KILL, kill);
    let resp: nession_agent::server::websocket::Message<SessionKillResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.name, session_name);

    handle.shutdown().await.ok();
}

/// The user-visible half of #980: a snapshot sent over the wire reaches tmux.
///
/// The unit-level roundtrip in `tmux.rs` proves `env.rs` encodes
/// `set-environment` correctly; this proves the whole chain the user actually
/// exercises — `agent.session.create` → `apply_env_snapshots` → `EnvManager` →
/// tmux — and it is asserted against tmux rather than against the reply,
/// because the reply was the thing that lied. Before the fix this create
/// answered `ok` and tmux held nothing.
#[tokio::test]
async fn integration_session_create_env_snapshot_lands_in_tmux() {
    use std::time::Duration;

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let session = TestSession::new("env-lands");
    let name = session.name().to_string();
    let create = new_message(
        msg_types::SESSION_CREATE,
        serde_json::json!({
            "name": name,
            "width": 80,
            "height": 24,
            "env_snapshots": [{
                "name": "snap",
                "source": "agent",
                "vars": [
                    ["NESSON_LANDS", "through-the-wire"],
                    ["NESSON_LANDS_SPACED", "a b  c"],
                ],
                "warnings": [],
            }],
        }),
    );
    sink.send(WsMessage::Text(
        serde_json::to_value(&create).unwrap().to_string(),
    ))
    .await
    .expect("send the create");

    let answered = answer_for(&mut stream, &create.id, Duration::from_secs(30))
        .await
        .expect("the create was never answered");
    assert_eq!(
        answered["msg_type"],
        serde_json::json!(msg_types::OK),
        "a create carrying a well-formed snapshot was not answered ok: {answered}"
    );

    assert_eq!(
        super::tmux_show_environment(&name, "NESSON_LANDS")
            .await
            .as_deref(),
        Some("through-the-wire"),
        "the create answered ok while tmux held nothing — the reply was believed \
         instead of the session"
    );
    assert_eq!(
        super::tmux_show_environment(&name, "NESSON_LANDS_SPACED")
            .await
            .as_deref(),
        Some("a b  c"),
        "the value was not passed to tmux as one argv value"
    );

    handle.shutdown().await.ok();
}

/// A required env mutation tmux refuses is an error reply, not a warning.
///
/// #980's second half, and the reason the first half survived: failures here
/// were a `Vec<String>` of warnings that every caller logged before answering
/// `ok`. A repair that only fixed the grammar would leave #980's real lesson
/// in place — the agent could still report a mutation it did not perform.
///
/// The variable is deliberately one tmux refuses *for its own sake*
/// (`variable name contains =`, exit 1 — measured on tmux 3.6b), so what is
/// under test is the propagation and not the grammar: this payload fails
/// whether `env.rs` encodes `set-environment` correctly or not, and the only
/// way it can answer `ok` is if a required failure was downgraded to a log
/// line. That is what it did before the fix.
#[tokio::test]
async fn a_refused_env_mutation_is_an_error_reply_not_a_warning() {
    use std::time::Duration;

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let session = TestSession::new("env-refused");
    let create = new_message(
        msg_types::SESSION_CREATE,
        serde_json::json!({
            "name": session.name(),
            "width": 80,
            "height": 24,
            "env_snapshots": [{
                "name": "bad",
                "source": "agent",
                "vars": [["NESSON_BAD=NAME", "value"]],
                "warnings": [],
            }],
        }),
    );
    sink.send(WsMessage::Text(
        serde_json::to_value(&create).unwrap().to_string(),
    ))
    .await
    .expect("send the create");

    let answered = answer_for(&mut stream, &create.id, Duration::from_secs(30))
        .await
        .expect("the create was never answered");

    assert_eq!(
        answered["msg_type"],
        serde_json::json!(msg_types::ERROR),
        "a required env mutation the tmux layer refused was converted into protocol \
         success: {answered}"
    );
    assert_eq!(
        answered["payload"]["code"],
        serde_json::json!("env_apply_failed"),
        "the failure was reported as something other than the env mutation: {answered}"
    );
    // tmux's own words, which `stderr(Stdio::null())` used to discard — without
    // them the caller learns that something failed and nothing about what.
    assert!(
        answered["payload"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("contains =")),
        "the error does not retain tmux's diagnostic: {answered}"
    );

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_client_attach_creates_pty() {
    let (addr, handle, credentials) = start_server(19084).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("attach");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // The dial comes after the session does: the credential it presents is
    // bound to `session_name`, which is generated per run.
    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
        .await
        .unwrap();

    // Attach.
    let attach = ClientAttachPayload {
        session_name: session_name.to_string(),
        width: 80,
        height: 24,
        // These tests state a size they mean, so it is authoritative — the
        // same thing a client predating the field says by saying nothing
        // (#1265).
        size_known: None,
        env_snapshots: Vec::new(),
        needs_bootstrap: None,
    };
    let req = new_message(msg_types::CLIENT_ATTACH, attach);
    let resp: nession_agent::server::websocket::Message<ClientAttachResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.session_name, session_name);

    // Detach.
    let detach = ClientDetachPayload {
        session_name: session_name.to_string(),
    };
    let req = new_message(msg_types::CLIENT_DETACH, detach);
    let resp: nession_agent::server::websocket::Message<ClientDetachResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.session_name, session_name);

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
}

/// #1226: a second `agent.attach` on the SAME connection must be answered,
/// and the connection must survive it.
///
/// The path that reaches this is a product one: the client's attach state
/// machine retries on a timeout, and when the first attach actually
/// succeeded (its reply was slow or lost) the retry lands in the
/// `already_attached` arm. That arm replaces the peer; the old forwarder's
/// receiver ends; and the old verdict — "the session is still in the map" —
/// read that as "the subscriber stopped draining" and closed the connection.
/// The retry's own reply then had no socket to arrive on: the client waited
/// out its timeout and the terminal dropped for no visible reason.
///
/// Red without the fix: the second or third `round_trip` gets no frame at
/// all (not even an error) — exactly the silence the issue measures. The
/// third attach is what makes the red deterministic: the misjudged close
/// wins any race against the second reply, but it cannot take longer than
/// two round trips.
#[tokio::test]
async fn a_second_attach_on_the_same_connection_is_answered() {
    let (addr, handle, credentials) = start_server(0).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("reattach");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
        .await
        .unwrap();

    let attach = |session_name: &str| {
        new_message(
            msg_types::CLIENT_ATTACH,
            ClientAttachPayload {
                session_name: session_name.to_string(),
                width: 80,
                height: 24,
                size_known: None,
                env_snapshots: Vec::new(),
                // The history is not what is under test, and asking for it
                // would only give the misjudged close a longer window.
                needs_bootstrap: Some(false),
            },
        )
    };

    let req = attach(&session_name);
    let resp: nession_agent::server::websocket::Message<ClientAttachResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);

    // The retry: same connection, same session, same client id. Its answer
    // must arrive on this connection.
    let req = attach(&session_name);
    let answered = tokio::time::timeout(
        Duration::from_secs(5),
        round_trip(&mut sink, &mut stream, &req),
    )
    .await;
    let resp: nession_agent::server::websocket::Message<ClientAttachResponse> = answered
        .unwrap_or_else(|_| {
            panic!(
                "the second attach got no reply: the connection was closed by \
                 the peer it replaced (#1226)"
            )
        })
        .unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.session_name, session_name);

    // And the connection is still usable afterwards — a close that lost the
    // race to the second reply is still a close.
    let req = attach(&session_name);
    let answered = tokio::time::timeout(
        Duration::from_secs(5),
        round_trip(&mut sink, &mut stream, &req),
    )
    .await;
    let resp: nession_agent::server::websocket::Message<ClientAttachResponse> = answered
        .unwrap_or_else(|_| panic!("the connection did not survive the second attach (#1226)"))
        .unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
}

/// #321 SC4: Plain PTY `already_attached` must deliver a marked bootstrap on
/// the wire before the attach answer when the client asks for one.
#[tokio::test]
async fn a_plain_second_attach_sends_bootstrap_before_ok_when_asked() {
    let (addr, handle, credentials) = start_server(0).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("plain-sub");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
        .await
        .unwrap();

    let first = new_message(
        msg_types::CLIENT_ATTACH,
        ClientAttachPayload {
            session_name: session_name.clone(),
            width: 80,
            height: 24,
            size_known: None,
            env_snapshots: Vec::new(),
            needs_bootstrap: Some(false),
        },
    );
    let resp: nession_agent::server::websocket::Message<ClientAttachResponse> =
        round_trip(&mut sink, &mut stream, &first).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);

    let marker = "PLAIN-SUB-MARKER";
    TmuxDep::global()
        .ops()
        .send_keys(&session_name, &format!("echo {marker}\n"))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;

    // Drop anything the first attach's forwarder still had on the socket, so
    // only the second attach's ordering is under test.
    while let Ok(Some(Ok(WsMessage::Text(_)))) =
        tokio::time::timeout(Duration::from_millis(150), stream.next()).await
    {}

    let second = new_message(
        msg_types::CLIENT_ATTACH,
        ClientAttachPayload {
            session_name: session_name.clone(),
            width: 80,
            height: 24,
            size_known: None,
            env_snapshots: Vec::new(),
            needs_bootstrap: Some(true),
        },
    );
    sink.send(WsMessage::Text(serde_json::to_string(&second).unwrap()))
        .await
        .unwrap();

    let mut bootstrap: Option<serde_json::Value> = None;
    let mut live_before_bootstrap = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("timeout waiting for the second attach response")
            .expect("stream ended")
            .expect("error reading the second attach response");
        let WsMessage::Text(text) = frame else {
            continue;
        };
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        match parsed["msg_type"].as_str().unwrap_or("") {
            msg_types::OK => break,
            msg_types::TERMINAL_OUTPUT => {
                if parsed["payload"].get("bootstrap").is_some() {
                    bootstrap = Some(parsed["payload"].clone());
                } else if bootstrap.is_none() {
                    live_before_bootstrap = true;
                }
            }
            _ => {}
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for ok, bootstrap={bootstrap:?}"
        );
    }

    assert!(
        !live_before_bootstrap,
        "unmarked live output reached the client before its bootstrap (#321 SC4)"
    );
    let bootstrap = bootstrap.expect("the second attach sent no bootstrap");
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            bootstrap["data"]
                .as_str()
                .expect("bootstrap data is base64"),
        )
        .expect("bootstrap payload is valid base64");
    assert!(
        String::from_utf8_lossy(&bytes).contains(marker),
        "bootstrap did not carry live-produced context: {:?}",
        String::from_utf8_lossy(&bytes)
    );

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
}

#[tokio::test]
async fn a_plain_first_attach_sends_the_history_it_was_asked_for() {
    // #321 S6, plus the mode restoration of #1096 criterion 13. The Plain arm's
    // first attach used to send nothing at all, so a browser on the fallback
    // transport got no scrollback — and under Plain there is nowhere else for
    // it to come from: a tmux client paints its own screen and never replays
    // the pane's history into xterm's.
    //
    // The assertion is on the wire, before the ok, because that ordering *is*
    // the contract: the snapshot has to be enqueued before the live forwarder
    // exists, or the two race.
    let (addr, handle, credentials) = start_server(19086).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("plain-bootstrap");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // A pane that both holds a marker and is *in a mode* — the two things a
    // capture can and cannot carry, in one fixture. `sh -c` with a blocking
    // `cat` rather than a plain `echo`, because a shell that comes back to its
    // prompt resets the mode on the way: readline re-asserts its own, and the
    // measured symptom is a `keypad_cursor_flag` of 0 by the time anything asks.
    let marker = "PLAIN-BOOTSTRAP-MARKER";
    let mut setup = String::from("sh -c 'printf \"\\033[?1h\"; echo ");
    setup.push_str(marker);
    setup.push_str("; cat > /dev/null'\n");
    TmuxDep::global()
        .ops()
        .send_keys(&session_name, &setup)
        .await
        .unwrap();

    // Give the pane a moment to run the setup line before polling flags — under
    // parallel coverage runs the 5 s deadline alone was too tight (#321 push).
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Waited on the *flags*, not on the marker: the mode is what the wait is
    // for, and asking tmux for it is the same query the bootstrap under test
    // makes — so a wrong reading here fails here rather than as a mysterious
    // wire assertion below.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let flags = TmuxDep::global()
            .ops()
            .pane_mode_flags(&session_name)
            .await
            .expect("the pane mode query works against a real tmux");
        if flags.keypad_cursor {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "if this fails the fixture never set the mode, and the assertion \
             below would be asking about nothing"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
        .await
        .unwrap();

    // `None` — the client says nothing, which is what every client predating
    // the field does, and what the CLI's own attach sends.
    let attach = ClientAttachPayload {
        session_name: session_name.to_string(),
        width: 80,
        height: 24,
        // These tests state a size they mean, so it is authoritative — the
        // same thing a client predating the field says by saying nothing
        // (#1265).
        size_known: None,
        env_snapshots: Vec::new(),
        needs_bootstrap: None,
    };
    let req = new_message(msg_types::CLIENT_ATTACH, attach);
    sink.send(WsMessage::Text(serde_json::to_string(&req).unwrap()))
        .await
        .unwrap();

    let mut bootstrap: Option<serde_json::Value> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("timeout waiting for the attach response")
            .expect("stream ended")
            .expect("error reading the attach response");
        let WsMessage::Text(text) = frame else {
            continue;
        };
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        match parsed["msg_type"].as_str().unwrap_or("") {
            msg_types::OK => break,
            msg_types::TERMINAL_OUTPUT => {
                if let Some(marker_field) = parsed["payload"].get("bootstrap") {
                    bootstrap = Some(serde_json::json!({
                        "marker": marker_field.clone(),
                        "data": parsed["payload"]["data"].clone(),
                    }));
                }
            }
            _ => {}
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for ok, last frames: {bootstrap:?}"
        );
    }

    let bootstrap = bootstrap.expect("a Plain first attach sent no bootstrap at all");
    assert_eq!(
        bootstrap["marker"]["requested_lines"].as_u64(),
        Some(u64::from(nession_agent::tmux::HISTORY_LIMIT_LINES)),
        "the snapshot is the depth the agent owns, not a number of its own"
    );
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bootstrap["data"].as_str().expect("base64 data"))
        .expect("the bootstrap payload is base64");
    // The join of the snapshot has to be the session's own history, not a
    // screenful of whatever tmux redrew: the marker was printed before the
    // attach and reaches the client only through this frame.
    assert!(
        String::from_utf8_lossy(&bytes).contains(marker),
        "the bootstrap does not carry the pane's history: {:?}",
        String::from_utf8_lossy(&bytes)
    );

    // **Every line ends CRLF, not LF.** A capture is a screen reconstruction
    // and a screen has no carriage returns in it — measured: `capture-pane -p`
    // emits `41 41 41 0a` for a line `AAA` — while the live stream from the same
    // pane carries `\r\n`, because the tty's ONLCR runs upstream of tmux.
    // Written into xterm with `convertEol: false`, an LF-only capture leaves the
    // cursor in the same column, so the history arrives as a diagonal. Found in
    // a screenshot, with every content assertion green.
    assert!(
        bytes.windows(2).any(|w| w == b"\r\n"),
        "the snapshot has no CRLF, so a terminal fed it would not start its \
         lines at column zero: {:?}",
        String::from_utf8_lossy(&bytes[..bytes.len().min(120)])
    );

    // **The snapshot ends on the last row the session wrote to**, not on the
    // blank screen underneath it. `capture-pane -p -S - -E -` ends at the bottom
    // of the *visible pane*, and a pane that has run three commands is mostly
    // rows nothing was ever written to — measured: 13 of 40 captured rows empty
    // on a 41-row screen. Every one of them was written into xterm and the
    // cursor landed on the last, so the user's content sat at the top of a
    // mostly-empty screen with the caret far below it.
    //
    // Asserted as "the stream does not end in a line terminator", which is the
    // same statement: a trailing blank row *is* a terminator with nothing after
    // it, so this reddens the moment `strip_trailing_blank_rows` stops being
    // called — the wiring half that the unit tests in `bootstrap.rs` cannot see.
    let text = String::from_utf8_lossy(&bytes);
    let last_line = text.rsplit("\r\n").next().unwrap_or_default();
    assert!(
        !last_line.is_empty(),
        "the snapshot ends below its own content, so the pane's unwritten \
         screen is being sent as history (last 60 bytes: {:?})",
        String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(60)..])
    );

    // **The mode, in front of the text.** This is the half a `capture-pane` can
    // never supply and the reason `pane_mode_flags` exists: the pane is in
    // application-cursor mode, `capture-pane -e` carries only SGR attributes
    // (measured — the escapes below appear on no captured line), and a client
    // that came back without this would encode its next arrow key `^[[A` while
    // the application waits for `^[OA` (#1096 criterion 13).
    //
    // Asserted as a position rather than a containment: written after the text
    // it would still restore the mode for *later* keystrokes, but the ordering
    // is the contract — the application's screen is entered before its text is
    // written into it.
    assert!(
        bytes.starts_with(b"\x1b[?1h"),
        "the bootstrap does not open with the pane's mode escapes: {:?}",
        String::from_utf8_lossy(&bytes[..bytes.len().min(80)])
    );

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_terminal_io_flow() {
    let (addr, handle, credentials) = start_server(19085).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("io");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // The dial comes after the session does: the credential it presents is
    // bound to `session_name`, which is generated per run.
    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
        .await
        .unwrap();

    // Attach.
    let attach = ClientAttachPayload {
        session_name: session_name.to_string(),
        width: 80,
        height: 24,
        // These tests state a size they mean, so it is authoritative — the
        // same thing a client predating the field says by saying nothing
        // (#1265).
        size_known: None,
        env_snapshots: Vec::new(),
        needs_bootstrap: None,
    };
    let req = new_message(msg_types::CLIENT_ATTACH, attach);
    let _: nession_agent::server::websocket::Message<ClientAttachResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();

    // Send terminal input immediately — post-attach sleep breaks macOS PTY writes.
    use base64::Engine;
    let input = base64::engine::general_purpose::STANDARD.encode(b"echo hello\n");
    let payload = nession_agent::server::websocket::TerminalInputPayload {
        session_name: session_name.to_string(),
        data: input,
        control_generation: None,
        input_epoch: None,
        seq_start: None,
        seq_end: None,
    };
    let req = new_message(msg_types::TERMINAL_INPUT, payload);
    let resp: nession_agent::server::websocket::Message<OkPayload> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);

    // Wait for terminal output.
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

    let mut got_hello = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_secs(2), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let msg: nession_agent::server::websocket::Message<serde_json::Value> =
                    serde_json::from_str(&text).unwrap();
                if msg.msg_type == msg_types::TERMINAL_OUTPUT {
                    let b64 = msg.payload.get("data").unwrap().as_str().unwrap();
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .unwrap();
                    if String::from_utf8_lossy(&decoded).contains("hello") {
                        got_hello = true;
                        break;
                    }
                }
            }
            _ => break,
        }
    }

    // Detach and clean up.
    let detach = ClientDetachPayload {
        session_name: session_name.to_string(),
    };
    let req = new_message(msg_types::CLIENT_DETACH, detach);
    let _: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();

    assert!(got_hello, "expected terminal output containing 'hello'");
}

/// A resize the agent records reaches the client at the position it was
/// recorded at (#1303).
///
/// `record_resize` consumes a sequence number. Before this, the frame that
/// reported the resize carried no position and the agent sent nothing else for
/// it, so a client's cursor — contiguous by construction — had a hole exactly
/// where the stream log had an event. Every attach paid for it twice over: a
/// client fits its terminal and resizes on the way in, so the hole sat between
/// the attach's seeded cursor and the first output frame, and the round trip
/// that closed it returned the very resize the client had already applied.
///
/// Three places read a stream position and all three have to agree: what the
/// **attach** seeded, what the agent **broadcast**, and what the log **reports**
/// to a resume. A frame whose position is not the log's would have the client
/// filter its own replay as a duplicate; a frame with no position at all is the
/// hole. So this asserts the position exists, that it is the log's, and that
/// the log it is being placed in has no gaps.
#[tokio::test]
async fn a_recorded_resize_reaches_the_client_at_its_stream_position() {
    let (addr, handle, credentials) = start_server(19087).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("resize-seq");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
        .await
        .unwrap();

    let attach = ClientAttachPayload {
        session_name: session_name.to_string(),
        width: 80,
        height: 24,
        size_known: None,
        env_snapshots: Vec::new(),
        // No history: this test counts stream positions, and a bootstrap is
        // outside the timeline by construction — the agent gives it no
        // position precisely so it cannot be taken for an event in the stream.
        needs_bootstrap: Some(false),
    };
    let req = new_message(msg_types::CLIENT_ATTACH, attach);
    let attached: nession_agent::server::websocket::Message<ClientAttachResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    let seeded_epoch = attached
        .payload
        .stream_epoch
        .expect("the attach seeds an epoch");
    let seeded_cursor = attached
        .payload
        .stream_cursor
        .expect("the attach seeds a cursor");

    // The resize is what consumes the position this test is about; the input
    // that follows is what would be held behind it if a client had to recover
    // the hole with a round trip.
    let resize = nession_agent::server::websocket::TerminalResizePayload {
        session_name: session_name.to_string(),
        cols: 100,
        rows: 30,
        control_generation: None,
        stream_epoch: None,
        stream_seq: None,
    };
    let req = new_message(msg_types::TERMINAL_RESIZE, resize);
    let resize_id = req.id.clone();
    sink.send(WsMessage::Text(serde_json::to_string(&req).unwrap()))
        .await
        .unwrap();

    use base64::Engine;
    let input = base64::engine::general_purpose::STANDARD.encode(b"echo resize-seq\n");
    let req = new_message(
        msg_types::TERMINAL_INPUT,
        nession_agent::server::websocket::TerminalInputPayload {
            session_name: session_name.to_string(),
            data: input,
            control_generation: None,
            input_epoch: None,
            seq_start: None,
            seq_end: None,
        },
    );
    sink.send(WsMessage::Text(serde_json::to_string(&req).unwrap()))
        .await
        .unwrap();

    // Drain until the resize has been both answered and broadcast and the
    // stream has moved past it. Everything the connection delivers carries a
    // position, so what arrives is also what a client would have to account
    // for.
    let mut acked = false;
    let mut broadcast = None;
    let mut delivered: Vec<u64> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let Some(frame) = next_frame_within(&mut stream, Duration::from_secs(2))
            .await
            .unwrap()
        else {
            break;
        };
        if frame.get("id").and_then(serde_json::Value::as_str) == Some(resize_id.as_str()) {
            acked = true;
        }
        let payload = frame.get("payload");
        match frame.get("msg_type").and_then(serde_json::Value::as_str) {
            Some(t) if t == msg_types::TERMINAL_RESIZE => broadcast = Some(frame),
            Some(t) if t == msg_types::TERMINAL_OUTPUT => {
                if let Some(seq) = payload
                    .and_then(|p| p.get("stream_seq"))
                    .and_then(serde_json::Value::as_u64)
                {
                    delivered.push(seq);
                }
            }
            _ => {}
        }
        // The resize ACK/broadcast can reach this reader before earlier
        // asynchronous terminal output. Do not assert on that partial receive
        // window: a valid late frame would otherwise look like a missing
        // stream position ([1, 3] before position 2 arrives).
        //
        // This does not waive stream gaps. The same bounded deadline applies,
        // and the strict no-gap assertion below still fails if a position
        // never arrives.
        if acked {
            if let Some(resize_seq) = broadcast
                .as_ref()
                .and_then(|frame| frame.get("payload"))
                .and_then(|payload| payload.get("stream_seq"))
                .and_then(serde_json::Value::as_u64)
            {
                if !delivered.is_empty() {
                    let mut received = delivered.clone();
                    received.push(resize_seq);
                    received.sort_unstable();
                    if received.windows(2).all(|pair| pair[1] == pair[0] + 1) {
                        break;
                    }
                }
            }
        }
    }

    assert!(acked, "the resize request was never answered");
    let frame = broadcast.expect("the recorded resize was never broadcast to the client");
    let payload = frame.get("payload").expect("a resize frame has a payload");
    let epoch = payload
        .get("stream_epoch")
        .and_then(serde_json::Value::as_u64)
        .expect(
            "the broadcast resize carries no stream_epoch: it consumed a sequence number, \
             so a client can only account for it as a hole (#1303)",
        );
    let seq = payload
        .get("stream_seq")
        .and_then(serde_json::Value::as_u64)
        .expect(
            "the broadcast resize carries no stream_seq: the position it was recorded at is \
             exactly what the client's cursor needs (#1303)",
        );
    assert_eq!(
        epoch, seeded_epoch,
        "the broadcast resize is on a different epoch than the attach that seeded the cursor"
    );
    assert!(
        seq > seeded_cursor,
        "the resize reports seq {seq}, which the seeded cursor {seeded_cursor} has already passed"
    );
    assert_eq!(
        payload.get("cols").and_then(serde_json::Value::as_u64),
        Some(100),
        "the broadcast carries the size that was asked for"
    );

    // And it is the log's position, not merely *a* position: the events after
    // the seeded cursor are contiguous, and the one at this sequence number is
    // the same resize. Read as raw JSON because that is what the client reads —
    // the assertion is about the wire, not about a Rust type agreeing with
    // itself.
    let resume = new_message(
        msg_types::TERMINAL_STREAM_RESUME,
        nession_agent::server::websocket::TerminalStreamResumePayload {
            session_name: session_name.to_string(),
            stream_epoch: seeded_epoch,
            after_seq: seeded_cursor,
        },
    );
    let reply: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &resume).await.unwrap();
    assert_eq!(
        reply
            .payload
            .get("epoch_match")
            .and_then(serde_json::Value::as_bool),
        Some(true),
        "the log refused the epoch the attach itself seeded"
    );
    let events = reply
        .payload
        .get("events")
        .and_then(|v| v.as_array())
        .expect("a resume reply carries its events");
    let log: Vec<u64> = events
        .iter()
        .filter_map(|event| event.get("stream_seq").and_then(serde_json::Value::as_u64))
        .collect();
    assert!(
        !log.is_empty(),
        "the log has nothing after the seeded cursor"
    );
    assert_eq!(
        log,
        (seeded_cursor + 1..=seeded_cursor + log.len() as u64).collect::<Vec<u64>>(),
        "the log is not contiguous from the cursor the attach seeded, so no client can \
         advance past it without a round trip"
    );
    let logged_resize = events
        .iter()
        .find(|event| event.get("stream_seq").and_then(serde_json::Value::as_u64) == Some(seq))
        .expect("seq {seq} is in the log");
    assert_eq!(
        (
            logged_resize
                .get("kind")
                .and_then(serde_json::Value::as_str),
            logged_resize
                .get("cols")
                .and_then(serde_json::Value::as_u64),
        ),
        (Some("resize"), Some(100)),
        "the position the resize was broadcast at holds something else in the log: a client \
         would take the live frame for a duplicate and drop it"
    );

    // The stream positions that reached the client live are a subset of the
    // log's and have no gaps of their own — the property the whole change
    // exists for.
    let mut live = delivered.clone();
    live.push(seq);
    live.sort_unstable();
    assert_eq!(
        live,
        (live[0]..=live[live.len() - 1]).collect::<Vec<u64>>(),
        "the positions delivered live have a gap: {live:?}"
    );
    assert!(
        live.iter().all(|s| log.contains(s)),
        "a position delivered live ({live:?}) is not in the log ({log:?})"
    );

    let detach = ClientDetachPayload {
        session_name: session_name.to_string(),
    };
    let req = new_message(msg_types::CLIENT_DETACH, detach);
    let _: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
}

/// `agent.terminal.stream.resume` says which window it is answering from, and
/// whether that answer is the whole of it (#1304).
///
/// `epoch_match` answers "is this the stream you asked about" and nothing else.
/// It never answered "does this stream still hold everything you are missing",
/// and a stream log is bounded — the ring evicts from the front — so a client
/// that was away long enough was handed a tail starting far above its cursor,
/// under a matching epoch, with nothing on the wire saying the stretch in
/// between was gone. It read that as complete recovery and advanced its cursor
/// over output no later request could return.
///
/// The assertions are on the **raw JSON**, because the wire is what a client
/// reads; a value shaped by a Rust type agreeing with itself would prove
/// nothing about it.
///
/// The window reachable here is a fresh session's, so nothing has been evicted
/// and the floor is the first event. Eviction itself is `session_terminal.rs`'s
/// — `stream_of` drives the real policy with a small ring — because reaching it
/// through a real pane would take 4096 events and exercise the same code.
#[tokio::test]
async fn a_resume_states_its_window_and_whether_it_is_complete() {
    let (addr, handle, credentials) = start_server(19094).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("stream-window");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
        .await
        .unwrap();

    let attach = ClientAttachPayload {
        session_name: session_name.to_string(),
        width: 80,
        height: 24,
        size_known: None,
        env_snapshots: Vec::new(),
        // No history: a bootstrap is outside the timeline by construction, and
        // this test counts the positions that are in it.
        needs_bootstrap: Some(false),
    };
    let req = new_message(msg_types::CLIENT_ATTACH, attach);
    let attached: nession_agent::server::websocket::Message<ClientAttachResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    let seeded_epoch = attached
        .payload
        .stream_epoch
        .expect("the attach seeds an epoch");
    let seeded_cursor = attached
        .payload
        .stream_cursor
        .expect("the attach seeds a cursor");

    // Something in the stream past the seeded cursor, so the first answer has a
    // window and events to state it over.
    use base64::Engine;
    let input = base64::engine::general_purpose::STANDARD.encode(b"echo stream-window\n");
    let req = new_message(
        msg_types::TERMINAL_INPUT,
        nession_agent::server::websocket::TerminalInputPayload {
            session_name: session_name.to_string(),
            data: input,
            control_generation: None,
            input_epoch: None,
            seq_start: None,
            seq_end: None,
        },
    );
    sink.send(WsMessage::Text(serde_json::to_string(&req).unwrap()))
        .await
        .unwrap();

    let mut delivered: Vec<u64> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let Some(frame) = next_frame_within(&mut stream, Duration::from_secs(2))
            .await
            .unwrap()
        else {
            break;
        };
        if frame.get("msg_type").and_then(serde_json::Value::as_str)
            == Some(msg_types::TERMINAL_OUTPUT)
        {
            if let Some(seq) = frame
                .get("payload")
                .and_then(|p| p.get("stream_seq"))
                .and_then(serde_json::Value::as_u64)
            {
                delivered.push(seq);
            }
        }
        if delivered.iter().any(|seq| *seq > seeded_cursor) {
            break;
        }
    }
    assert!(
        delivered.iter().any(|seq| *seq > seeded_cursor),
        "the pane produced nothing after the attach, so there is no window to \
         state: {delivered:?}"
    );

    let resume = |epoch: u64, after_seq: u64| {
        new_message(
            msg_types::TERMINAL_STREAM_RESUME,
            nession_agent::server::websocket::TerminalStreamResumePayload {
                session_name: session_name.clone(),
                stream_epoch: epoch,
                after_seq,
            },
        )
    };

    let req = resume(seeded_epoch, seeded_cursor);
    let reply: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(
        reply
            .payload
            .get("complete")
            .and_then(serde_json::Value::as_bool),
        Some(true),
        "a replay from the cursor the attach itself seeded was answered as \
         incomplete, which tells a client with a whole buffer to distrust it"
    );
    assert_eq!(
        reply
            .payload
            .get("first_available_seq")
            .and_then(serde_json::Value::as_u64),
        Some(1),
        "the answer states no retained window, so a client cannot tell a tail \
         whose beginning was evicted from a stream with nothing more to send \
         (#1304)"
    );
    let events = reply
        .payload
        .get("events")
        .and_then(|v| v.as_array())
        .expect("a resume reply carries its events");
    let log: Vec<u64> = events
        .iter()
        .filter_map(|event| event.get("stream_seq").and_then(serde_json::Value::as_u64))
        .collect();
    assert_eq!(
        log,
        (seeded_cursor + 1..=seeded_cursor + log.len() as u64).collect::<Vec<u64>>(),
        "the replay is not contiguous from the cursor the attach seeded, so no \
         client can advance past it without a round trip"
    );

    // A cursor at the head of what just arrived. The answer may carry more
    // events — the pane is live — and the assertion covers both shapes: an
    // empty answer is the one that used to be ambiguous, and it is complete by
    // the same law as any other, because this cursor is inside the window.
    let head = *log.last().expect("the first reply carried events");
    let req = resume(seeded_epoch, head);
    let reply: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(
        reply
            .payload
            .get("first_available_seq")
            .and_then(serde_json::Value::as_u64),
        Some(1),
        "the window moved between two resumes that evicted nothing"
    );
    assert_eq!(
        reply
            .payload
            .get("complete")
            .and_then(serde_json::Value::as_bool),
        Some(true),
        "a replay from a cursor inside the window was answered as incomplete"
    );
    let events = reply
        .payload
        .get("events")
        .and_then(|v| v.as_array())
        .expect("a resume reply carries its events");
    let after: Vec<u64> = events
        .iter()
        .filter_map(|event| event.get("stream_seq").and_then(serde_json::Value::as_u64))
        .collect();
    assert_eq!(
        after,
        (head + 1..=head + after.len() as u64).collect::<Vec<u64>>(),
        "the answer to a head cursor is not contiguous from it"
    );

    // An epoch this agent never issued. The behaviour #1094 shipped is
    // unchanged, and the new fields are **absent** rather than zero: the live
    // epoch's floor is not an answer to a request about a stream this agent no
    // longer has, and a caller's sequences are not comparable with it.
    let req = resume(seeded_epoch.wrapping_add(1), seeded_cursor);
    let reply: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(
        reply
            .payload
            .get("epoch_match")
            .and_then(serde_json::Value::as_bool),
        Some(false),
        "a request about another stream was answered as if it matched"
    );
    assert!(
        reply.payload.get("first_available_seq").is_none(),
        "an epoch mismatch stated a window: the field's absence is what says \
         there is no position for this request, and a zero would say the \
         opposite"
    );
    assert!(
        reply.payload.get("complete").is_none(),
        "an epoch mismatch stated completeness about a stream it is not about"
    );
    assert_eq!(
        reply
            .payload
            .get("events")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(0),
        "an epoch mismatch carried events from the live stream"
    );

    let detach = ClientDetachPayload {
        session_name: session_name.to_string(),
    };
    let req = new_message(msg_types::CLIENT_DETACH, detach);
    let _: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
}

// ---------------------------------------------------------------------------
// Web UI compatibility handlers
// ---------------------------------------------------------------------------

use nession_agent::server::websocket::{
    WebAttachInfo, WebSessionCreatePayload, WebSessionCreateResponse, WebSessionKillPayload,
    WebSessionKillResponse, WebSessionsListResponse,
};

#[tokio::test]
async fn integration_web_ui_client_auth() {
    let (addr, handle, credentials) = start_server(19086).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let req = new_message(
        msg_types::CLIENT_AUTH,
        serde_json::json!({"auth_token":"tok"}),
    );
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload["status"], "success");

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_sessions_list() {
    let (addr, handle, credentials) = start_server(19088).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let req = new_message(msg_types::CLIENT_SESSIONS_LIST, serde_json::json!({}));
    let resp: nession_agent::server::websocket::Message<WebSessionsListResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_session_create() {
    let (addr, handle, credentials) = start_server(19089).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let session = TestSession::new("web-create");
    let payload = WebSessionCreatePayload {
        agent_id: "local-agent".to_string(),
        name: session.name().to_string(),
        width: 80,
        height: 24,
        working_dir: None,
    };
    let req = new_message(msg_types::CLIENT_SESSION_CREATE, payload);
    let resp: nession_agent::server::websocket::Message<WebSessionCreateResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(resp.payload.success);
    // Extract the session name from the response for cleanup.
    let created_name = resp
        .payload
        .session_id
        .as_deref()
        .and_then(|sid| sid.split(':').nth(1))
        .unwrap_or("");
    assert!(!created_name.is_empty());

    // Clean up.
    let tmux = SessionManager::new();
    tmux.kill_session(created_name).await.ok();
    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_session_kill() {
    let (addr, handle, credentials) = start_server(19090).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    // Create a session first.
    let tmux = SessionManager::new();
    let session = TestSession::new("web-kill");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let payload = WebSessionKillPayload {
        session_id: format!("local-agent:{session_name}"),
    };
    let req = new_message(msg_types::CLIENT_SESSION_KILL, payload);
    let resp: nession_agent::server::websocket::Message<WebSessionKillResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(resp.payload.success);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_session_attach() {
    let (addr, handle, credentials) = start_server(19091).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let payload = serde_json::json!({
        "session_id": "local-agent:webui_attach",
        "preferred_mode": "p2p"
    });
    let req = new_message(msg_types::CLIENT_SESSION_ATTACH, payload);
    let resp: nession_agent::server::websocket::Message<WebAttachInfo> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.mode, "p2p");
    assert_eq!(resp.payload.session_name, "webui_attach");

    handle.shutdown().await.ok();
}

// ---------------------------------------------------------------------------
// Detach when not attached, resize when not attached
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_detach_not_attached() {
    let (addr, handle, credentials) = start_server(19092).await.unwrap();
    let (mut sink, mut stream) = connect_for(&credentials, addr, "nonexistent")
        .await
        .unwrap();

    let detach = ClientDetachPayload {
        session_name: "nonexistent".to_string(),
    };
    let req = new_message(msg_types::CLIENT_DETACH, detach);
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::ERROR);
    assert_eq!(resp.payload["code"], "not_attached");

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_terminal_input_not_attached() {
    let (addr, handle, credentials) = start_server(19093).await.unwrap();
    let (mut sink, mut stream) = connect_for(&credentials, addr, "ghost").await.unwrap();

    use base64::Engine;
    let input = base64::engine::general_purpose::STANDARD.encode(b"test");
    let payload = nession_agent::server::websocket::TerminalInputPayload {
        session_name: "ghost".to_string(),
        data: input,
        control_generation: None,
        input_epoch: None,
        seq_start: None,
        seq_end: None,
    };
    let req = new_message(msg_types::TERMINAL_INPUT, payload);
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::ERROR);
    assert_eq!(resp.payload["code"], "not_attached");

    handle.shutdown().await.ok();
}

// ---------------------------------------------------------------------------
// The per-connection execution model (#961 stage A)
// ---------------------------------------------------------------------------
//
// **Characterization, not aspiration.** What is pinned here is what this tree
// does today, and the stage expected to change it is named with it.

/// The same server, with the directory its file sandbox is rooted in.
///
/// The root is the one thing a file-op test must be able to reach into, and
/// `AgentServer::new` canonicalizes it at construction — so the caller has to
/// keep the directory alive for as long as the server runs.
///
/// The credential store comes back with it, for the same reason
/// [`start_server`] returns one.
async fn start_server_with_file_root() -> anyhow::Result<(
    SocketAddr,
    nession_agent::server::ServerHandle,
    tempfile::TempDir,
    Arc<P2pCredentials>,
)> {
    let root = tempfile::tempdir()?;
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    let credentials = Arc::new(P2pCredentials::new());
    mint_credential(
        &credentials,
        TEST_AGENT_ID,
        TEST_CREDENTIAL,
        browser_scope(),
    )?;
    let server = AgentServer::new(
        "127.0.0.1:0",
        TEST_AGENT_ID,
        None,
        "/tmp".to_string(),
        root.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        AgentServerContext {
            resize,
            credentials: Arc::clone(&credentials),
            mutations: nession_agent::execution::mutation_scheduler(),
            memory_threshold_percent: None,
        },
    )?;
    let (handle, addr) = server.start().await?;
    Ok((addr, handle, root, credentials))
}

/// Create a FIFO. Not tmux, and not spawnable through anything else on this
/// platform without a crate: `mkfifo(1)` is the one tool that makes one.
fn make_fifo(path: &std::path::Path) -> anyhow::Result<()> {
    let status = std::process::Command::new("mkfifo").arg(path).status()?;
    anyhow::ensure!(status.success(), "mkfifo {path:?} failed");
    Ok(())
}

/// Release a read that is parked on a FIFO **that has never had a writer**.
///
/// The park is `open`: `fs::read` opens the FIFO for reading, and with no writer
/// anywhere that open blocks — before the read, before anything. The release is
/// the writer arriving and leaving: opening for writing unblocks the reader (the
/// two rendezvous in the kernel), and closing is its end-of-file.
///
/// This is the arrangement to reach for when a test has to release two parks
/// independently, and the reason is the rendezvous. Holding a writer open from
/// the start and closing it to release — what the single-park test above does —
/// has a window the test cannot close: if the writer is closed before the
/// reader's `open` has happened, that open blocks forever, and the failure
/// arrives as a hung test binary rather than as a failed assertion. I hit
/// exactly that writing the two-park test below. Here the writer's open *cannot
/// complete* until a reader is present, so there is no such window.
///
/// A thread, not an `await`: the writer's open blocks until the reader is there,
/// and that wait belongs to neither the test's task nor the runtime's blocking
/// pool. If the reader never comes the thread stays parked and the process exits
/// without it — whereas a blocking-pool task in the same state would hold the
/// runtime's own shutdown open and turn a failing test into a hanging one.
fn release_parked_fifo(path: std::path::PathBuf) {
    std::thread::spawn(move || {
        // `File::create` is the blocking open; the guard closes on return.
        let _ = std::fs::File::create(path);
    });
}

/// A FIFO a test parks a read on, and whose release the test **cannot** forget.
///
/// The release runs on drop, so it does not depend on reaching the end of the
/// test body. That is the entire point, and it is `#1022`:
///
/// A read parked at the end of a test parks a `spawn_blocking` task, and the
/// runtime's shutdown waits for it. So a panic anywhere between parking and
/// releasing — an assertion, or a bounded wait that expired because the machine
/// was loaded — does not produce a failing test. It produces a **hanging** one:
/// silent, indistinguishable from a slow machine, and it blocks pre-push, which
/// this repository does not let anyone bypass. Measured on 2026-09-24 under an
/// instrumented coverage build with the machine at load 9.5: **13 minutes of
/// sleeping at ~0% CPU**, with a live 13-minute test session alongside it.
///
/// Releasing explicitly is still what a test does when the *ordering* matters —
/// the two-park test below releases `second` and reads before it touches
/// `first`, and that ordering is the thing under test. The drop is the backstop
/// for the case where the test never gets there.
struct ParkedFifo {
    path: std::path::PathBuf,
    released: bool,
}

impl ParkedFifo {
    fn new(path: std::path::PathBuf) -> anyhow::Result<Self> {
        make_fifo(&path)?;
        Ok(Self {
            path,
            released: false,
        })
    }

    /// Let the parked read finish, now.
    fn release(&mut self) {
        // Idempotent, and it has to be: releasing twice would spawn a second
        // writer for a FIFO whose reader has already gone, and *that* open
        // blocks — trading a hang on the failure path for a hang on the success
        // path.
        if std::mem::replace(&mut self.released, true) {
            return;
        }
        release_parked_fifo(self.path.clone());
    }
}

impl Drop for ParkedFifo {
    fn drop(&mut self) {
        self.release();
    }
}

/// The next **answer** within `window` — a frame that is not one the agent
/// volunteers.
///
/// The ordering tests below ask which of two answers arrived first, and a
/// session's history arrives before the attach's own answer: the Plain arm
/// sends it, awaited, ahead of the reply, because that ordering is the
/// bootstrap contract (#321). It is a `terminal.output` notification and not an
/// answer to anything, so it is skipped here rather than counted as one.
///
/// Skipping is the whole of it — the frame is not asserted absent, because
/// whether a given session has history to send is the arm's business and not
/// this helper's.
async fn next_answer_within(
    stream: &mut WsStream,
    window: std::time::Duration,
) -> anyhow::Result<Option<serde_json::Value>> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        let Some(frame) = next_frame_within(stream, remaining).await? else {
            return Ok(None);
        };
        // `.get`, not `frame["msg_type"]`: indexing panics on a frame that has
        // no such key, and a helper is not a `#[test]` function, so the
        // workspace's in-tests allowance does not reach here.
        //
        // **Notifications are skipped, and the list is a category.** This asks
        // for the next frame that *answers* something, and neither of these
        // does: `agent.terminal.output` is the session's output and
        // `agent.terminal.input.ack` (#1307) is its applied input cursor. Both
        // are pushed on the agent's own initiative, both carry an `id` they
        // generated themselves, and counting either as an answer is how a test
        // that means "the attach was replied to before the input was" reads a
        // keystroke's receipt as the attach's reply.
        let msg_type = frame.get("msg_type").and_then(|v| v.as_str());
        if msg_type != Some(msg_types::TERMINAL_OUTPUT)
            && msg_type != Some(msg_types::TERMINAL_INPUT_ACK)
        {
            return Ok(Some(frame));
        }
    }
}

/// The next text frame within `window`, or `None` if none arrived.
async fn next_frame_within(
    stream: &mut WsStream,
    window: std::time::Duration,
) -> anyhow::Result<Option<serde_json::Value>> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => return Ok(Some(serde_json::from_str(&text)?)),
            Ok(Some(Ok(_))) => {}
            _ => return Ok(None),
        }
    }
}

/// A file request that is still running no longer holds the connection.
///
/// The slow request is a read of a FIFO, which is the one file operation whose
/// duration the test owns: `fs::read` opens it and then reads to end-of-file,
/// and end-of-file arrives only when the last writer closes. The writer here is
/// the *test*, opened `O_RDWR` before the request is even sent — opening a FIFO
/// for writing alone blocks until a reader appears, and `O_RDWR` does not — so
/// the read is parked until this test drops the handle, with no timing in the
/// arrangement at all.
///
/// This test used to pin the opposite, under the name
/// `a_blocked_file_read_holds_the_peer_connection`: the reader awaited
/// `handle_request(..)` inline, so the ping's frame was not even *read* while
/// the file operation was in flight, and the first assertion was that no frame
/// arrived at all before the release. `#961-D` moved `agent.file.read` onto the
/// query lane and the control path into the reader, so what is asserted now is
/// the two halves of that change:
///
/// * the ping is answered while the read is still parked — the reader is not
///   waiting for the query it admitted;
/// * the read's own reply is *not* sent early. It is parked on the FIFO, and
///   that is what makes the first assertion a statement about the read rather
///   than about the ping: an implementation that answered the ping by
///   *cancelling* or *failing* the read would pass the first half and fail
///   here.
///
/// Each reply still carries its own `id`, which is the protocol's answer to
/// "which reply is which" — this test no longer depends on their arrival order
/// for correlation, only for the one thing ordering still means here: the read
/// was still in flight when the pong was written.
#[cfg(unix)]
#[tokio::test]
async fn a_blocked_file_read_no_longer_holds_the_peer_connection() {
    use std::time::Duration;

    let (addr, handle, root, credentials) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let fifo = root.path().join("blocked.fifo");
    make_fifo(&fifo).unwrap();
    let writer = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&fifo)
        .expect("hold the fifo open for writing");

    // The slow request, then a control request behind it — written back to
    // back, with nothing waited on in between.
    let read = new_message(
        msg_types::FILE_READ,
        serde_json::json!({ "path": "blocked.fifo" }),
    );
    let ping = new_message(msg_types::CONTROL_PING, serde_json::json!({}));
    for request in [
        serde_json::to_value(&read).unwrap(),
        serde_json::to_value(&ping).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    let answered_ping = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap()
        .expect("the control path answered while a file request was still running");
    assert_eq!(answered_ping["id"], serde_json::json!(ping.id));
    assert_eq!(
        answered_ping["msg_type"],
        serde_json::json!(msg_types::CONTROL_PONG),
        "the frame behind the read was answered, and it is the pong"
    );

    // The read is still parked, so nothing else can have been written. This is
    // a negative assertion, and it is the one that would catch "concurrency"
    // bought by answering a request the agent has not finished: the FIFO has
    // no end-of-file until the writer below is dropped, and there is no other
    // frame this connection could be carrying (nothing is attached to it).
    let early = next_frame_within(&mut stream, Duration::from_millis(300))
        .await
        .unwrap();
    assert!(
        early.is_none(),
        "the parked read answered before its file did: {early:?}"
    );

    // Release the read: closing the last writer is its end-of-file.
    drop(writer);

    let answered_read = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap()
        .expect("an answer to the file read");
    assert_eq!(answered_read["id"], serde_json::json!(read.id));
    assert_eq!(answered_read["msg_type"], serde_json::json!(msg_types::OK));

    handle.shutdown().await.ok();
}

// ---------------------------------------------------------------------------
// Mutation ordering across connections, and the coarse filesystem key
// (#961 review, findings 1 and 2)
// ---------------------------------------------------------------------------
//
// Three tests, and the arrangement they share is what makes them deterministic
// rather than lucky:
//
// * the park is always *inside the mutation's own key*, so what the second
//   mutation waits for is the ordering and not the backend;
// * the park is opened by a **handshake the test polls for** — an env variable
//   that has landed, a tree that has started to shrink — so "the first mutation
//   is running" is a fact before the second frame is written, and never two
//   sockets racing to be read first;
// * the second mutation's *own reply* is the witness. It cannot arrive while the
//   first holds the key, and the window it is given is several times shorter
//   than the park, so a correct implementation cannot answer it early and a
//   broken one cannot answer it late.

/// One `tmux set-environment` per variable, and the attach that carries them
/// parks inside its own session key for the length of that loop.
///
/// One `tmux` spawn per variable, measured at ~2.5 ms per spawn on the machine
/// this was written on, so 1 500 of them park the key for several seconds — more
/// than an order of magnitude past the window below. What the park needs is the
/// spawns; whether each one also lands is not what it measures, and the count is
/// unchanged either way. (When this was written every one of them failed — the
/// `-e` flag bug of #980, fixed since — which is why the original note here read
/// "the loop fails every call". The session exists, so they succeed now.)
///
/// The park is never waited out: the test that uses it ends the connection that
/// dispatched the work, which is what the queue behind it is released by.
const LONG_PARK_VARS: usize = 1_500;

/// How long a test watches for a reply that must not come.
///
/// Two orders of magnitude longer than the work of a mutation that was *not*
/// queued behind anything — the witness it serves is the absence of an answer
/// that a broken lane produces in well under a millisecond — and an order of
/// magnitude shorter than any park these tests arrange.
const WINDOW: std::time::Duration = std::time::Duration::from_millis(100);

/// An `agent.attach` whose env snapshots park its own key.
fn attach_with_long_park(session_name: &str) -> serde_json::Value {
    let vars: Vec<serde_json::Value> = (0..LONG_PARK_VARS)
        .map(|i| serde_json::json!([format!("NESSION_PARK_{i}"), "1"]))
        .collect();
    serde_json::json!({
        "session_name": session_name,
        "width": 80,
        "height": 24,
        "env_snapshots": [{
            "name": "park",
            "source": "agent",
            "vars": vars,
            "warnings": [],
        }],
    })
}

// What sequences the two peers, and why it is the reader rather than tmux.
//
// The reader itself: it reads frames in order and *awaits* each admission, so a
// query written behind the attach on the first peer's own connection cannot be
// answered until the attach has reached the lane. That reply is the handshake,
// and it is causal — no clock is consulted, and neither socket is racing the
// other.
//
// A handshake read back out of tmux (`show-environment`) was impossible when
// this was written, and that is why it is the reader: `EnvManager::
// set_environment` spawned `set-environment -t <session> -e KEY=VALUE`, and
// `-e` is not a flag that subcommand takes, so no variable it set ever landed.
// That bug is #980 and it is fixed — `set_environment` now passes `name` and
// `value` as separate argv values, and `tests/integration/tmux.rs` reads a
// written variable back out of tmux to prove it. The reader-based handshake is
// kept as it is: it is causal, it does not depend on which of the two mechanisms
// happens to work, and re-sequencing a passing ordering test is not #980's.

/// Fail if the frame with `id` is answered within `window`.
async fn no_answer_within(
    stream: &mut WsStream,
    id: &str,
    window: std::time::Duration,
) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text)?;
                anyhow::ensure!(
                    parsed.get("id").and_then(serde_json::Value::as_str) != Some(id),
                    "a mutation was answered while an earlier mutation of the same \
                     resource was still running: {parsed}"
                );
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => anyhow::bail!("connection closed while checking that {id} went unanswered"),
            Err(_) => return Ok(()),
        }
    }
}

/// The first answer to any of `ids`, whichever arrives — for a connection where
/// the *order* of two replies is the thing under test, and where asserting it
/// needs no clock: a lane that ordered the two would produce them in this order
/// and no lane that did not could.
async fn first_answer(
    stream: &mut WsStream,
    ids: &[&str],
    window: std::time::Duration,
) -> anyhow::Result<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "none of {ids:?} was answered within {window:?}"
        );
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text)?;
                let id = parsed.get("id").and_then(serde_json::Value::as_str);
                if id.is_some_and(|id| ids.contains(&id)) {
                    return Ok(parsed);
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => anyhow::bail!("connection closed while waiting for one of {ids:?}"),
            Err(_) => anyhow::bail!("none of {ids:?} was answered within {window:?}"),
        }
    }
}

/// The answer to `id`, or a failure naming what arrived instead.
async fn answer_for(
    stream: &mut WsStream,
    id: &str,
    window: std::time::Duration,
) -> anyhow::Result<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        anyhow::ensure!(!remaining.is_zero(), "no answer to {id} within {window:?}");
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text)?;
                if parsed.get("id").and_then(serde_json::Value::as_str) == Some(id) {
                    return Ok(parsed);
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => anyhow::bail!("connection closed while waiting for {id}"),
            Err(_) => anyhow::bail!("no answer to {id} within {window:?}"),
        }
    }
}

/// How many entries the delete park's tree holds.
///
/// The park is the delete's own duration, so its size is the test's clock.
/// Measured when this was written: removing 20 000 small files takes ~1.1 s on
/// the machine it was written on, so 30 000 is comfortably over a second — an
/// order of magnitude past the window above, and a slower machine moves the
/// margin the safe way.
///
const PARK_ENTRIES: usize = 30_000;

/// The same, for the test whose witness needs no window.
///
/// [`a_file_mutation_is_ordered_against_every_other_file_mutation`] asserts the
/// *order* of two replies on one stream rather than the absence of one within a
/// window, so its park only has to outlast a rename's own work — microseconds.
/// A smaller tree keeps that test cheap.
const SHORT_PARK_ENTRIES: usize = 4_000;

/// Build the tree a recursive delete parks on, and return its path.
///
/// Empty files, one `write` each. Hard links to one file were tried first and
/// measured *slower* to create (172 µs each against 70 µs on APFS), which is the
/// wrong way for a tree that exists to be built and then removed.
fn make_big_tree(
    root: &std::path::Path,
    name: &str,
    entries: usize,
) -> anyhow::Result<std::path::PathBuf> {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir)?;
    for i in 0..entries {
        std::fs::write(dir.join(format!("entry-{i}")), b"x")?;
    }
    Ok(dir)
}

/// Wait until the recursive delete has begun: entries have started to disappear.
///
/// The same handshake as the env park, for the same reason — the fact is about
/// the agent, and polling for it is what keeps the window below from being a race
/// between two connections.
async fn wait_for_delete_to_start(dir: &std::path::Path, entries: usize) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "the recursive delete never started: {} still has every entry",
            dir.display()
        );
        let remaining = std::fs::read_dir(dir).map(Iterator::count);
        match remaining {
            Ok(n) if n < entries => return Ok(()),
            // Gone entirely is the delete having *finished*, which is past the
            // point this can be observed from.
            Ok(_) => {}
            Err(e) => anyhow::bail!("the tree being deleted became unreadable: {e}"),
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

/// Two peers mutating one session are ordered against each other.
///
/// `#961`'s review, finding 1, on the socket it names second: two peer-to-peer
/// connections mutate one tmux session through two `ExecutionLanes` that used to
/// be two independent maps of queues and workers. What that ordered was `same
/// session + same connection`; what a browser attached to a session another
/// browser is also attached to needs is `same session`.
///
/// The first peer's `attach` is parked inside the session's own key by its env
/// snapshots ([`LONG_PARK_VARS`]), and the second peer's `terminal.input` — for
/// the same session name, on its own connection — must not be answered until
/// that attach is. The handshake is the first environment variable landing, so
/// the ordering is established before the second frame is even written.
#[tokio::test]
async fn two_peers_mutating_one_session_are_ordered() {
    use std::time::Duration;

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let tmux = SessionManager::new();
    let session = TestSession::new("peers");
    let name = session.name().to_string();
    tmux.create_session(&name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Both peers act on the same session, so both present a credential bound to
    // it — on their own connections, since one credential covers one session.
    let (mut sink_a, mut stream_a) = connect_for(&credentials, addr, &name).await.unwrap();
    let (mut sink_b, mut stream_b) = connect_for(&credentials, addr, &name).await.unwrap();

    let attach = new_message(msg_types::CLIENT_ATTACH, attach_with_long_park(&name));
    let probe = new_message(msg_types::SESSION_LIST, serde_json::json!({}));
    let input = new_message(msg_types::TERMINAL_INPUT, one_byte_input(&name));

    // The first peer's attach, and a query behind it on the same connection. The
    // reader dispatches in order and awaits the admission, so the query's reply
    // is proof that the attach is in the lane — see the note above for why the
    // handshake cannot come from tmux.
    for request in [
        serde_json::to_value(&attach).unwrap(),
        serde_json::to_value(&probe).unwrap(),
    ] {
        sink_a
            .send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the first peer");
    }
    let answered_probe = answer_for(&mut stream_a, &probe.id, Duration::from_secs(30))
        .await
        .expect("the first peer's query was never answered");
    assert_eq!(answered_probe["msg_type"], serde_json::json!(msg_types::OK));

    // The second peer, for the same session's key, on its own connection.
    sink_b
        .send(WsMessage::Text(
            serde_json::to_value(&input).unwrap().to_string(),
        ))
        .await
        .expect("send the terminal input");

    // It cannot be answered while the first peer's attach holds the key, and the
    // attach's park is seconds long against this window. A lane per connection
    // answers it in well under a millisecond — the arm is a map lookup — which
    // is what this asserts the absence of.
    no_answer_within(&mut stream_b, &input.id, WINDOW)
        .await
        .unwrap();

    // Then the first peer's connection ends, which ends the work it dispatched,
    // and the queue behind it moves: the second peer's input is admitted and
    // answered. The attach's own reply is deliberately never read — it is the
    // end of a park of several seconds, and this test does not wait for it.
    drop(sink_a);
    drop(stream_a);
    let answered_input = answer_for(&mut stream_b, &input.id, Duration::from_secs(30))
        .await
        .expect("the input was never answered once the attach it queued behind ended");
    assert_eq!(
        answered_input["payload"]["code"],
        serde_json::json!("not_attached"),
        "the input was answered with something other than the second peer's own \
         attachment state: {:?}",
        answered_input["payload"]
    );

    handle.shutdown().await.ok();
}

/// A rename cannot be overtaken by a file mutation read before it.
///
/// `#961`'s review, finding 2: `agent.file.rename` was keyed by `from` and
/// everything else by `path`, so `rename A -> B` and a mutation of `B` were two
/// keys — and even on one connection, where the reader dispatches in order, they
/// ran concurrently. What the key names now is the *filesystem*, one resource for
/// this agent, which is what makes a rename ordered against a write of its
/// destination and a recursive delete ordered against a write of a descendant.
///
/// The park is the delete of a large tree: a file mutation has no gate to hold
/// (the query tests' FIFO trick does not work here — `write_file` writes a temp
/// file and renames it, so a FIFO is replaced rather than blocked on), and a
/// recursive delete's duration is the test's to choose.
///
/// The order asserted is `delete` then `rename` then `write b.txt`, and the last
/// step is what makes the rename's own effect checkable: the write is dispatched
/// last, so a rename that had overtaken it would leave `b.txt` holding the
/// renamed content.
///
/// The witness for the first step needs no clock, and that is why this test is
/// the one that states the ordering rather than the window: both replies arrive
/// on *one* stream, and a rename that was ordered behind the delete it was read
/// behind cannot be answered first. A lane that keyed them by path answers the
/// rename in microseconds and hands this test the rename's answer, whatever the
/// delete takes.
#[tokio::test]
async fn a_file_mutation_is_ordered_against_every_other_file_mutation() {
    use std::time::Duration;

    let (addr, handle, root, credentials) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    make_big_tree(root.path(), "big", SHORT_PARK_ENTRIES).unwrap();
    std::fs::write(root.path().join("a.txt"), b"renamed").unwrap();

    let delete = new_message(
        msg_types::FILE_DELETE,
        serde_json::json!({ "path": "big", "recursive": true }),
    );
    let rename = new_message(
        msg_types::FILE_RENAME,
        serde_json::json!({ "from": "a.txt", "to": "b.txt" }),
    );
    for request in [
        serde_json::to_value(&delete).unwrap(),
        serde_json::to_value(&rename).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    let first = first_answer(
        &mut stream,
        &[&delete.id, &rename.id],
        Duration::from_secs(60),
    )
    .await
    .expect("neither file mutation was answered");
    assert_eq!(
        first["id"],
        serde_json::json!(delete.id),
        "the rename was answered while the delete it was read behind was still running: \
         the two are one resource, so this is a key that is not the filesystem's"
    );
    let answered_delete = first;
    assert_eq!(
        answered_delete["msg_type"],
        serde_json::json!(msg_types::OK),
        "the delete failed: {:?}",
        answered_delete["payload"]
    );
    let answered_rename = answer_for(&mut stream, &rename.id, Duration::from_secs(30))
        .await
        .expect("the rename was never answered");
    assert_eq!(
        answered_rename["msg_type"],
        serde_json::json!(msg_types::OK),
        "the rename failed: {:?}",
        answered_rename["payload"]
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("b.txt")).unwrap(),
        "renamed"
    );
    assert!(
        !root.path().join("a.txt").exists(),
        "the rename left its source behind"
    );

    // And the other direction: the write was dispatched last, so its content is
    // what `b.txt` ends up holding.
    let write = new_message(
        msg_types::FILE_WRITE,
        serde_json::json!({ "path": "b.txt", "content": write_content("written") }),
    );
    sink.send(WsMessage::Text(
        serde_json::to_value(&write).unwrap().to_string(),
    ))
    .await
    .expect("send the write");
    let answered_write = answer_for(&mut stream, &write.id, Duration::from_secs(30))
        .await
        .expect("the write was never answered");
    assert_eq!(answered_write["msg_type"], serde_json::json!(msg_types::OK));
    assert_eq!(
        std::fs::read_to_string(root.path().join("b.txt")).unwrap(),
        "written",
        "a write dispatched after the rename was applied before it"
    );

    handle.shutdown().await.ok();
}

/// Base64 content for a `file.write`.
fn write_content(text: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
}

/// Two peers mutating one file are ordered against each other.
///
/// Finding 1 again, for the filesystem: two connections, one resource, and a
/// *descendant* of the path the first peer is removing — the case finding 2
/// names, where an exact-path key cannot express that the second mutation is
/// inside the first one's scope.
///
/// The handshake is the tree starting to shrink, and it is what makes this a
/// statement about the shared key rather than about which connection's reader
/// happened to run first.
#[tokio::test]
async fn two_peers_mutating_one_file_are_ordered() {
    use std::time::Duration;

    let (addr, handle, root, credentials) = start_server_with_file_root().await.unwrap();
    let (mut sink_a, mut stream_a) = connect(&credentials, addr).await.unwrap();
    let (mut sink_b, mut stream_b) = connect(&credentials, addr).await.unwrap();

    let big = make_big_tree(root.path(), "big", PARK_ENTRIES).unwrap();

    let delete = new_message(
        msg_types::FILE_DELETE,
        serde_json::json!({ "path": "big", "recursive": true }),
    );
    let write = new_message(
        msg_types::FILE_WRITE,
        serde_json::json!({ "path": "big/inside.txt", "content": write_content("written") }),
    );

    let sent = std::time::Instant::now();
    sink_a
        .send(WsMessage::Text(
            serde_json::to_value(&delete).unwrap().to_string(),
        ))
        .await
        .expect("send the delete");
    wait_for_delete_to_start(&big, PARK_ENTRIES)
        .await
        .expect("the delete never started");

    sink_b
        .send(WsMessage::Text(
            serde_json::to_value(&write).unwrap().to_string(),
        ))
        .await
        .expect("send the write");

    // A write into a tree that is being removed: with one key for the sandbox it
    // is queued behind the delete, and with a key per path it is a different
    // resource and runs straight into the removal.
    no_answer_within(&mut stream_b, &write.id, WINDOW)
        .await
        .unwrap();

    let answered_delete = answer_for(&mut stream_a, &delete.id, Duration::from_secs(60))
        .await
        .expect("the delete was never answered");
    // The window above is only an assertion if the park outlasts it, so the park
    // is measured rather than assumed: the second peer's frame was written once
    // the handshake showed the delete had begun, and this is the park that frame
    // was queued behind.
    let parked = sent.elapsed();
    assert!(
        parked > WINDOW,
        "the delete held its key for {parked:?}, which is not longer than the {WINDOW:?} \
         window the ordering above was asserted over"
    );
    assert_eq!(
        answered_delete["msg_type"],
        serde_json::json!(msg_types::OK)
    );
    let answered_write = answer_for(&mut stream_b, &write.id, Duration::from_secs(60))
        .await
        .expect("the write was never answered");
    assert_eq!(
        answered_write["msg_type"],
        serde_json::json!(msg_types::OK),
        "the write failed: {:?}",
        answered_write["payload"]
    );

    // Applied in that order: the write recreated the directory the delete had
    // removed, so the file is there and it is the second mutation's content.
    assert_eq!(
        std::fs::read_to_string(root.path().join("big/inside.txt")).unwrap(),
        "written"
    );

    handle.shutdown().await.ok();
}

/// A peer naming many distinct sessions gets a worker for a bounded number of
/// them.
///
/// `#961`'s review, finding 3, on the socket it names first: `ExecutionLanes`
/// was built with the no-budget constructor, so a peer naming a thousand sessions
/// had a thousand keys, a thousand queues and a thousand workers — each one
/// inside its own depth. The bound tests repeat work for one key; this is the
/// flood.
///
/// Each create parks inside its own key on [`LONG_PARK_VARS`] environment
/// variables *after* creating its session, so a session that exists in tmux is a
/// mutation that was admitted — which is what the count below reads. The flood
/// is larger than the bound, so a runtime without one shows every session.
#[tokio::test]
async fn a_peer_naming_many_sessions_gets_workers_for_a_bounded_number_of_them() {
    use std::time::Duration;

    const FLOOD: usize = 48;
    const PARK_VARS: usize = 400;

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let (mut sink, _stream) = connect(&credentials, addr).await.unwrap();
    let tmux = SessionManager::new();
    let prefix = unique_session_name("flood");

    let vars: Vec<serde_json::Value> = (0..PARK_VARS)
        .map(|i| serde_json::json!([format!("NESSION_FLOOD_{i}"), "1"]))
        .collect();
    for n in 0..FLOOD {
        let create = new_message(
            msg_types::SESSION_CREATE,
            serde_json::json!({
                "name": format!("{prefix}-{n}"),
                "width": 80,
                "height": 24,
                "env_snapshots": [{
                    "name": "park",
                    "source": "agent",
                    "vars": vars,
                    "warnings": [],
                }],
            }),
        );
        sink.send(WsMessage::Text(
            serde_json::to_value(&create).unwrap().to_string(),
        ))
        .await
        .expect("send the create");
    }

    // Long enough for every admitted mutation to have created its session (the
    // create comes first, the park second) and far shorter than the park, so the
    // count below is the bound rather than the rate.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let bound = nession_agent::server::execution::DEFAULT_MUTATIONS_IN_FLIGHT;
    let created = tmux
        .list_sessions()
        .await
        .expect("list the flood's sessions")
        .into_iter()
        .filter(|session| session.name.starts_with(&prefix))
        .count();

    assert!(
        created < FLOOD,
        "a peer naming {FLOOD} distinct sessions had a worker for every one of them: the \
         tasks in flight track the number of keys, which is the unbounded unique-key \
         growth this bound exists for"
    );
    assert!(
        created <= bound,
        "the flood was admitted for {created} sessions, past this connection's bound of \
         {bound}"
    );
    assert!(
        created > 0,
        "not one of the flood's sessions was created: nothing was measured"
    );

    handle.shutdown().await.ok();
}

/// Two parked queries overlap: the second finishes while the first is still
/// running.
///
/// The witness is causal rather than temporal. Query B's reply can only be
/// written after B's FIFO is released, and A's is released after that — so an
/// implementation that ran B behind A (the reader awaiting each handler, or one
/// worker for the whole lane) could not produce B's reply at all, and this test
/// fails on the first assertion rather than on a stopwatch. Both FIFOs are
/// parked the race-free way: neither has a writer until the test releases it
/// (see [`release_parked_fifo`]).
#[cfg(unix)]
#[tokio::test]
async fn independent_queries_overlap_execution() {
    use std::time::Duration;

    let (addr, handle, root, credentials) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    // Guards, not bare paths: the release below has to happen even when an
    // assertion or an expired window takes the test off its happy path — see
    // [`ParkedFifo`] for what skipping it costs.
    let mut first_park = ParkedFifo::new(root.path().join("first.fifo")).unwrap();
    let mut second_park = ParkedFifo::new(root.path().join("second.fifo")).unwrap();

    let first = new_message(
        msg_types::FILE_READ,
        serde_json::json!({ "path": "first.fifo" }),
    );
    let second = new_message(
        msg_types::FILE_READ,
        serde_json::json!({ "path": "second.fifo" }),
    );
    for request in [
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&second).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    // Release only the second, and read: the reply that arrives now can only
    // be its, because the first read is parked on a FIFO with no writer.
    //
    // The first is released *before* the assertions below, and that ordering
    // keeps this test's failure mode a failure — but the ordering alone was not
    // enough: `next_frame_within` can itself expire, and the `unwrap` after it
    // then skipped the release entirely. The guards make that unreachable
    // (#1022); releasing here is about the *order* the two parks finish in.
    second_park.release();
    let answered = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap();
    first_park.release();

    let answered = answered.expect("the second query never ran while the first was parked");
    assert_eq!(
        answered["id"],
        serde_json::json!(second.id),
        "the frame that arrived is not the second query's answer"
    );

    let answered_first = next_frame_within(&mut stream, Duration::from_secs(30))
        .await
        .unwrap()
        .expect("an answer to the first file read");
    assert_eq!(answered_first["id"], serde_json::json!(first.id));

    handle.shutdown().await.ok();
}

/// An identity transition is applied after everything read before it.
///
/// `client.auth` is this socket's one `Ordered` frame — it establishes the
/// connection's identity, and a frame written after it is entitled to be served
/// by that identity rather than by whatever the connection was before. The
/// barrier is what makes that true on a connection that is no longer serial, and
/// it is what this asserts: the auth's reply cannot be written while a query
/// read before it is still in flight.
///
/// The parked query is a FIFO read, so the window is the test's to close. Both
/// orderings are asserted: nothing answers for as long as the read is parked,
/// and then the read's reply comes before the auth's.
#[cfg(unix)]
#[tokio::test]
async fn an_identity_transition_waits_for_the_frames_read_before_it() {
    use std::time::Duration;

    let (addr, handle, root, credentials) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let mut park = ParkedFifo::new(root.path().join("auth.fifo")).unwrap();
    let read = new_message(
        msg_types::FILE_READ,
        serde_json::json!({ "path": "auth.fifo" }),
    );
    let auth = new_message(
        msg_types::CLIENT_AUTH,
        serde_json::json!({ "auth_token": "tok" }),
    );
    for request in [
        serde_json::to_value(&read).unwrap(),
        serde_json::to_value(&auth).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    // The query is parked, and the auth is behind the barrier that waits for it.
    let early = next_frame_within(&mut stream, Duration::from_millis(300))
        .await
        .unwrap();
    // Released before the assertion, as in the overlap test — and now also by
    // the guard if anything above panics, so the "hung test binary instead of a
    // reported one" this comment used to describe cannot come back (#1022). The
    // explicit call is still here because it sets the *order*: the read has to
    // finish before the reply after it can be judged.
    park.release();
    assert!(
        early.is_none(),
        "the identity transition was applied while a frame read before it was \
         still running: {early:?}"
    );

    let answered_read = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap()
        .expect("an answer to the file read");
    assert_eq!(answered_read["id"], serde_json::json!(read.id));

    let answered_auth = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap()
        .expect("an answer to the auth");
    assert_eq!(answered_auth["id"], serde_json::json!(auth.id));
    assert_eq!(
        answered_auth["payload"]["status"],
        serde_json::json!("success")
    );

    handle.shutdown().await.ok();
}

/// How many environment variables the ordering tests' attach applies before it
/// registers the session.
///
/// Each one is a `tmux set-environment` subprocess, and the loop that runs them
/// is inside the attach *arm* — so this is a park inside the attach's own
/// resource key, not a pause in front of it. The frame these tests read behind
/// that attach is answered in microseconds (a map lookup), so the window is
/// three orders of magnitude wide rather than a scheduling accident.
///
/// It is a park and not an assertion: what the tests assert is which reply
/// carries which `id`, and a reply's `id` does not depend on how long its
/// predecessor took. This only decides how wide the window is that the ordering
/// is observed across.
const ORDERING_PARK_VARS: usize = 20;

/// An `agent.attach` payload whose arm will be slow, for the ordering tests.
///
/// Built as JSON rather than as `ClientAttachPayload` because the env snapshots
/// are the point and `EnvSnapshot` carries a `source` discriminant that this
/// test has no opinion about; the wire is the contract, and it is what the
/// agent parses.
fn attach_parked(session_name: &str) -> serde_json::Value {
    let vars: Vec<serde_json::Value> = (0..ORDERING_PARK_VARS)
        .map(|i| serde_json::json!([format!("NESSION_PARK_{i}"), "1"]))
        .collect();
    serde_json::json!({
        "session_name": session_name,
        "width": 80,
        "height": 24,
        "env_snapshots": [{
            "name": "park",
            "source": "agent",
            "vars": vars,
            "warnings": [],
        }],
    })
}

/// A `terminal.input` payload carrying one byte.
fn one_byte_input(session_name: &str) -> serde_json::Value {
    use base64::Engine;
    serde_json::json!({
        "session_name": session_name,
        "data": base64::engine::general_purpose::STANDARD.encode(b"x"),
    })
}

/// Frames for one session are applied in the order they were read, even when
/// the earlier one is slow.
///
/// The witness is the second frame's *answer*: `terminal.input` on a session
/// whose attach has not finished can only be `not_attached`, so an `ok` is
/// possible only if the attach was applied first. The attach is held inside its
/// own arm for the length of [`ORDERING_PARK_VARS`] subprocess spawns, which is
/// what makes the losing side of an unordered dispatch lose every time rather
/// than most of the time.
#[cfg(unix)]
#[tokio::test]
async fn a_sessions_frames_are_applied_in_order() {
    use std::time::Duration;

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let tmux = SessionManager::new();
    let session = TestSession::new("ordered");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
        .await
        .unwrap();
    let attach = new_message(msg_types::CLIENT_ATTACH, attach_parked(&session_name));
    let input = new_message(msg_types::TERMINAL_INPUT, one_byte_input(&session_name));
    for request in [
        serde_json::to_value(&attach).unwrap(),
        serde_json::to_value(&input).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    let answered_attach = next_answer_within(&mut stream, Duration::from_secs(30))
        .await
        .unwrap()
        .expect("an answer to the attach");
    assert_eq!(
        answered_attach["id"],
        serde_json::json!(attach.id),
        "the input was answered before the attach it was read behind"
    );

    let answered_input = next_answer_within(&mut stream, Duration::from_secs(30))
        .await
        .unwrap()
        .expect("an answer to the terminal input");
    assert_eq!(answered_input["id"], serde_json::json!(input.id));
    assert_eq!(
        answered_input["msg_type"],
        serde_json::json!(msg_types::OK),
        "the input was applied before the attach that creates the attachment: \
         {:?}",
        answered_input["payload"]
    );

    handle.shutdown().await.ok();
}

/// A slow mutation of one session does not delay another session's frames.
///
/// Session A's attach is parked inside its own arm; session B's input is
/// answered immediately — `not_attached`, since B has nothing attached. The
/// assertion is the *order* of the two replies, which is the whole of "per
/// resource key": B's work is not queued behind A's, because A's key is not
/// B's. A lane with one queue for every session answers A first, every time.
#[cfg(unix)]
#[tokio::test]
async fn a_slow_sessions_mutation_does_not_delay_another_sessions_frame() {
    use std::time::Duration;

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let tmux = SessionManager::new();
    let slow = TestSession::new("keyslow");
    let slow_name = slow.name().to_string();
    tmux.create_session(&slow_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // One connection naming **two** sessions, which no browser-shaped credential
    // can present: its terminal binding holds one name and the scope gate
    // compares names (#1013). The credential that can is the node-wide one —
    // `CredentialScope::for_standalone`, the shape an agent with no Server
    // honours — and using it here is what lets this test keep asserting the
    // per-key lanes rather than what it can reach. Every other dial in this file
    // is session-bound ([`connect_for`]).
    let (mut sink, mut stream) = connect_all_sessions(&credentials, addr).await.unwrap();
    let attach = new_message(msg_types::CLIENT_ATTACH, attach_parked(&slow_name));
    // A session that is attached to nothing: its `not_attached` is built from
    // the map alone, so it answers as soon as the reader hands it over.
    let other_input = new_message(
        msg_types::TERMINAL_INPUT,
        one_byte_input("nession-test-keyslow-other"),
    );
    for request in [
        serde_json::to_value(&attach).unwrap(),
        serde_json::to_value(&other_input).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    let first = next_answer_within(&mut stream, Duration::from_secs(30))
        .await
        .unwrap()
        .expect("an answer to the second session's input");
    assert_eq!(
        first["id"],
        serde_json::json!(other_input.id),
        "the other session's frame waited on this session's attach"
    );
    assert_eq!(first["payload"]["code"], serde_json::json!("not_attached"));

    let second = next_answer_within(&mut stream, Duration::from_secs(30))
        .await
        .unwrap()
        .expect("an answer to the attach");
    assert_eq!(second["id"], serde_json::json!(attach.id));

    handle.shutdown().await.ok();
}

// ── Sequenced input delivery (#1307) ────────────────────────────────────────
//
// The four tests below are the deterministic half of the requirement's P2P
// fault injection. They drive the real socket against a real tmux session, and
// they keep every assertion off the output stream: what a shell *prints* is
// timing, and what a shell *did* is a file. So each test writes to a witness
// file and reads it from this process, which makes "the bytes reached the PTY
// once" a fact this process can check rather than a fact it has to wait for.

/// One dialed, attached session, and the witnesses a test reads it by.
struct SequencedSession {
    sink: WsSink,
    stream: WsStream,
    session_name: String,
    epoch: u64,
    /// The lease generation this attach was told, which is the one a client
    /// that later goes stale is still holding.
    control_generation: u64,
    /// Kept so a second client can be dialled onto the same session, which is
    /// the only way to make one an observer: the lease goes to whoever attaches
    /// first, so a peer needs a peer.
    addr: SocketAddr,
    credentials: Arc<P2pCredentials>,
    /// The file the session's shell appends to, and the only thing these tests
    /// assert on that the PTY produced.
    witness: std::path::PathBuf,
    handle: nession_agent::server::ServerHandle,
    /// Held for the test's lifetime, and that is load-bearing rather than
    /// tidiness: `TestSession`'s `Drop` kills the tmux session, so one dropped
    /// when this helper returns leaves the PTY master with no slave and every
    /// later `write_input` fails with `EIO` — a failure that names the errno
    /// and nothing about the cause.
    _session: TestSession,
    /// The witness lives here, so it is removed when the test ends.
    _dir: tempfile::TempDir,
}

impl SequencedSession {
    /// Attach to a fresh local session and state its starting cursor.
    async fn start(prefix: &str) -> anyhow::Result<Self> {
        let (addr, handle, credentials) = start_server(0).await?;
        let tmux = SessionManager::new();
        let session = TestSession::new(prefix);
        let session_name = session.name().to_string();
        tmux.create_session(&session_name, 80, 24, "/tmp", &[])
            .await?;
        let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name).await?;
        authenticate(
            &mut sink,
            &mut stream,
            &format!("{session_name}-controller"),
        )
        .await?;
        let reply: nession_agent::server::websocket::Message<ClientAttachResponse> =
            round_trip(&mut sink, &mut stream, &attach_to(&session_name)).await?;
        let epoch = reply.payload.input_epoch.ok_or_else(|| {
            anyhow::anyhow!("a fresh attach must state the input epoch it is starting from")
        })?;
        assert_eq!(
            reply.payload.input_applied_through,
            Some(0),
            "a fresh session's input cursor starts at zero"
        );
        let dir = tempfile::tempdir()?;
        let witness = dir.path().join("witness");
        Ok(Self {
            sink,
            stream,
            session_name,
            epoch,
            control_generation: reply.payload.control_generation.ok_or_else(|| {
                anyhow::anyhow!("an attach must state the lease generation it is granting")
            })?,
            addr,
            credentials,
            witness,
            handle,
            _session: session,
            _dir: dir,
        })
    }

    /// A second, distinctly-named connection to this session, not yet attached.
    ///
    /// The first connection stays open, so the lease it took stays taken and
    /// whoever dials here is an observer — provided it is a different client,
    /// which is what the name is for.
    async fn dial(&self) -> anyhow::Result<(WsSink, WsStream)> {
        let (mut sink, mut stream) =
            connect_for(&self.credentials, self.addr, &self.session_name).await?;
        authenticate(
            &mut sink,
            &mut stream,
            &format!("{}-observer", self.session_name),
        )
        .await?;
        Ok((sink, stream))
    }

    /// The command that appends `line` to the witness file.
    fn append(&self, line: &str) -> String {
        format!("echo {line} >> {}\n", self.witness.display())
    }

    /// Send one sequenced frame and return the acknowledgement it earns.
    ///
    /// The acknowledgement and the envelope's `ok` are two frames for one
    /// request, and this reads the acknowledgement. The reply is left in the
    /// stream: these tests never call `round_trip` on the same frame, and a
    /// helper that consumed it would have to know which of the two frames the
    /// caller meant.
    async fn send(
        &mut self,
        epoch: u64,
        seq_start: u64,
        seq_end: u64,
        data: &str,
    ) -> anyhow::Result<nession_agent::server::websocket::TerminalInputAckPayload> {
        use base64::Engine;
        let payload = nession_agent::server::websocket::TerminalInputPayload {
            session_name: self.session_name.clone(),
            data: base64::engine::general_purpose::STANDARD.encode(data.as_bytes()),
            control_generation: None,
            input_epoch: Some(epoch),
            seq_start: Some(seq_start),
            seq_end: Some(seq_end),
        };
        let req = new_message(msg_types::TERMINAL_INPUT, payload);
        self.sink
            .send(WsMessage::Text(serde_json::to_string(&req)?))
            .await?;
        read_input_ack(&mut self.stream).await
    }

    /// Read the witness file, waiting briefly for the shell to have run the
    /// commands that write it.
    ///
    /// `expected` is the number of lines the test is waiting for, and the wait
    /// is bounded: a command that never runs must fail the assertion that
    /// follows rather than hang the run. On the deadline the current contents
    /// are returned, and the caller's assertion is what says what was missing.
    async fn witness_lines(&self, expected: usize) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let contents = std::fs::read_to_string(&self.witness).unwrap_or_default();
            if contents.lines().count() >= expected || tokio::time::Instant::now() >= deadline {
                return contents;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// Name this connection, before it attaches.
///
/// A connection that never authenticates is `unknown-client`, and two of those
/// are the *same client* as far as the lease is concerned — so a second dial
/// would silently hold the first one's lease and every observer test would pass
/// by being the wrong test. Naming each dial is what makes "two clients" true.
async fn authenticate(
    sink: &mut WsSink,
    stream: &mut WsStream,
    client_id: &str,
) -> anyhow::Result<()> {
    let req = new_message(
        msg_types::CLIENT_AUTH,
        ClientAuthPayload {
            auth_token: String::new(),
            client_id: Some(client_id.to_string()),
        },
    );
    let reply: nession_agent::server::websocket::Message<AuthResponsePayload> =
        round_trip(sink, stream, &req).await?;
    anyhow::ensure!(
        reply.payload.client_id.as_deref() == Some(client_id),
        "the agent assigned a different client id than the one presented"
    );
    Ok(())
}

/// The attach frame every test in this section opens with.
fn attach_to(session_name: &str) -> nession_agent::server::websocket::Message<ClientAttachPayload> {
    new_message(
        msg_types::CLIENT_ATTACH,
        ClientAttachPayload {
            session_name: session_name.to_string(),
            width: 80,
            height: 24,
            // The size is meant, so it is authoritative (#1265).
            size_known: None,
            env_snapshots: Vec::new(),
            needs_bootstrap: None,
        },
    )
}

/// The next input acknowledgement, skipping everything else on the wire.
///
/// Skips rather than asserts, because the frames in between are the session's
/// output and the number of them is the shell's business: a test that pinned
/// "the very next frame is the acknowledgement" would be asserting that the PTY
/// says nothing between a keystroke and its receipt.
async fn read_input_ack(
    stream: &mut WsStream,
) -> anyhow::Result<nession_agent::server::websocket::TerminalInputAckPayload> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "no input acknowledgement arrived within the deadline"
        );
        let frame = tokio::time::timeout(remaining, stream.next())
            .await
            .map_err(|_| anyhow::anyhow!("no input acknowledgement arrived within the deadline"))?
            .ok_or_else(|| anyhow::anyhow!("the agent closed before acknowledging"))??;
        let WsMessage::Text(text) = frame else {
            continue;
        };
        let raw: serde_json::Value = serde_json::from_str(&text)?;
        if raw.get("msg_type").and_then(|v| v.as_str()) == Some(msg_types::TERMINAL_INPUT_ACK) {
            return Ok(serde_json::from_value(
                raw.get("payload").cloned().unwrap_or_default(),
            )?);
        }
    }
}

/// The cursor a client is told on attach is the reconcile, and it is the same
/// cursor the acknowledgements advance (SC-01, SC-02, SC-04).
///
/// The mutation this pins is `input_applied_through: None` on the attach reply
/// — or dropping the input state from `client_attach_response` entirely. A
/// reattaching client would then be told nothing about the input it had in
/// flight and would have no cursor to resume from, which is the state the
/// requirement's reconnect clause exists to remove.
#[tokio::test]
async fn integration_input_ack_reconciles_on_reattach() {
    let mut session = SequencedSession::start("input-reconcile").await.unwrap();
    let epoch = session.epoch;
    let command = session.append("reconcile");

    let ack = session.send(epoch, 1, 1, &command).await.unwrap();
    assert_eq!(ack.input_epoch, epoch);
    assert_eq!(ack.applied_through, 1);
    assert_eq!(
        session.witness_lines(1).await,
        "reconcile\n",
        "the acknowledged chunk never reached the shell"
    );

    // Re-attach on the same socket — the shape a client takes after its
    // transport is rebuilt, and the same path a fresh page takes onto a live
    // session.
    let reply: nession_agent::server::websocket::Message<ClientAttachResponse> = round_trip(
        &mut session.sink,
        &mut session.stream,
        &attach_to(&session.session_name),
    )
    .await
    .unwrap();
    assert_eq!(
        reply.payload.input_epoch,
        Some(epoch),
        "the session kept its identity, so the epoch must not have moved"
    );
    assert_eq!(
        reply.payload.input_applied_through,
        Some(1),
        "the reattach must state how far the input it never saw acknowledged got"
    );

    session.handle.shutdown().await.ok();
}

/// A retry of input the cursor already covers writes nothing, and still tells
/// the sender where it stands (SC-03).
///
/// This is the requirement's named failure — `write PTY / ACK lost / reconnect
/// / retry / PTY receives the bytes twice` — reproduced in both shapes a retry
/// actually takes, because they are caught by *different* guards and a test
/// that only did the first would pass with the second's guard removed.
///
/// * An **exact** retry: the sender had one chunk in flight and re-sends it
///   unchanged. The cursor already covers it, so `Duplicate` refuses it.
/// * A **straddle**: the sender had a batch in flight, the acknowledgement for
///   part of it was lost, and it therefore re-sends the whole batch — the bytes
///   of chunks it has already been credited for, plus the ones it has not. The
///   range begins at or below the cursor and ends above it, which is `Gap`
///   rather than `Duplicate`, and refusing it is what keeps the applied prefix
///   out of the PTY a second time. This is the shape the requirement is about:
///   a client that only ever retried exactly what was lost would not need a
///   sequence at all.
///
/// The witness is the file. `one` appears twice only if a retry was written.
///
/// The mutation is disabling the contiguity check in `classify`, which is the
/// guard the straddle depends on. The witness then reads `one\none\ntwo\n`.
#[tokio::test]
async fn integration_a_retried_input_frame_is_not_written_twice() {
    let mut session = SequencedSession::start("input-dedupe").await.unwrap();
    let epoch = session.epoch;
    let command = session.append("one");

    let first = session.send(epoch, 1, 1, &command).await.unwrap();
    assert_eq!(first.applied_through, 1);
    assert_eq!(session.witness_lines(1).await, "one\n");

    // The exact retry: the acknowledgement was lost, so the sender does the
    // only thing it can and sends the same chunk again.
    let retry = session.send(epoch, 1, 1, &command).await.unwrap();
    assert_eq!(
        retry.applied_through, 1,
        "a duplicate must restate the cursor rather than advance it"
    );

    // The straddle: the sender believed chunks 1 and 2 were both unapplied, so
    // its retry carries both — the already-applied `one` and the new `two`.
    let second_command = session.append("two");
    let straddle = format!("{command}{second_command}");
    let refused = session.send(epoch, 1, 2, &straddle).await.unwrap();
    assert_eq!(
        refused.applied_through, 1,
        "a batch that re-covers applied input must be refused, not written"
    );

    // The sender resumes from the cursor it was given, and only chunk 2 is new.
    let second = session.send(epoch, 2, 2, &second_command).await.unwrap();
    assert_eq!(second.applied_through, 2);

    // **One read, and it is the witness for all three.** The two retries are
    // asserted by what they left behind rather than by a read of their own,
    // and that is deliberate rather than thrifty: a read taken right after a
    // refused frame would be racing the shell, which runs a command some
    // milliseconds after the byte arrives, so "the file does not have it yet"
    // is not "it was never written". Reading after the *next* chunk has been
    // applied is the sound version of the same question — the key lane orders
    // the frames, so anything a retry wrote is in the file before `two` is —
    // and it is why the final expectation is an exact contents rather than a
    // line count: `one\none\ntwo\n` is what a written retry leaves, and it
    // reaches two lines exactly as `one\ntwo\n` does.
    assert_eq!(
        session.witness_lines(2).await,
        "one\ntwo\n",
        "a retried chunk reached the PTY a second time"
    );

    session.handle.shutdown().await.ok();
}

/// A frame that does not continue the cursor is refused, and so is one from
/// another epoch — and neither writes (SC-01, SC-09).
///
/// Both negatives are proved by a *later positive*: the refused commands and
/// the accepted commands write the same witness file, so a refused frame that
/// had been written leaves its line in the file twice. Ordering is what makes
/// that sound — the key lane runs one session's input frames one at a time, in
/// arrival order, so the accepted write cannot overtake a refused one.
///
/// The mutations are `Gap` and `StaleEpoch` falling through to `Apply`.
#[tokio::test]
async fn integration_a_gap_and_a_stale_epoch_are_refused_without_writing() {
    let mut session = SequencedSession::start("input-refusal").await.unwrap();
    let epoch = session.epoch;

    session
        .send(epoch, 1, 1, &session.append("first"))
        .await
        .unwrap();
    assert_eq!(session.witness_lines(1).await, "first\n");

    // A hole: the cursor is at 1 and this frame claims to be chunk 3. Writing
    // it would apply the user's later input before the input that was lost.
    let gap_command = session.append("gapped");
    let gap = session.send(epoch, 3, 3, &gap_command).await.unwrap();
    assert_eq!(
        gap.applied_through, 1,
        "a refused frame must leave the cursor where the sender can resume from"
    );

    // An epoch from another agent process: the same check, a different reason.
    let stale = session
        .send(epoch + 1, 2, 2, &session.append("stale"))
        .await
        .unwrap();
    assert_eq!(
        stale.input_epoch, epoch,
        "the refusal names the live epoch, which is what tells the sender its own is gone"
    );
    assert_eq!(stale.applied_through, 1);

    // The chunk that *does* continue the cursor, carrying the same command the
    // gap frame carried. If the gap had written, the file would hold `gapped`
    // twice.
    let accepted = session.send(epoch, 2, 2, &gap_command).await.unwrap();
    assert_eq!(accepted.applied_through, 2);
    assert_eq!(
        session.witness_lines(2).await,
        "first\ngapped\n",
        "a refused frame's bytes reached the PTY"
    );

    session.handle.shutdown().await.ok();
}

/// An unsequenced sender keeps working, and moves no cursor (compatibility).
///
/// The mutation is treating an absent sequence as a gap: every client written
/// before this contract existed would stop being able to type, and a paste from
/// an old build would be dropped with nothing said.
#[tokio::test]
async fn integration_an_unsequenced_sender_still_writes() {
    let mut session = SequencedSession::start("input-legacy").await.unwrap();
    let epoch = session.epoch;

    use base64::Engine;
    let legacy = new_message(
        msg_types::TERMINAL_INPUT,
        nession_agent::server::websocket::TerminalInputPayload {
            session_name: session.session_name.clone(),
            data: base64::engine::general_purpose::STANDARD
                .encode(session.append("legacy").as_bytes()),
            control_generation: None,
            input_epoch: None,
            seq_start: None,
            seq_end: None,
        },
    );
    let reply: nession_agent::server::websocket::Message<OkPayload> =
        round_trip(&mut session.sink, &mut session.stream, &legacy)
            .await
            .unwrap();
    assert_eq!(reply.msg_type, msg_types::OK);
    assert_eq!(
        session.witness_lines(1).await,
        "legacy\n",
        "an unsequenced sender's bytes must still reach the PTY"
    );

    // And a sequenced frame after it still starts from the cursor the legacy
    // frame did not move.
    let ack = session
        .send(epoch, 1, 1, &session.append("sequenced"))
        .await
        .unwrap();
    assert_eq!(ack.applied_through, 1);

    session.handle.shutdown().await.ok();
}

/// A second P2P browser is an Observer of the first browser's Agent-wide
/// lease, not the Controller of another per-WebSocket SessionMap (#1213 SC-11).
///
/// The first connection is already attached through SequencedSession::start.
/// Its real tmux backend, control generation and stream epoch are shared by
/// the second dial; two independent Controllers would break single-writer safety.
#[tokio::test]
async fn integration_second_dial_observes_shared_session_lease() {
    let session = SequencedSession::start("second-dial").await.unwrap();
    let (mut sink, mut stream) = session.dial().await.unwrap();
    let reply: nession_agent::server::websocket::Message<ClientAttachResponse> =
        round_trip(&mut sink, &mut stream, &attach_to(&session.session_name))
            .await
            .unwrap();
    assert_eq!(
        reply.payload.control_role.as_deref(),
        Some("observer"),
        "a second physical P2P connection must not mint a second Controller"
    );
    assert_eq!(
        reply.payload.control_generation,
        Some(session.control_generation)
    );
    // `SequencedSession::epoch` is the *input* epoch, not stream_epoch.
    // Comparing those independent namespaces would reject valid streams.
    // The two-socket Agent test checks stream epochs against each other.
    session.handle.shutdown().await.ok();
}

/// Input carrying a lease the agent has moved past is refused, and never
/// reaches the PTY (SC-10).
///
/// `authorize_mutation` on the `agent.terminal.input` arm is the one guard in
/// this tree a client cannot decline to run: it lives in the process that owns
/// the PTY, so a client whose queue never learned the lease moved — or whose
/// transport replayed what it was holding — is refused rather than obeyed. It
/// had no test at all before this one.
///
/// The Agent-scoped SessionMap now makes every P2P connection share one
/// ownership generation. This test proves a stale generation is refused by
/// the Agent's authoritative input guard, not merely hidden in UI.
///
/// The refusal is asserted **by name**. A silently dropped frame and a refused
/// one look identical to the sender, and the difference is the whole of the
/// client's recovery: `not_controller` is what tells it to stop retrying.
///
/// The witness is the file, so "the bytes never reached the PTY" is a fact this
/// process reads rather than a frame it trusts — and the same command under the
/// generation the agent *is* on follows, so an empty witness is a refusal
/// rather than a session where nothing could be written at all.
///
/// The mutation is removing the `authorize_mutation` check from the
/// `agent.terminal.input` arm: the witness then reads `stale\ncurrent\n`.
#[tokio::test]
async fn integration_input_from_a_stale_lease_is_refused_without_writing() {
    let mut session = SequencedSession::start("input-stale-lease").await.unwrap();
    let epoch = session.epoch;
    let held = session.control_generation;

    // The lease moves on without this client: another client takes it, or this
    // one hands it back and takes it again. Either way the generation the
    // client is holding is no longer the one the agent is on.
    let acquired: nession_agent::server::websocket::Message<
        nession_agent::server::websocket::TerminalControlAcquireResponse,
    > = round_trip(
        &mut session.sink,
        &mut session.stream,
        &new_message(
            msg_types::TERMINAL_CONTROL_ACQUIRE,
            nession_agent::server::websocket::TerminalControlAcquirePayload {
                session_name: session.session_name.clone(),
            },
        ),
    )
    .await
    .unwrap();
    assert!(
        acquired.payload.generation > held,
        "the acquire must move the lease past the generation the client holds"
    );

    use base64::Engine;
    let stale = new_message(
        msg_types::TERMINAL_INPUT,
        nession_agent::server::websocket::TerminalInputPayload {
            session_name: session.session_name.clone(),
            data: base64::engine::general_purpose::STANDARD
                .encode(session.append("stale").as_bytes()),
            control_generation: Some(held),
            input_epoch: Some(epoch),
            seq_start: Some(1),
            seq_end: Some(1),
        },
    );
    let refused: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut session.sink, &mut session.stream, &stale)
            .await
            .unwrap();
    assert_eq!(refused.msg_type, msg_types::ERROR);
    assert_eq!(
        refused.payload["code"], "not_controller",
        "the refusal must name the lease, not the session"
    );

    // The same command under the generation the agent is actually on, so the
    // assertion below is about the refusal rather than about a frame that could
    // never have been written. The refused frame moved no cursor, so this one
    // still starts at 1.
    let ack = session
        .send(epoch, 1, 1, &session.append("current"))
        .await
        .unwrap();
    assert_eq!(ack.applied_through, 1);
    assert_eq!(
        session.witness_lines(1).await,
        "current\n",
        "the refused frame's bytes reached the PTY"
    );

    session.handle.shutdown().await.ok();
}
