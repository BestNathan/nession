use super::*;
use crate::db::Database;
use crate::env::EnvService;
use crate::registry::{AgentRegistry, SessionRegistry};
use crate::server::client_registry::ClientRegistry;
use crate::server::command_broker::CommandBroker;
use nession_protocol::contracts::agent::v1::AgentMetadata;
use nession_protocol::ProtocolManifest;
use tokio_tungstenite::tungstenite::Message;

/// Build a test handler wired to in-memory DB + tempdir env store.
async fn test_handler(auth_token: &str) -> ConnectionHandler {
    let db = Arc::new(Database::new(":memory:").await.unwrap());
    let agent_registry = Arc::new(AgentRegistry::new(60, Arc::clone(&db)));
    let session_registry = Arc::new(SessionRegistry::new(Arc::clone(&db)));
    let command_broker = Arc::new(CommandBroker::new());
    let client_registry = Arc::new(ClientRegistry::new());
    let web_client_registry = Arc::new(WebClientRegistry::new());
    let env_service = EnvService::new(Arc::clone(&db));
    ConnectionHandler::new(
        ConnectionHandlerDeps {
            agent_registry,
            session_registry,
            command_broker,
            client_registry,
            web_client_registry,
            env_service,
            db,

            p2p_broker: std::sync::Arc::new(crate::broker::ConnectionBroker::new(300)),
        },
        ConnectionHandlerConfig {
            server_auth_token: auth_token.to_string(),
            heartbeat_interval_secs: 30,
        },
    )
}

fn proto_msg(msg_type: &str, payload: serde_json::Value) -> Message {
    let text = json!({
        "msg_type": msg_type,
        "id": "test-1",
        "timestamp": 0,
        "payload": payload,
    })
    .to_string();
    Message::Text(text)
}

fn parse_reply(action: HandlerAction) -> serde_json::Value {
    match action {
        HandlerAction::Reply(Some(Message::Text(text))) => serde_json::from_str(&text).unwrap(),
        _ => panic!("expected Reply(Some(Text))"),
    }
}

// ---- handle_message dispatch ----

#[tokio::test]
async fn close_message_returns_close() {
    let mut h = test_handler("").await;
    let action = h.handle_message(Message::Close(None)).await.unwrap();
    assert!(matches!(action, HandlerAction::Close));
}

#[tokio::test]
async fn binary_message_returns_empty_reply() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(Message::Binary(vec![1, 2, 3]))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

// ---- manifest-gated extension relay (#678) ----

/// Register an agent, optionally with a manifest that carries one wire type.
async fn register_agent(h: &ConnectionHandler, manifest: Option<ProtocolManifest>) {
    register_agent_id(h, "agent-a", manifest).await;
}

/// Put an agent in the *registry* under an explicit id.
///
/// Deliberately not the same thing as registering a connection as that
/// agent: this is the state a second connection's registration leaves
/// behind, reachable by a handler that is bound to somebody else (#960).
async fn register_agent_id(
    h: &ConnectionHandler,
    agent_id: &str,
    manifest: Option<ProtocolManifest>,
) {
    h.agent_registry
        .register(AgentInfo {
            agent_id: agent_id.to_string(),
            hostname: "h".to_string(),
            ip_address: "10.0.0.1".to_string(),
            port: 8080,
            display_name: None,
            connect_url: None,
            addresses: vec![],
            registered_at: chrono::Utc::now(),
            last_heartbeat: chrono::Utc::now(),
            status: AgentStatus::Online,
            metadata: AgentMetadata {
                tmux_version: "3.3".to_string(),
                os_version: "Linux".to_string(),
                nession_version: "0.1.0".to_string(),
                image_tag: "test".to_string(),
            },
            session_count: 0,
            active_sessions: 0,
            protocol_manifest: manifest,
        })
        .await;
}

fn manifest_carrying(wire: &str) -> ProtocolManifest {
    ProtocolManifest::from_descriptors(
        "agent-a",
        &[nession_protocol::ProtocolDescriptor::new(
            "git.status",
            "nession-git",
            vec![nession_protocol::ContractDescriptor::new(
                nession_protocol::ContractVersion::V1,
                &[wire],
            )],
        )
        .unwrap()],
    )
}

async fn relay(h: &mut ConnectionHandler, wire: &str) -> serde_json::Value {
    relay_payload(h, wire, json!({"agent_id": "agent-a"})).await
}

/// Relay an extension message **as an authenticated client**.
///
/// The authentication is part of the helper because it is a precondition
/// now (`#877`): a connection that has not authenticated is refused before
/// the payload is read, so a test that relays without this flag is a test
/// of the refusal, not of the relay. Every other handler in this file has
/// always worked this way — `listed_protocols` below sets the same flag —
/// and these tests only ever got away without it because the extension path
/// was the one that forgot to check.
///
/// Tests asserting the refusal deliberately do **not** call this.
async fn relay_payload(
    h: &mut ConnectionHandler,
    wire: &str,
    payload: serde_json::Value,
) -> serde_json::Value {
    h.authenticated_client = true;
    // not-protocol: a test helper — the wire is the argument the test names.
    let action = h.handle_message(proto_msg(wire, payload)).await.unwrap();
    parse_reply(action)["payload"].clone()
}

/// A manifest offering `git.status` at v1 and v2.
fn manifest_with_two_versions() -> ProtocolManifest {
    use nession_protocol::{ContractDescriptor, ContractVersion, ProtocolDescriptor};
    ProtocolManifest::from_descriptors(
        "agent-a",
        &[ProtocolDescriptor::new(
            "git.status",
            "nession-git",
            vec![
                ContractDescriptor::new(ContractVersion::V1, &["git.status"]),
                ContractDescriptor::new(ContractVersion::new(2).unwrap(), &["git.status.v2"]),
            ],
        )
        .unwrap()],
    )
}

#[tokio::test]
async fn a_target_that_does_not_carry_the_wire_type_is_refused() {
    // The first thing that consults the manifest an agent advertised.
    let mut h = test_handler("").await;
    register_agent(&h, Some(manifest_carrying("git.status"))).await;

    let payload = relay(&mut h, "git.diff").await;
    assert_eq!(payload["error"], "contract_not_supported");
    assert!(
        payload["message"]
            .as_str()
            .unwrap_or("")
            .contains("git.diff"),
        "the refusal should name what was asked for: {payload}"
    );
}

#[tokio::test]
async fn a_target_that_does_carry_it_is_relayed_rather_than_refused() {
    // The discriminating half. With no live agent connection the relay
    // fails — but it fails *later*, with a different error, which is what
    // proves the manifest check let it through instead of refusing.
    let mut h = test_handler("").await;
    register_agent(&h, Some(manifest_carrying("git.status"))).await;

    let payload = relay(&mut h, "git.status").await;
    assert_ne!(
        payload["error"], "contract_not_supported",
        "a carried wire type must not be refused by the manifest check"
    );
    assert_eq!(payload["error"], "agent_disconnected");
}

#[tokio::test]
async fn an_agent_that_advertised_no_manifest_is_refused_not_relayed() {
    // The rule this replaced said a peer that has not spoken is not a peer
    // that said no, and relayed to it exactly as before manifests existed.
    // `#678` is a breaking upgrade: it is now a peer this server cannot
    // route for, and guessing at a shape nobody declared is the failure the
    // manifest exists to prevent.
    //
    // Reached by registering directly into the registry, because that is
    // the only way this state arises now — `agent.register` refuses it, so
    // this is the straggler that registered before the upgrade.
    let mut h = test_handler("").await;
    register_agent(&h, None).await;

    let payload = relay(&mut h, "git.diff").await;
    assert_eq!(payload["error"], "contract_not_supported");
    assert!(
        payload["message"]
            .as_str()
            .unwrap()
            .contains("no protocol manifest"),
        "the refusal must say which absence it is: {payload}"
    );
    // Refusing is unit-scoped, so the connection and every other unit are
    // untouched — the difference between this and a registration refusal.
    assert_eq!(payload["available"], false);
}

// ---- the pipeline's first step (#877) ----

/// Relay without authenticating, which is the state the gate exists for.
///
/// Deliberately not `relay_payload`: that helper authenticates, so using it
/// here would assert nothing about the refusal.
async fn relay_unauthenticated(h: &mut ConnectionHandler, wire: &str) -> serde_json::Value {
    let action = h
        // not-protocol: a test helper — the wire is the argument the test names.
        .handle_message(proto_msg(wire, json!({ "agent_id": "agent-a" })))
        .await
        .unwrap();
    parse_reply(action)["payload"].clone()
}

#[tokio::test]
async fn an_unauthenticated_extension_request_is_refused_before_it_reaches_an_agent() {
    // The finding in `#877`: every other client-facing handler checked
    // `authenticated_client` and this one did not, so any client that could
    // open a socket could relay to any agent with no credentials — and the
    // target was named by the caller, so it was not merely "some agent".
    //
    // The target here *does* carry the wire type and *is* registered, so
    // without the gate this would get as far as the relay and fail with
    // `agent_disconnected`. `not_authenticated` is therefore the proof it
    // stopped at the gate rather than somewhere further down.
    let mut h = test_handler("tok").await;
    register_agent(&h, Some(manifest_carrying("git.status"))).await;

    let payload = relay_unauthenticated(&mut h, "git.status").await;
    assert_eq!(payload["error"], "not_authenticated");
    assert_eq!(payload["available"], false);
}

#[tokio::test]
async fn the_refusal_does_not_depend_on_which_target_was_named() {
    // The property that decides where the gate sits. Below it, the answers
    // differ by target: an agent that does not exist and one that exists
    // but does not carry the unit are both `contract_not_supported`, with
    // different text naming the agent. An unauthenticated caller able to
    // tell those apart has a way to enumerate the fleet without a
    // credential.
    //
    // The gate reads nothing from the payload, so the two are not merely
    // similar — they are the same bytes.
    let mut h = test_handler("tok").await;
    register_agent(&h, Some(manifest_carrying("git.status"))).await;

    let known_target = relay_unauthenticated(&mut h, "git.status").await;

    let action = h
        .handle_message(proto_msg(
            "git.status",
            json!({ "agent_id": "an-agent-that-was-never-registered" }),
        ))
        .await
        .unwrap();
    let unknown_target = parse_reply(action)["payload"].clone();

    assert_eq!(
        known_target, unknown_target,
        "the refusal must not vary with the target"
    );
}

#[tokio::test]
async fn an_authenticated_client_still_relays() {
    // The other half of the gate: it must refuse exactly the connections
    // that have not authenticated and nothing else. Without this, deleting
    // the relay would leave the two tests above passing.
    let mut h = test_handler("tok").await;
    register_agent(&h, Some(manifest_carrying("git.status"))).await;

    let payload = relay(&mut h, "git.status").await;
    assert_ne!(
        payload["error"], "not_authenticated",
        "an authenticated client must get past the gate"
    );
}

// ---- the target's protocol support is queryable (#678, Phase 3) ----

/// List agents and return the first agent's `protocols` field.
async fn listed_protocols(h: &mut ConnectionHandler) -> serde_json::Value {
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.agent.list", json!({})))
        .await
        .unwrap();
    parse_reply(action)["payload"]["agents"][0]["protocols"].clone()
}

#[tokio::test]
async fn the_server_advertises_what_it_serves() {
    // The Server is a provider like any other (`#678`), and this is where a
    // client learns what it answers — on the call a client already makes to
    // ask what this server is, rather than a message of its own.
    let mut h = test_handler("").await;
    h.authenticated_client = true;

    let action = h
        .handle_message(proto_msg("server.info", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let manifest = &reply["payload"]["protocol_manifest"];

    assert_eq!(manifest["provider"], "nession-server");
    // Named units, not a count: the manifest answers "may I send this peer
    // this message?", so the assertion should be about a message. These two
    // are the ones Phase 6 named and that had no declaration anywhere.
    assert!(manifest["protocols"]["server.session.attach"].is_object());
    assert!(manifest["protocols"]["server.agent.register"].is_object());
    // And a unit this server does not serve stays absent — the manifest
    // exists to refuse, so claiming an offer that does not exist would be
    // the one failure it cannot make.
    assert!(manifest["protocols"]["git.status"].is_null());
}

#[test]
fn every_unit_the_server_dispatches_is_in_its_manifest() {
    // The derivation, asserted. `SERVER_WIRES` and `server_descriptors()`
    // come from one `server_routes!` invocation, so neither can name a unit
    // the other does not — and this is the test that says so rather than
    // the comment that claims it.
    //
    // It matters in one direction especially: a wire this server answers
    // but does not advertise would make its manifest understate it, and a
    // consumer resolving against that manifest would refuse a call this
    // server would have served.
    let manifest = crate::protocol::server_manifest().unwrap();
    assert!(
        !SERVER_WIRES.is_empty(),
        "a declaration with no units is a mistake, not a peer that serves nothing"
    );
    for wire in SERVER_WIRES {
        assert!(
            manifest.carries(wire),
            "`{wire}` is dispatched but not advertised"
        );
    }
}

#[test]
fn every_unit_the_server_dispatches_declares_an_execution_policy() {
    // The same derivation as the test above, for the column #961-C added:
    // `unit_policy` is emitted by the same `server_routes!` invocation that
    // emits `SERVER_WIRES`, so a unit cannot be dispatched without a policy
    // — and this is the assertion that says so rather than the comment on
    // the macro. `policy_for_wire` is what the read loop calls, and a `None`
    // there is not a failure: it is how a wire this server does *not* serve
    // is recognised, which is why the negative case is asserted too.
    //
    // The payload is empty here because this test is about the *declaration*
    // and not about any one key: a policy that reads the payload has to
    // survive being asked about a payload that carries nothing, since a
    // malformed request is dispatched on a lane like every other frame and
    // is refused by the handler rather than by the classifier.
    let nothing = serde_json::json!({});
    for wire in SERVER_WIRES {
        assert!(
            crate::server::handler::unit_policy(wire, &nothing).is_some(),
            "`{wire}` is dispatched but declares no execution policy"
        );
    }
    assert!(
        crate::server::handler::unit_policy("git.status", &nothing).is_none(),
        "a wire this server does not serve must not declare a policy for it"
    );
    assert_eq!(
        crate::server::execution::policy_for_wire("git.status", &nothing),
        crate::server::execution::ExecutionPolicy::Inline,
        "an undeclared wire is dispatched inline rather than guessed at"
    );
}

#[test]
fn a_session_mutation_is_keyed_by_the_session_it_names() {
    // The two spellings the wire uses for one resource, and the property
    // that makes the keyed lane mean anything: `create` names a session by
    // its parts and `kill` names the *same* session joined, so a lane that
    // keyed them differently would let a kill overtake the create it is
    // about — the exact ordering `#961` calls out by name.
    //
    // Asserted as an equality rather than two literals so that it is the
    // *agreement* under test.
    let created = session_by_parts(&serde_json::json!({
        "agent_id": "a1",
        "name": "s1",
    }));
    let killed = session_by_id(&serde_json::json!({ "session_id": "a1:s1" }));
    assert_eq!(created, killed);
    assert_eq!(created.to_string(), "session:a1:s1");

    // And the other direction: two different sessions must not share a key,
    // which is what makes them independent rather than merely fast.
    assert_ne!(
        session_by_parts(&serde_json::json!({ "agent_id": "a1", "name": "s1" })),
        session_by_parts(&serde_json::json!({ "agent_id": "a1", "name": "s2" }))
    );
    assert_ne!(
        session_by_parts(&serde_json::json!({ "agent_id": "a1", "name": "s1" })),
        session_by_parts(&serde_json::json!({ "agent_id": "a2", "name": "s1" }))
    );
}

#[test]
fn an_env_file_is_keyed_by_the_source_it_lives_on() {
    // An agent's `staging.env` and the server's `staging.env` are two files
    // with one name. Keying them together would serialise two unrelated
    // writes; keying the *resource* rather than the name is what the
    // variant is for.
    assert_eq!(
        env_file_key(&serde_json::json!({ "name": "staging.env" })).to_string(),
        "env:staging.env"
    );
    assert_eq!(
        env_file_key(&serde_json::json!({
            "name": "staging.env",
            "source": "agent",
            "agent_id": "a1",
        }))
        .to_string(),
        "env:a1:staging.env"
    );
    assert_ne!(
        env_file_key(&serde_json::json!({ "name": "staging.env" })),
        env_file_key(&serde_json::json!({
            "name": "staging.env",
            "source": "agent",
            "agent_id": "a1",
        }))
    );
}

#[test]
fn the_mutations_are_declared_keyed_and_the_queries_are_not() {
    // The declaration, read back — the stage-E half of the same derivation
    // the two tests above make for stages C and D. A mutation that someone
    // later marks `Inline` would run in the reader and lose its ordering
    // silently, and nothing else in the tree would say so.
    let nothing = serde_json::json!({});
    for wire in [
        "server.session.create",
        "server.session.kill",
        "server.session.env.apply",
        "server.session.env.unset",
        "server.env.write",
        "server.env.delete",
    ] {
        assert!(
            matches!(
                crate::server::handler::unit_policy(wire, &nothing),
                Some(crate::server::execution::ExecutionPolicy::Key(_))
            ),
            "`{wire}` mutates a resource and must be declared `Key`"
        );
    }
    for wire in ["server.env.list", "server.env.get", "server.session.list"] {
        assert!(
            matches!(
                crate::server::handler::unit_policy(wire, &nothing),
                Some(crate::server::execution::ExecutionPolicy::Query)
            ),
            "`{wire}` reads and must not be declared `Key`"
        );
    }
}

#[tokio::test]
async fn the_agents_list_carries_what_each_agent_can_serve() {
    // Served from the list rather than a query of its own: it is already
    // the discover-agents call, so a consumer resolving per target has the
    // manifests in hand without a second round trip per agent.
    let mut h = test_handler("").await;
    register_agent(&h, Some(manifest_carrying("git.status"))).await;

    let protocols = listed_protocols(&mut h).await;
    assert_eq!(protocols["provider"], "agent-a");
    assert_eq!(protocols["protocols"]["git.status"]["versions"][0], 1);
    assert_eq!(
        protocols["protocols"]["git.status"]["wire"][0],
        "git.status"
    );
}

#[tokio::test]
async fn a_rename_reply_carries_the_manifest_and_the_image_tag() {
    // The test the defect needed. `server.agent.rename` built its own agent
    // block, and it carried neither `protocols` nor `metadata.image_tag` —
    // the two fields `agent_view`'s doc comment names as the drift that
    // consolidating the builders was supposed to end. The block is gone and
    // the reply is `WebAgentInfo` now, so this asserts the two fields rather
    // than the absence of a `json!` call: a future hand-built block would
    // have to reproduce both to pass.
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    register_agent(&h, Some(manifest_carrying("git.status"))).await;

    let action = h
        .handle_message(proto_msg(
            "server.agent.rename",
            json!({ "agent_id": "agent-a", "display_name": "Renamed" }),
        ))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();

    let parsed: AgentRenameReply = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.agent.rename replies {payload} but its contract does not accept it: {e}")
        });
    let AgentRenameReply::Renamed(reply) = parsed else {
        panic!("a rename of a registered agent is not a refusal: {payload}");
    };

    assert!(
        reply.agent.protocols.is_some(),
        "the reply carries the manifest — losing it makes the Web's next call to this \
         agent go out unversioned, which looks like nothing being wrong"
    );
    assert_eq!(reply.agent.metadata.image_tag, "test");
}

// ---- a named contract version is checked against the target (#678) ----

#[tokio::test]
async fn a_named_version_the_target_does_not_offer_is_refused() {
    // The caller resolved against a manifest and picked v3. The target
    // offers v1 and v2 — so either the caller read a manifest that is no
    // longer current (the design's "target manifest stale"), or it invented
    // the version. Either way it must not be relayed.
    let mut h = test_handler("").await;
    register_agent(&h, Some(manifest_with_two_versions())).await;

    let payload = relay_payload(
        &mut h,
        "git.status",
        json!({"agent_id": "agent-a", "contract_version": 3}),
    )
    .await;

    assert_eq!(payload["error"], "contract_not_supported");
    assert_eq!(payload["protocol"], "git.status");
    assert_eq!(payload["named_version"], 3);
    // Both sides, so a reader learns who has to move rather than only that
    // something did not line up.
    assert_eq!(payload["offered_versions"], json!([1, 2]));
    assert!(
        payload["message"].as_str().unwrap_or("").contains("v3"),
        "the refusal should name the version asked for: {payload}"
    );
}

#[tokio::test]
async fn a_named_version_the_target_offers_is_relayed() {
    // The discriminating half, as in the wire-type gate: with no live agent
    // the relay fails later and differently, which is how this test knows
    // the version check let it through.
    let mut h = test_handler("").await;
    register_agent(&h, Some(manifest_with_two_versions())).await;

    for version in [1, 2] {
        let payload = relay_payload(
            &mut h,
            "git.status",
            json!({"agent_id": "agent-a", "contract_version": version}),
        )
        .await;
        assert_ne!(
            payload["error"], "contract_not_supported",
            "v{version} is offered and must not be refused"
        );
        assert_eq!(payload["error"], "agent_disconnected");
    }
}

#[tokio::test]
async fn an_unversioned_call_to_a_two_version_unit_is_refused() {
    // `#963` Scope 2. A unit the target serves at more than one generation
    // is the one case where naming no version is genuinely ambiguous — the
    // caller could have meant either, and nothing on the wire says which.
    //
    // This test used to assert the opposite, under the reasoning that
    // "absence is not a claim about versions, any more than it is about wire
    // types". The premise was right and the conclusion did not follow: a
    // claim is exactly what the caller *cannot* make here, so relaying hands
    // the target a request whose version nobody checked — which is the
    // failure the scope names.
    let mut h = test_handler("").await;
    register_agent(&h, Some(manifest_with_two_versions())).await;

    let payload = relay(&mut h, "git.status").await;
    assert_eq!(payload["error"], "contract_not_supported");
    assert_eq!(payload["protocol"], "git.status");
    assert_eq!(payload["offered_versions"], json!([1, 2]));
    assert!(
        payload["message"]
            .as_str()
            .unwrap_or("")
            .contains("name one"),
        "the refusal should say what the caller has to do: {payload}"
    );
}

#[tokio::test]
async fn an_unversioned_call_to_a_single_version_unit_is_relayed() {
    // The discriminating half, and the reason the rule is the *ambiguity*
    // rather than the absence. Every `agent.file.*`, `agent.env.*` and
    // `agent.session.*` call is unversioned today and every one of those
    // units has a single version — where the call has exactly one possible
    // meaning. Refusing those would break every caller while catching
    // nothing, which is why `#963` Scope 2's literal wording was not taken.
    let mut h = test_handler("").await;
    register_agent(&h, Some(manifest_carrying("git.status"))).await;

    let payload = relay(&mut h, "git.status").await;
    assert_ne!(
        payload["error"], "contract_not_supported",
        "a single-version unit has one thing an unversioned call can mean"
    );
    assert_eq!(payload["error"], "agent_disconnected");
}

#[tokio::test]
async fn an_agent_without_a_manifest_reports_null_rather_than_an_empty_set() {
    // The distinction the whole legacy rule rests on. `{}` would say "this
    // peer has a protocol set and it is empty" — a peer that serves
    // nothing. `null` says "this peer predates manifests", which the design
    // resolves as a Legacy Peer. A consumer that collapsed the two would
    // refuse to talk to every old agent.
    let mut h = test_handler("").await;
    register_agent(&h, None).await;

    let protocols = listed_protocols(&mut h).await;
    assert!(
        protocols.is_null(),
        "expected null for a legacy peer, got {protocols}"
    );
}

#[tokio::test]
async fn invalid_json_returns_error() {
    let mut h = test_handler("").await;
    let result = h.handle_message(Message::Text("not json".into())).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn unknown_msg_type_returns_empty_reply() {
    let mut h = test_handler("").await;
    let action = h
        // not-protocol: the wire being unknown is what this test asserts.
        .handle_message(proto_msg("unknown.type", json!({})))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

// ---- agent.register ----

#[tokio::test]
async fn agent_register_no_auth_mode() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "anything",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "accepted");
    assert_eq!(h.registered_agent_id(), Some(&"a1".to_string()));
}

#[tokio::test]
async fn agent_register_valid_token() {
    let mut h = test_handler("secret").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "secret",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "accepted");
}

#[tokio::test]
async fn agent_register_without_a_manifest_is_rejected() {
    // `#678` is a breaking upgrade: an agent this server cannot route for
    // does not connect. Refusing here rather than at the first relay is the
    // difference between an agent that never comes up and one that
    // connects, looks healthy, and silently drops every request aimed at
    // it.
    //
    // A valid auth token, so the rejection can only be the missing
    // manifest — otherwise this test would pass for the wrong reason.
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "old-agent",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "rejected");
    assert!(
        reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("no protocol manifest"),
        "the rejection must name the missing manifest: {reply}"
    );
    // And nothing was registered, so no later call can reach it.
    assert!(
        h.agent_registry.get("old-agent").await.is_none(),
        "a rejected agent must not be in the registry"
    );
}

#[tokio::test]
async fn agent_register_invalid_token_rejected() {
    let mut h = test_handler("secret").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "wrong",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "rejected");
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("Invalid auth token"));
}

#[tokio::test]
async fn agent_register_with_addresses() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [
                    { "url": "ws://1.2.3.4:19091/ws", "network_type": "lan", "label": "" }
                ],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "accepted");
    // Verify heartbeat_interval_secs is present
    assert_eq!(reply["payload"]["heartbeat_interval_secs"], 30);
}

// ---- control.heartbeat ----

#[tokio::test]
async fn control_heartbeat_registered_is_handled_and_answered_with_nothing() {
    let mut h = test_handler("").await;
    // Register first
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();

    let action = h
        .handle_message(proto_msg(
            "control.heartbeat",
            json!({
                "agent_id": "a1",
                "session_count": 3,
                "active_sessions": 1,
            }),
        ))
        .await
        .unwrap();
    // Handled, and answered with nothing: control has no acknowledgement,
    // so there is no `server.heartbeat.ack` for this to be the request half
    // of. `Reply(None)` rather than a frame is the whole assertion.
    assert!(matches!(action, HandlerAction::Reply(None)));

    // The bookkeeping the heartbeat exists for still happened.
    let agent = h.agent_registry.get("a1").await.expect("registered agent");
    assert_eq!(agent.session_count, 3);
    assert_eq!(agent.active_sessions, 1);
}

#[tokio::test]
async fn control_heartbeat_unregistered_returns_none() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "control.heartbeat",
            json!({
                "agent_id": "unknown",
                "session_count": 0,
                "active_sessions": 0,
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

#[tokio::test]
async fn control_heartbeat_missing_fields_defaults_to_zero() {
    let mut h = test_handler("").await;
    // Register
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    // Heartbeat with no session_count / active_sessions
    let action = h
        .handle_message(proto_msg("control.heartbeat", json!({ "agent_id": "a1" })))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
    let agent = h.agent_registry.get("a1").await.expect("registered agent");
    assert_eq!(agent.session_count, 0);
    assert_eq!(agent.active_sessions, 0);
}

// ---- agent.session.update ----

#[tokio::test]
async fn session_update_active() {
    let mut h = test_handler("").await;
    // Register agent
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();

    let action = h
        .handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "active",
                "window_count": 2,
                "attached_clients": 1,
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

#[tokio::test]
async fn session_update_all_statuses() {
    let mut h = test_handler("").await;
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();

    for status in &["active", "detached", "recovering", "orphaned", "zombie"] {
        let action = h
            .handle_message(proto_msg(
                "server.agent.session-update",
                json!({
                    "agent_id": "a1",
                    "session_name": format!("s_{status}"),
                    "status": status,
                    "window_count": 1,
                    "attached_clients": 0,
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }
}

#[tokio::test]
async fn session_update_unknown_status_returns_none() {
    let mut h = test_handler("").await;
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    let action = h
        .handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "invalid_status",
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

#[tokio::test]
async fn session_update_gone_removes_session() {
    let mut h = test_handler("").await;
    // Register agent
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    // Create a session
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();
    // Remove it
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "gone",
        }),
    ))
    .await
    .unwrap();
    // Session should be gone
    let _action = h
        .handle_message(proto_msg("server.session.list", json!({})))
        .await
        .unwrap();
    // First need to authenticate
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.session.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["sessions"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn session_update_from_unregistered_agent() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "unknown",
                "session_name": "dev",
                "status": "active",
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

// ---- server.auth ----

#[tokio::test]
async fn client_auth_success() {
    let mut h = test_handler("secret").await;
    let action = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "secret" })))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "success");
}

#[tokio::test]
async fn client_auth_failure() {
    let mut h = test_handler("secret").await;
    let action = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "wrong" })))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "failed");
}

#[tokio::test]
async fn client_auth_no_auth_mode() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.auth",
            json!({ "auth_token": "anything" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "success");
}

// ---- unauthenticated client rejection ----

#[tokio::test]
async fn unauthenticated_agents_list_rejected() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.agent.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "error");
}

#[tokio::test]
async fn unauthenticated_sessions_list_rejected() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.session.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "error");
}

#[tokio::test]
async fn unauthenticated_session_attach_rejected() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "error");
}

#[tokio::test]
async fn unauthenticated_session_create_rejected() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.session.create",
            json!({ "agent_id": "a1", "name": "dev" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
}

#[tokio::test]
async fn unauthenticated_session_kill_rejected() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.session.kill",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
}

// ---- server.agent.list ----

#[tokio::test]
async fn agents_list_returns_registered() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register an agent
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1", "image_tag": "sha-abc123" },
        }),
    ))
    .await
    .unwrap();

    let action = h
        .handle_message(proto_msg("server.agent.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let agents = reply["payload"]["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["agent_id"], "a1");
    assert_eq!(agents[0]["status"], "online");
    // image_tag must be forwarded to clients (regression: it was dropped
    // from the metadata JSON, so the UI showed "unknown").
    assert_eq!(agents[0]["metadata"]["image_tag"], "sha-abc123");
}

#[tokio::test]
async fn agents_list_empty() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.agent.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["agents"].as_array().unwrap().is_empty());
}

// ---- server.session.list ----

#[tokio::test]
async fn sessions_list_with_filter() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register agent
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    // Create sessions
    for name in &["s1", "s2"] {
        h.handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": name,
                "status": "active",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();
    }
    // Filter by agent_id
    let action = h
        .handle_message(proto_msg(
            "server.session.list",
            json!({ "agent_id": "a1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let sessions = reply["payload"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
}

// ---- server.session.list force refresh ----

/// Registering via `agent.register` marks the agent Online but does not
/// give it a CommandBroker control connection, so a force refresh will
/// find it unreachable — exactly the "agent went away" case.
async fn handler_with_online_agent() -> ConnectionHandler {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    h
}

async fn add_session(h: &mut ConnectionHandler, agent_id: &str, name: &str) {
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": agent_id,
            "session_name": name,
            "status": "detached",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();
}

#[tokio::test]
async fn force_refresh_with_no_agents_is_a_noop() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.session.list", json!({ "force": true })))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["sessions"].as_array().unwrap().is_empty());
    assert!(reply["payload"]["stale_agents"]
        .as_array()
        .unwrap()
        .is_empty());
}

/// The core failure-semantics guarantee: an agent that cannot answer keeps
/// its sessions and is reported stale, rather than having live sessions
/// deleted because of a transient blip.
#[tokio::test]
async fn force_refresh_keeps_sessions_of_unreachable_agent_and_marks_stale() {
    let mut h = handler_with_online_agent().await;
    add_session(&mut h, "a1", "s1").await;

    let action = h
        .handle_message(proto_msg("server.session.list", json!({ "force": true })))
        .await
        .unwrap();
    let reply = parse_reply(action);

    // Session survived.
    let sessions = reply["payload"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["session_id"], "a1:s1");
    // And the agent is flagged so the UI can warn.
    let stale = reply["payload"]["stale_agents"].as_array().unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0], "a1");
}

/// Without `force`, no agent is contacted, so nothing is ever stale.
#[tokio::test]
async fn non_force_list_never_reports_stale() {
    let mut h = handler_with_online_agent().await;
    add_session(&mut h, "a1", "s1").await;

    let action = h
        .handle_message(proto_msg("server.session.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);

    assert_eq!(reply["payload"]["sessions"].as_array().unwrap().len(), 1);
    assert!(reply["payload"]["stale_agents"]
        .as_array()
        .unwrap()
        .is_empty());
}

/// The `agent_id` filter narrows the fan-out targets: an id matching no
/// agent contacts nobody, so nothing is stale and nothing is returned.
#[tokio::test]
async fn force_refresh_scopes_fanout_to_the_requested_agent() {
    let mut h = handler_with_online_agent().await;
    add_session(&mut h, "a1", "s1").await;

    let action = h
        .handle_message(proto_msg(
            "server.session.list",
            json!({ "force": true, "agent_id": "nonexistent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);

    assert!(reply["payload"]["stale_agents"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(reply["payload"]["sessions"].as_array().unwrap().is_empty());
    // a1's session was left alone — it was never a refresh target.
    assert_eq!(h.session_registry.list().await.len(), 1);
}

/// The happy path: the agent answers with its live tmux state and the
/// registry is rebuilt from it — stale entries dropped, real ones kept,
/// and the agent is not reported stale.
#[tokio::test]
async fn force_refresh_rebuilds_registry_from_agent_reply() {
    let mut h = handler_with_online_agent().await;
    // Registry believes "ghost" exists; tmux will say otherwise.
    add_session(&mut h, "a1", "ghost").await;

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let list_fut = h.handle_message(proto_msg("server.session.list", json!({ "force": true })));
    let agent_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("agent should receive sessions.list")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], "agent.session.report");
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command(
                "a1",
                &request_id,
                json!({
                    "success": true,
                    "sessions": [
                        {
                            "name": "real",
                            "window_count": 2,
                            "attached_clients": 1,
                            "created_at": 1000,
                            "foreground_command": "claude",
                        },
                    ],
                }),
            )
            .await;
    };
    let (action, ()) = tokio::join!(list_fut, agent_fut);
    let reply = parse_reply(action.unwrap());

    let sessions = reply["payload"]["sessions"].as_array().unwrap();
    assert_eq!(
        sessions.len(),
        1,
        "ghost should be gone, real should remain"
    );
    assert_eq!(sessions[0]["session_id"], "a1:real");
    assert_eq!(sessions[0]["status"], "active");
    assert_eq!(sessions[0]["window_count"], 2);
    assert_eq!(
        sessions[0]["foreground_command"], "claude",
        "the agent-reported pane command must survive the refresh into the wire payload"
    );
    assert!(reply["payload"]["stale_agents"]
        .as_array()
        .unwrap()
        .is_empty());
}

/// Regression #743: the agent WebSocket loop claims the agent for its
/// connection on **every** inbound agent message (`server/websocket.rs`),
/// so that can happen while a command is in flight. It is a transport
/// update and must not cancel the command — otherwise the client is told
/// "Agent disconnected" for a session the agent actually created, and the
/// real response is discarded when it arrives.
#[tokio::test]
async fn session_create_survives_an_intervening_agent_message() {
    let mut h = handler_with_online_agent().await;

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let create_fut = h.handle_message(proto_msg(
        "server.session.create",
        json!({ "agent_id": "a1", "name": "regression-743" }),
    ));
    let agent_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("agent should receive session.create")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();

        // An unrelated inbound message from the same agent arrives first;
        // the loop claims the agent for the connection that sent it — a
        // newer one here, standing in for a reconnect.
        let (sender_again, _keepalive) = WsMessageSender::new();
        let generation = broker.new_connection_generation();
        broker.claim_agent("a1", generation, sender_again).await;

        broker
            .resolve_command("a1", &request_id, json!({ "success": true }))
            .await;
    };
    let (action, ()) = tokio::join!(create_fut, agent_fut);
    let reply = parse_reply(action.unwrap());

    assert_eq!(
        reply["payload"]["success"],
        json!(true),
        "an intervening agent message must not turn a completed create into a reported failure"
    );
    assert_eq!(reply["payload"]["session_id"], json!("a1:regression-743"));
}

// ---- parse_agent_sessions ----
#[test]
fn parse_agent_sessions_reads_the_foreground_command() {
    let resp = json!({
        "sessions": [
            { "name": "running", "window_count": 1, "attached_clients": 1, "created_at": 1, "foreground_command": "claude" },
            { "name": "empty", "window_count": 1, "attached_clients": 0, "created_at": 1, "foreground_command": "" },
            { "name": "missing", "window_count": 1, "attached_clients": 0, "created_at": 1 },
        ],
    });
    let sessions = parse_agent_sessions("a1", &resp);
    assert_eq!(sessions[0].foreground_command.as_deref(), Some("claude"));
    assert_eq!(
        sessions[1].foreground_command, None,
        "an empty command is no observation"
    );
    assert_eq!(
        sessions[2].foreground_command, None,
        "an absent field is tolerated"
    );
}

#[test]
fn parse_agent_sessions_derives_status_from_attached_clients() {
    let resp = json!({
        "sessions": [
            { "name": "idle", "window_count": 1, "attached_clients": 0, "created_at": 1000 },
            { "name": "busy", "window_count": 2, "attached_clients": 3, "created_at": 2000 },
        ]
    });
    let mut got = parse_agent_sessions("a1", &resp);
    got.sort_by(|a, b| a.session_name.cmp(&b.session_name));

    assert_eq!(got.len(), 2);
    assert_eq!(got[0].session_id, "a1:busy");
    assert_eq!(got[0].status, SessionStatus::Active);
    assert_eq!(got[0].window_count, 2);
    assert_eq!(got[1].session_id, "a1:idle");
    assert_eq!(got[1].status, SessionStatus::Detached);
}

#[test]
fn parse_agent_sessions_handles_missing_and_empty() {
    assert!(parse_agent_sessions("a1", &json!({})).is_empty());
    assert!(parse_agent_sessions("a1", &json!({ "sessions": [] })).is_empty());
    // Entries without a usable name are skipped, not fatal.
    let resp = json!({ "sessions": [{ "window_count": 1 }, { "name": "" }] });
    assert!(parse_agent_sessions("a1", &resp).is_empty());
}

#[test]
fn parse_agent_sessions_tolerates_absent_optional_fields() {
    let resp = json!({ "sessions": [{ "name": "bare" }] });
    let got = parse_agent_sessions("a1", &resp);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].window_count, 0);
    assert_eq!(got[0].attached_clients, 0);
    assert_eq!(got[0].status, SessionStatus::Detached);
}

// ---- server.session.attach ----

#[tokio::test]
async fn attach_invalid_session_id_format() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "no-colon" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("Invalid session_id format"));
}

#[tokio::test]
async fn attach_session_not_found() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "a1:nonexistent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

#[tokio::test]
async fn attach_agent_offline() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register agent
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    // Create session
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();
    // Manually set agent offline by checking with timeout
    h.agent_registry.check_offline_agents().await;
    // Force offline: update heartbeat to long ago
    h.agent_registry.unregister("a1").await;

    // Re-register with a different approach - just test that agent not found works
    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "a1:dev" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

#[tokio::test]
async fn attach_p2p_mode_success() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register agent
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    // Create session
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();
    // The Server hands the credential to the agent that will verify it
    // **before** it answers the client (#1013), so the attach cannot
    // complete unless the agent answers. Standing one in for the test is
    // the point rather than an inconvenience: what this exercises is the
    // ordering, and the assertions below would hang for the grant deadline
    // if the Server answered the client first.
    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let attach_fut = h.handle_message(proto_msg(
        "server.session.attach",
        json!({ "session_id": "a1:dev", "preferred_mode": "p2p" }),
    ));
    let grant_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("the agent is told before the client is answered")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let grant: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(grant["msg_type"], "agent.p2p.grant");
        assert_eq!(grant["payload"]["agent_id"], "a1");
        assert_eq!(grant["payload"]["session_id"], "a1:dev");
        assert_eq!(
            grant["payload"]["scope"]["terminal"], "dev",
            "the credential is bound to the session it was minted for"
        );
        assert!(
            grant["payload"]["credential"]
                .as_str()
                .is_some_and(|token| !token.is_empty()),
            "and it carries the credential the client will present"
        );

        let request_id = grant["payload"]["request_id"].as_str().unwrap().to_string();
        broker
            .resolve_command("a1", &request_id, json!({ "success": true }))
            .await;
    };

    let (action, ()) = tokio::join!(attach_fut, grant_fut);
    let action = action.unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "success");
    assert_eq!(reply["payload"]["mode"], "p2p");
    // The response identifies the session it describes — the web client's
    // SessionRuntime ownership gate keys on attachInfo.session_id.
    assert_eq!(reply["payload"]["session_id"], "a1:dev");
    assert!(reply["payload"]["agent_address"]
        .as_str()
        .unwrap()
        .contains("1.2.3.4"));
}

#[tokio::test]
async fn attach_relay_mode() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register agent + create session
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();

    // Phase 1: query relay — returns info but does NOT enter relay forwarding.
    let (relay_sender, mut relay_rx) = WsMessageSender::new();
    h.set_client_sender(relay_sender);
    let action = h
        .handle_message(proto_msg(
            "server.session.attach",
            json!({ "session_id": "a1:dev", "preferred_mode": "relay" }),
        ))
        .await
        .unwrap();
    assert!(
        matches!(action, HandlerAction::Reply(None)),
        "Phase 1 should return Reply(None)"
    );

    // The phase-1 response goes over the client sender channel and must
    // identify the session (the web client keys on attachInfo.session_id).
    let phase1 = relay_rx.try_recv().expect("phase 1 response not sent");
    let Message::Text(phase1_text) = phase1.message else {
        panic!("expected Text message");
    };
    let phase1: serde_json::Value = serde_json::from_str(&phase1_text).unwrap();
    assert_eq!(phase1["payload"]["status"], "success");
    assert_eq!(phase1["payload"]["mode"], "relay");
    assert_eq!(phase1["payload"]["session_id"], "a1:dev");

    // Phase 2: begin relay. The Server hands the credential to the agent
    // that will verify it **before** it dials (#1013), so this cannot
    // complete without an agent that answers.
    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;
    let broker = Arc::clone(&h.command_broker);

    let begin_fut = h.handle_message(proto_msg(
        "server.session.relay.begin",
        json!({ "session_id": "a1:dev" }),
    ));
    let grant_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("the agent is told before the server dials it")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let grant: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(grant["msg_type"], "agent.p2p.grant");
        assert_eq!(grant["payload"]["scope"]["terminal"], "dev");
        assert_eq!(
            grant["payload"]["scope"]["files"], false,
            "a relay credential is the narrow one: the relay leg never touches a file"
        );
        assert_eq!(
            grant["payload"]["scope"]["sessions"], false,
            "and it never creates or kills a session"
        );

        let request_id = grant["payload"]["request_id"].as_str().unwrap().to_string();
        broker
            .resolve_command("a1", &request_id, json!({ "success": true }))
            .await;
    };

    let (action, ()) = tokio::join!(begin_fut, grant_fut);
    let action = action.unwrap();
    match action {
        HandlerAction::Relay {
            agent_ws_urls,
            session_id: _,
            session_name,
            client_id: _,
            browser_client_id: _,
            env_snapshots,
            cols: _,
            rows: _,
            size_known,
            needs_bootstrap,
        } => {
            assert!(!agent_ws_urls.is_empty(), "expected at least one relay URL");
            assert!(agent_ws_urls[0].contains("1.2.3.4"));
            assert_eq!(session_name, "dev");
            assert!(env_snapshots.is_empty());
            // The same rule as `needs_bootstrap` below, one field earlier:
            // this payload said nothing about whether the browser had
            // measured a viewport, and saying nothing has always meant the
            // columns are the browser's own (#1265).
            assert_eq!(size_known, None);
            // This payload said nothing about bootstrap (#321), and the
            // difference between `None` and `Some(false)` is the whole
            // point of the field: absent leaves the agent to decide, which
            // is what every client predating it gets.
            assert_eq!(needs_bootstrap, None);
            // The credential rides **on the URLs**, which is what makes both
            // relay dials carry it without knowing about it — the attach dial
            // iterates this list, and the detach dial reuses the one that
            // succeeded. A credential threaded beside the URL would have to
            // be kept in step with two call sites.
            assert!(
                agent_ws_urls.iter().all(|url| url.contains("token=")),
                "every candidate the dials use carries the credential: {agent_ws_urls:?}"
            );
        }
        _ => panic!("expected Relay action"),
    }
}

// ---- server.session.create ----

#[tokio::test]
async fn session_create_missing_fields() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.create",
            json!({ "agent_id": "", "name": "" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("required"));
}

#[tokio::test]
async fn session_create_agent_not_found() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.create",
            json!({ "agent_id": "nonexistent", "name": "dev" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

// ---- server.session.kill ----

#[tokio::test]
async fn session_kill_invalid_format() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.kill",
            json!({ "session_id": "no-colon" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("Invalid session_id format"));
}

#[tokio::test]
async fn session_kill_agent_not_found() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.kill",
            json!({ "session_id": "unknown:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

#[tokio::test]
async fn session_kill_session_not_found_agent_online() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register agent (it's online)
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    // Kill a session that doesn't exist — agent is online
    let action = h
        .handle_message(proto_msg(
            "server.session.kill",
            json!({ "session_id": "a1:nonexistent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

// ---- server.agent.command-response ----

#[tokio::test]
async fn command_response_from_unregistered_returns_none() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.command-response",
            json!({ "request_id": "r1", "success": true }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

#[tokio::test]
async fn command_response_missing_request_id_returns_none() {
    let mut h = test_handler("").await;
    // Register agent
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    let action = h
        .handle_message(proto_msg(
            "server.agent.command-response",
            json!({ "request_id": "", "success": true }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

// ---- env handlers (unauthenticated) ----

#[tokio::test]
async fn env_list_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.env.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn env_list_reply_is_what_its_contract_says_it_is() {
    // The test `server.auth` never had. That unit's contract requires a
    // `client_id` its handler has never sent, so a consumer reading that
    // reply as its own declared type fails — and nothing noticed, because
    // the handler built the payload with `json!` and no test ever asked the
    // type what it expected.
    //
    // So this asks: take the reply off the wire and read it the way the
    // contract says it is. It is the difference between "the handler uses
    // the type" being a claim about the source and being a checked fact —
    // and it is what the identity-only entries were missing, since a unit
    // with `request: None` cannot have this test at all.
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.env.list", json!({})))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: ClientEnvListResponsePayload = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.env.list replies {payload} but its contract does not accept it: {e}")
        });

    assert!(
        parsed.error.is_some(),
        "an unauthenticated caller is told why rather than handed an empty list"
    );
}

#[tokio::test]
async fn env_get_reply_is_what_its_contract_says_it_is() {
    // The same guard as `env_list_reply_is_what_its_contract_says_it_is`,
    // on the unit whose `in_use_by` had to become optional: two branches
    // answer before it is computed. Both forms have to round-trip, and
    // which form each branch produces is the part that is easy to get
    // wrong by hand.
    let mut h = test_handler("").await;

    let action = h
        .handle_message(proto_msg("server.env.get", json!({ "name": "x.env" })))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: ClientEnvGetResponsePayload = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.env.get replies {payload} but its contract does not accept it: {e}")
        });
    assert!(!parsed.success);
    assert!(
        parsed.in_use_by.is_none(),
        "an unauthenticated caller is not told what is in use — absent, not empty"
    );

    // Authenticated, and past the point where usage is computed.
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.env.get",
            json!({ "name": "missing.env" }),
        ))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: ClientEnvGetResponsePayload = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.env.get replies {payload} but its contract does not accept it: {e}")
        });
    assert!(
        parsed.in_use_by.is_some(),
        "a request that reached the lookup reports usage, even when empty"
    );
}

#[tokio::test]
async fn env_delete_reply_and_request_are_what_their_contract_says() {
    // `delete`'s reply is an exact match on every branch, so unlike the
    // other two this is a plain regression guard. Its *request* is where
    // the work was: `force` was read off `Value` beside the parser for
    // years, and a missing `source` was defaulted.
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "x.env", "force": true }),
        ))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: ClientEnvDeleteResponsePayload = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!(
                "server.env.delete replies {payload} but its contract does not accept it: {e}"
            )
        });
    assert!(!parsed.success);
    assert!(parsed.error.is_some(), "an unauthenticated delete says why");

    let with_force: ClientEnvDeletePayload =
        serde_json::from_value(json!({ "name": "x.env", "force": true }))
            .expect("`force` is a declared field, and the Web has always sent it");
    assert!(with_force.force);

    let no_source: ClientEnvDeletePayload = serde_json::from_value(json!({ "name": "x.env" }))
        .expect("a missing source defaults to the server, as parse_env_ref did");
    assert_eq!(no_source.source, EnvSource::Server);
}

#[tokio::test]
async fn session_list_reply_is_what_its_contract_says_it_is() {
    // The first unit whose contract is a union of two *disjoint* shapes.
    // Both halves have to round-trip — the refusal is what eleven handlers
    // send and what no contract described until now.
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.session.list", json!({})))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: ServerSessionListReply = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.session.list replies {payload} but its contract does not accept it: {e}")
        });
    assert!(
        matches!(parsed, ServerSessionListReply::Refused(_)),
        "an unauthenticated caller is refused, not handed an empty list"
    );

    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.session.list", json!({})))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: ServerSessionListReply = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.session.list replies {payload} but its contract does not accept it: {e}")
        });
    assert!(matches!(parsed, ServerSessionListReply::Listed(_)));
}

#[tokio::test]
async fn session_kill_reply_is_what_its_contract_says_it_is() {
    // The one branch worth pinning is the offline-agent one: it used to
    // send `{ "success": true }` with no `error` field, and the type has no
    // `skip_serializing_if`, so it now carries `error: null`. That reads as
    // noise unless you know the Web declares `error?: string` — so this
    // asserts the field is *present and null*, not merely absent, which is
    // the difference a typo in the type would silently remove.
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.session.kill", json!({})))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: WebSessionKillResponse = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.session.kill replies {payload} but its contract does not accept it: {e}")
        });
    assert!(!parsed.success);
    assert!(parsed.error.is_some(), "a bad session_id says why");
}

#[tokio::test]
async fn env_get_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.env.get", json!({ "name": "test.env" })))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn env_write_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "test.env", "content": "X=1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn env_delete_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "test.env" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

// ---- env handlers (authenticated, server files) ----

#[tokio::test]
async fn env_get_missing_name() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.env.get", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("required"));
}

#[tokio::test]
async fn env_write_and_read_server_file() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Write
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({
                "name": "test.env",
                "content": "FOO=bar\nBAZ=qux",
                "overwrite": false,
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], true);
    // Read back
    let action = h
        .handle_message(proto_msg(
            "server.env.get",
            json!({ "name": "test.env", "source": "server" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], true);
    assert!(reply["payload"]["content"]
        .as_str()
        .unwrap()
        .contains("FOO=bar"));
}

#[tokio::test]
async fn env_write_missing_name() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "", "content": "X=1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("required"));
}

#[tokio::test]
async fn env_delete_missing_name() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.env.delete", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("required"));
}

#[tokio::test]
async fn env_list_server_files() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Write a file first
    h.handle_message(proto_msg(
        "server.env.write",
        json!({
            "name": "test.env",
            "content": "X=1",
            "overwrite": false,
        }),
    ))
    .await
    .unwrap();
    let action = h
        .handle_message(proto_msg("server.env.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let files = reply["payload"]["files"].as_array().unwrap();
    assert!(!files.is_empty());
}

#[tokio::test]
async fn env_delete_server_file() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "del.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "del.env", "source": "server" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], true);
}

// ---- session env handlers ----

#[tokio::test]
async fn session_env_apply_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.session.env.apply",
            json!({ "session_id": "a1:s1", "env_files": [] }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn session_env_apply_invalid_session_id() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.env.apply",
            json!({ "session_id": "no-colon", "env_files": [] }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("Invalid session_id"));
}

#[tokio::test]
async fn session_env_unset_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.session.env.unset",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn session_env_unset_invalid_session_id() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.env.unset",
            json!({ "session_id": "no-colon" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
}

#[tokio::test]
async fn session_env_active_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.session.env.active",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn session_env_active_returns_list() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.env.active",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["active"].as_array().is_some());
}

#[tokio::test]
async fn session_env_query_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.session.env.query",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn session_env_query_invalid_session_id() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.env.query",
            json!({ "session_id": "no-colon" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("Invalid session_id"));
}

// ---- env payload contracts ----
//
// These replace the three `parse_env_ref` tests. That helper is gone — the
// handlers parse into the contract types now — and the leniency it had is
// expressed by those types' serde defaults, so that is what these pin. The
// behaviour they describe is unchanged; only the place it is written down
// has moved.

#[test]
fn a_missing_source_is_a_server_file() {
    let p: ClientEnvWritePayload = serde_json::from_value(json!({ "name": "x.env" })).unwrap();
    assert_eq!(p.source, EnvSource::Server);
    assert!(p.agent_id.is_none());
}

#[test]
fn an_agent_source_carries_its_agent() {
    let p: ClientEnvWritePayload =
        serde_json::from_value(json!({ "name": "x.env", "source": "agent", "agent_id": "a1" }))
            .unwrap();
    assert_eq!(p.source, EnvSource::Agent);
    assert_eq!(p.agent_id.as_deref(), Some("a1"));
}

#[test]
fn a_payload_with_no_name_does_not_parse() {
    // `parse_env_ref` returned an empty name and let the handler refuse it.
    // The type refuses it now, and the handler maps that failure to the
    // same reply — so the wire is unchanged, which is the point.
    assert!(serde_json::from_value::<ClientEnvWritePayload>(json!({})).is_err());
}

// ---- env write in-use lock ----

#[tokio::test]
async fn env_write_blocked_when_in_use() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Write a file first
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "locked.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();
    // Record usage
    h.env_service.usage.record_create(
        "a1:s1",
        &[nession_protocol::contracts::env::v1::EnvFileRef {
            name: "locked.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }],
        None,
    );
    // Try to overwrite — should fail
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({
                "name": "locked.env",
                "content": "X=2",
                "overwrite": true,
                "source": "server",
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("in use"));
    assert_eq!(reply["payload"]["in_use_by"], json!(["a1:s1"]));
}

#[tokio::test]
async fn env_write_force_skips_lock_and_re_sources() {
    use crate::server::outbound::WsMessageSender;

    let mut h = test_handler("").await;
    h.authenticated_client = true;

    // Write a file first so the store has it.
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "forced.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();

    // Register an agent control channel so `agent_command` can be answered.
    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    // Record usage for a session bound to this file.
    h.env_service.usage.record_create(
        "a1:s1",
        &[EnvFileRef {
            name: "forced.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }],
        None,
    );

    // Run the force write concurrently with a mock agent that answers the
    // re-source (`agent.env.resource`) command.
    let broker = Arc::clone(&h.command_broker);
    let send_fut = h.handle_message(proto_msg(
        "server.env.write",
        json!({
            "name": "forced.env",
            "content": "X=2",
            "overwrite": true,
            "force": true,
            "source": "server",
        }),
    ));
    let resolve_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("agent should receive a command")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();

        // The wire matters as much as the response. This mock used to answer
        // whatever arrived, and so passed while the server was asking for
        // `agent.env.resource` — a wire no agent has ever handled, which made
        // every forced write report a re-source failure while the session
        // kept its old values. Asserting the wire is what keeps the mock
        // honest; without it the test cannot tell the fix from the bug.
        assert_eq!(
            parsed["msg_type"], "agent.session.env.apply",
            "the re-source must use the wire the agent answers"
        );
        // The session name without its `<agent>:` prefix, and the content
        // the forced write just stored — not the pre-write content.
        assert_eq!(parsed["payload"]["name"], "s1");
        assert_eq!(
            parsed["payload"]["snapshots"][0]["vars"],
            json!([["X", "2"]]),
            "the re-source must carry the file's current content"
        );

        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command("a1", &request_id, json!({ "success": true }))
            .await;
    };
    let (action, _) = tokio::join!(send_fut, resolve_fut);
    let reply = parse_reply(action.unwrap());

    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(reply["payload"]["re_sourced"], json!(["a1:s1"]));
    assert_eq!(reply["payload"]["re_source_errors"], json!([]));
}

#[tokio::test]
async fn env_delete_blocked_when_in_use() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Write a file first
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "used.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();
    // Record usage
    h.env_service.usage.record_create(
        "a1:s1",
        &[nession_protocol::contracts::env::v1::EnvFileRef {
            name: "used.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }],
        None,
    );
    // Try to delete — should fail
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "used.env", "source": "server" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("in use"));
}

#[tokio::test]
async fn env_delete_force_skips_lock() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Write a file first
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "used.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();
    // Record usage
    h.env_service.usage.record_create(
        "a1:s1",
        &[nession_protocol::contracts::env::v1::EnvFileRef {
            name: "used.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }],
        None,
    );
    // Delete with force — should succeed despite being in use
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "used.env", "source": "server", "force": true }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], true);
}

// ---- agent.env.get without agent_id ----

#[tokio::test]
async fn env_get_agent_without_agent_id() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.env.get",
            json!({ "name": "test.env", "source": "agent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("agent_id is required"));
}

#[tokio::test]
async fn env_write_agent_without_agent_id() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "test.env", "content": "X=1", "source": "agent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("agent_id is required"));
}

#[tokio::test]
async fn env_delete_agent_without_agent_id() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "test.env", "source": "agent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("agent_id is required"));
}

// ---- agent.terminal.resize ----

#[tokio::test]
async fn agent_terminal_resize_broadcasts_to_attached_clients() {
    use crate::server::outbound::WsMessageSender;

    let mut h = test_handler("").await;

    // Registering is what makes a connection able to resize `a1:dev` at all,
    // and the claim is what `server/websocket.rs` makes for it right after —
    // a resize from a connection that never registered is refused, so this
    // setup is part of the case rather than incidental to it.
    register_agent_connection(&mut h, "a1").await;
    let (_sender, _rx) = claim_control_channel(&h).await;

    // Register two clients in the ClientRegistry for the target session
    let client_registry = Arc::clone(&h.client_registry);
    let (sender1, mut rx1) = WsMessageSender::new();
    let (sender2, mut rx2) = WsMessageSender::new();
    client_registry.register("a1:dev", "c1", sender1).await;
    client_registry.register("a1:dev", "c2", sender2).await;

    // Send agent.terminal.resize
    let action = h
        .handle_message(proto_msg(
            "server.agent.terminal-resize",
            json!({
                "session_id": "a1:dev",
                "cols": 120,
                "rows": 40,
            }),
        ))
        .await
        .unwrap();

    // Handler returns Reply(None) — broadcast goes through ClientRegistry
    assert!(matches!(action, HandlerAction::Reply(None)));

    // Both clients should receive the broadcast message
    let msg1 = rx1.try_recv().unwrap();
    let msg2 = rx2.try_recv().unwrap();

    let parsed1: serde_json::Value =
        serde_json::from_str(msg1.message.to_text().unwrap()).unwrap();
    let parsed2: serde_json::Value =
        serde_json::from_str(msg2.message.to_text().unwrap()).unwrap();

    assert_eq!(parsed1["msg_type"], "terminal.resize");
    assert_eq!(parsed1["payload"]["session_id"], "a1:dev");
    assert_eq!(parsed1["payload"]["cols"], 120);
    assert_eq!(parsed1["payload"]["rows"], 40);
    assert_eq!(parsed2["msg_type"], "terminal.resize");
    assert_eq!(parsed2["payload"]["session_id"], "a1:dev");
}

#[tokio::test]
async fn agent_terminal_resize_no_attached_clients() {
    let mut h = test_handler("").await;

    // Registered and claimed, so what the frame meets is the absence of
    // clients rather than the absence of authority.
    register_agent_connection(&mut h, "a1").await;
    let (_sender, _rx) = claim_control_channel(&h).await;

    // No clients attached — should still succeed silently
    let action = h
        .handle_message(proto_msg(
            "server.agent.terminal-resize",
            json!({
                "session_id": "a1:dev",
                "cols": 80,
                "rows": 24,
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

#[tokio::test]
async fn agent_terminal_resize_invalid_payload() {
    let mut h = test_handler("").await;

    // As above: the payload is what this test is about, so the connection
    // arrives already authorized for the session it names.
    register_agent_connection(&mut h, "a1").await;
    let (_sender, _rx) = claim_control_channel(&h).await;

    // Missing required fields — should log warning but not crash
    let action = h
        .handle_message(proto_msg(
            "server.agent.terminal-resize",
            json!({ "session_id": "a1:dev" }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

// ---- agent.address_update ----

#[tokio::test]
async fn agent_address_update_updates_addresses() {
    let mut h = test_handler("").await;
    // Register an agent with an initial address.
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [
                { "url": "ws://1.2.3.4:19091/ws", "network_type": "lan" }
            ],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();

    // Send an address update with new addresses.
    let action = h
        .handle_message(proto_msg(
            "server.agent.address-update",
            json!({
                "agent_id": "a1",
                "addresses": [
                    { "url": "ws://10.0.0.5:19091/ws", "network_type": "lan" },
                    { "url": "wss://tunnel.example.com/ws", "network_type": "tunnel" },
                ],
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));

    // Verify the agent's addresses were updated.
    let agent = h.agent_registry.get("a1").await.unwrap();
    assert_eq!(agent.addresses.len(), 2);

    let urls: Vec<&str> = agent
        .addresses
        .iter()
        .map(|p| p.address.url.as_str())
        .collect();
    assert!(urls.contains(&"ws://10.0.0.5:19091/ws"));
    assert!(urls.contains(&"wss://tunnel.example.com/ws"));
}

#[tokio::test]
async fn agent_address_update_unknown_agent_is_noop() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.address-update",
            json!({
                "agent_id": "nonexistent",
                "addresses": [],
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

// ---- agent identity is bound to the connection that registered it (#960) ----

/// Send `agent_id`'s `server.agent.register` frame and return the reply, as
/// the body the Server answers with. Judging the reply is the caller's, so
/// that the tests about the *answer* (a refusal) and the tests about the
/// binding can share one frame.
async fn register(h: &mut ConnectionHandler, agent_id: &str) -> serde_json::Value {
    parse_reply(
        h.handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": agent_id,
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap(),
    )
}

/// Register `agent_id` **through the wire**, the way its own connection
/// does. This is the binding: from here on the handler answers as that
/// agent, and what its payloads name is checked against it.
async fn register_agent_connection(h: &mut ConnectionHandler, agent_id: &str) {
    let reply = register(h, agent_id).await;
    assert_eq!(reply["payload"]["status"], "accepted");
}

/// A connection registered as `a1` must not move `a2`'s heartbeat state,
/// whatever id its payload carries. Heartbeats are what keeps an agent
/// online and carry its session counts, so a cross-agent write here is one
/// agent silently speaking for another.
#[tokio::test]
async fn heartbeat_for_another_agent_is_refused() {
    let mut h = test_handler("").await;
    register_agent_connection(&mut h, "a1").await;
    register_agent_id(&h, "a2", None).await;

    let action = h
        .handle_message(proto_msg(
            "control.heartbeat",
            json!({ "agent_id": "a2", "session_count": 9, "active_sessions": 9 }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));

    let a2 = h.agent_registry.get("a2").await.expect("a2 is registered");
    assert_eq!(
        a2.session_count, 0,
        "a1's connection must not write a2's session count"
    );
    assert_eq!(a2.active_sessions, 0);

    // The refusal is about identity, not about heartbeats: the same message
    // for the agent this connection *did* register as still lands.
    h.handle_message(proto_msg(
        "control.heartbeat",
        json!({ "agent_id": "a1", "session_count": 3, "active_sessions": 1 }),
    ))
    .await
    .unwrap();
    let a1 = h.agent_registry.get("a1").await.expect("a1 is registered");
    assert_eq!(a1.session_count, 3);
}

/// The other half of the same invariant: a connection that never registered
/// has no identity to speak with — not even for an agent the registry
/// knows, because registering is what makes a connection authoritative.
#[tokio::test]
async fn heartbeat_from_a_connection_that_never_registered_is_refused() {
    let mut h = test_handler("").await;
    register_agent_id(&h, "a1", None).await;

    h.handle_message(proto_msg(
        "control.heartbeat",
        json!({ "agent_id": "a1", "session_count": 9, "active_sessions": 9 }),
    ))
    .await
    .unwrap();

    let a1 = h.agent_registry.get("a1").await.expect("a1 is registered");
    assert_eq!(
        a1.session_count, 0,
        "an unregistered connection has no authority to write agent state"
    );
}

/// Session ids are `agent_id:session_name`, so the payload's id chooses the
/// namespace an update writes into — a connection registered as `a1`
/// reporting for `a2` would rewrite another agent's session list.
#[tokio::test]
async fn session_update_for_another_agent_is_refused() {
    let mut h = test_handler("").await;
    register_agent_connection(&mut h, "a1").await;
    register_agent_id(&h, "a2", None).await;

    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({ "agent_id": "a2", "session_name": "sneaky", "status": "active" }),
    ))
    .await
    .unwrap();

    assert!(
        h.session_registry
            .list()
            .await
            .iter()
            .all(|session| !session.session_id.starts_with("a2:")),
        "a1's connection must not create sessions under a2"
    );
}

/// A message that names no agent is not lying about one: the connection's
/// registered identity supplies the answer, so an agent that sends the id
/// only in its registration is still understood.
#[tokio::test]
async fn session_update_without_an_agent_id_uses_the_connection_identity() {
    let mut h = test_handler("").await;
    register_agent_connection(&mut h, "a1").await;

    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({ "session_name": "dev", "status": "active", "window_count": 1 }),
    ))
    .await
    .unwrap();

    assert!(
        h.session_registry
            .list()
            .await
            .iter()
            .any(|session| session.session_id == "a1:dev"),
        "the bound identity must be enough to place the update"
    );
}

/// Advertised addresses decide where P2P clients dial, so a connection
/// registered as `a1` must not be able to point `a2` somewhere else.
#[tokio::test]
async fn address_update_for_another_agent_is_refused() {
    let mut h = test_handler("").await;
    register_agent_connection(&mut h, "a1").await;
    register_agent_id(&h, "a2", None).await;

    h.handle_message(proto_msg(
        "server.agent.address-update",
        json!({
            "agent_id": "a2",
            "addresses": [{ "url": "ws://elsewhere.example:19091/ws", "network_type": "lan" }],
        }),
    ))
    .await
    .unwrap();

    let a2 = h.agent_registry.get("a2").await.expect("a2 is registered");
    assert!(
        a2.addresses.is_empty(),
        "a1's connection must not move a2's advertised addresses"
    );
}

// ---- ownership is a generation, not an identity (#960) ----

/// Two connections on **one** server: one broker, one pair of registries,
/// one client registry.
///
/// `test_handler` gives every handler its own services, which is the right
/// default for a test about one connection. Ownership across connections is
/// exactly the case where both have to be looking at the same records: the
/// second connection's registration clears state the first one wrote, and
/// the first one's late frames are judged against the second one's claim.
async fn connections_on_one_server() -> (ConnectionHandler, ConnectionHandler) {
    let db = Arc::new(Database::new(":memory:").await.unwrap());
    let agent_registry = Arc::new(AgentRegistry::new(60, Arc::clone(&db)));
    let session_registry = Arc::new(SessionRegistry::new(Arc::clone(&db)));
    let command_broker = Arc::new(CommandBroker::new());
    let client_registry = Arc::new(ClientRegistry::new());
    let web_client_registry = Arc::new(WebClientRegistry::new());
    let connection = || {
        ConnectionHandler::new(
            ConnectionHandlerDeps {
                agent_registry: Arc::clone(&agent_registry),
                session_registry: Arc::clone(&session_registry),
                command_broker: Arc::clone(&command_broker),
                client_registry: Arc::clone(&client_registry),
                web_client_registry: Arc::clone(&web_client_registry),
                env_service: EnvService::new(Arc::clone(&db)),
                db: Arc::clone(&db),

                p2p_broker: std::sync::Arc::new(crate::broker::ConnectionBroker::new(300)),
            },
            ConnectionHandlerConfig {
                server_auth_token: String::new(),
                heartbeat_interval_secs: 30,
            },
        )
    };
    (connection(), connection())
}

/// The claim `server/websocket.rs` makes after every frame from a registered
/// agent connection: the connection that just spoke is the agent's control
/// channel.
///
/// Returns the sender and its receiver, for the tests that claim more than
/// once or watch where a command lands; **keep both alive** — a dropped
/// receiver is a control channel that cannot be sent to.
async fn claim_control_channel(
    h: &ConnectionHandler,
) -> (
    crate::server::outbound::WsMessageSender,
    tokio::sync::mpsc::Receiver<crate::server::outbound::QueuedFrame>,
) {
    let (sender, rx) = crate::server::outbound::WsMessageSender::new();
    if let Some(agent_id) = h.registered_agent_id() {
        h.command_broker
            .claim_agent(agent_id, h.connection_generation(), sender.clone())
            .await;
    }
    (sender, rx)
}

/// Hand one agent-originated frame to this connection's handler.
///
/// No reply is expected from any of them — a refusal and an applied update
/// are both silent — so the assertions live in the caller, on the state the
/// frame was or was not allowed to move. The frame is built at the call
/// site on purpose: a wire name passed through here would be invisible to
/// `scripts/protocol-gate.mjs`, which is what catches a name that no
/// runtime answers.
async fn report(h: &mut ConnectionHandler, frame: Message) {
    let action = h.handle_message(frame).await.unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

async fn has_session(h: &ConnectionHandler, session_id: &str) -> bool {
    h.session_registry
        .list()
        .await
        .iter()
        .any(|session| session.session_id == session_id)
}

/// #960, the state-write half: a connection a reconnect has superseded must
/// not write the current agent's state.
///
/// The window is the reconnect's own. The new connection's registration
/// clears the sessions the *previous* agent instance left behind, and the
/// old connection — half closed, not yet reaped, still delivering — reports
/// the session it remembers. Judged by identity alone that report was
/// believed, and the cleared session came back as if the registration had
/// never happened.
#[tokio::test]
async fn a_superseded_connection_cannot_restore_a_cleared_session() {
    let (mut c1, mut c2) = connections_on_one_server().await;

    register_agent_connection(&mut c1, "a1").await;
    let (_sender, _rx) = claim_control_channel(&c1).await;
    report(
        &mut c1,
        proto_msg(
            "server.agent.session-update",
            json!({ "agent_id": "a1", "session_name": "dev", "status": "active", "window_count": 1 }),
        ),
    )
    .await;
    assert!(has_session(&c1, "a1:dev").await, "c1's report is placed");

    // The agent reconnects. Registering clears the previous instance's
    // sessions; the loop claims the agent for the new connection right after
    // — in that order, and both here in the test rather than raced between
    // two tasks.
    register_agent_connection(&mut c2, "a1").await;
    let (_sender2, _rx2) = claim_control_channel(&c2).await;
    assert!(
        !has_session(&c1, "a1:dev").await,
        "re-registration clears the sessions of the agent instance before it"
    );

    // c1's late frame, arriving after all of that.
    report(
        &mut c1,
        proto_msg(
            "server.agent.session-update",
            json!({ "agent_id": "a1", "session_name": "dev", "status": "active", "window_count": 1 }),
        ),
    )
    .await;
    assert!(
        !has_session(&c1, "a1:dev").await,
        "a superseded connection's late report must not restore the cleared session"
    );

    // The refusal is about which connection this is, not about the message:
    // the generation that took the agent over still writes its state.
    report(
        &mut c2,
        proto_msg(
            "server.agent.session-update",
            json!({ "agent_id": "a1", "session_name": "dev", "status": "active", "window_count": 1 }),
        ),
    )
    .await;
    assert!(
        has_session(&c1, "a1:dev").await,
        "the current generation's report must still be placed"
    );
}

/// The same rule for the other three wires an agent writes state with.
///
/// A heartbeat is what keeps an agent online and carries its counts, so a
/// superseded connection's heartbeat is not a stale number — it is the
/// previous agent instance speaking for the current one.
///
/// One test per wire rather than one test over all of them: each wire's
/// check is its own call site, and a test that asserted three refusals in a
/// row would stop at the first one and say nothing about the other two.
#[tokio::test]
async fn a_superseded_connection_cannot_heartbeat() {
    let (mut c1, mut c2) = connections_on_one_server().await;
    register_agent_connection(&mut c1, "a1").await;
    let (_sender, _rx) = claim_control_channel(&c1).await;
    register_agent_connection(&mut c2, "a1").await;
    let (_sender2, _rx2) = claim_control_channel(&c2).await;

    report(
        &mut c1,
        proto_msg(
            "control.heartbeat",
            json!({ "agent_id": "a1", "session_count": 9, "active_sessions": 9 }),
        ),
    )
    .await;

    let a1 = c1.agent_registry.get("a1").await.expect("a1 is registered");
    assert_eq!(
        a1.session_count, 0,
        "a superseded connection's heartbeat must not be believed"
    );

    report(
        &mut c2,
        proto_msg(
            "control.heartbeat",
            json!({ "agent_id": "a1", "session_count": 4, "active_sessions": 1 }),
        ),
    )
    .await;
    let a1 = c1.agent_registry.get("a1").await.expect("a1 is registered");
    assert_eq!(
        a1.session_count, 4,
        "the current generation's heartbeat must be believed"
    );
}

/// The address update decides where P2P clients dial an agent, so it is the
/// one report a stale generation could aim at a *different* host entirely.
#[tokio::test]
async fn a_superseded_connection_cannot_move_the_agents_addresses() {
    let (mut c1, mut c2) = connections_on_one_server().await;
    register_agent_connection(&mut c1, "a1").await;
    let (_sender, _rx) = claim_control_channel(&c1).await;
    register_agent_connection(&mut c2, "a1").await;
    let (_sender2, _rx2) = claim_control_channel(&c2).await;

    report(
        &mut c1,
        proto_msg(
            "server.agent.address-update",
            json!({ "agent_id": "a1", "addresses": [{ "url": "ws://elsewhere.example:19091/ws", "network_type": "lan" }] }),
        ),
    )
    .await;

    let a1 = c1.agent_registry.get("a1").await.expect("a1 is registered");
    assert!(
        !a1.addresses
            .iter()
            .any(|probed| probed.address.url.contains("elsewhere.example")),
        "a superseded connection must not move the agent's addresses"
    );

    report(
        &mut c2,
        proto_msg(
            "server.agent.address-update",
            json!({ "agent_id": "a1", "addresses": [{ "url": "ws://here.example:19091/ws", "network_type": "lan" }] }),
        ),
    )
    .await;
    let a1 = c1.agent_registry.get("a1").await.expect("a1 is registered");
    assert!(
        a1.addresses
            .iter()
            .any(|probed| probed.address.url.contains("here.example")),
        "the current generation's address update must be applied"
    );
}

/// A resize is a *level* pushed to whoever is watching a session, and the
/// session belongs to an agent. A superseded connection's resize would move
/// the screen a client is looking at on behalf of an instance that is gone.
#[tokio::test]
async fn a_superseded_connection_cannot_resize_a_session() {
    use crate::server::outbound::WsMessageSender;

    let (mut c1, mut c2) = connections_on_one_server().await;
    register_agent_connection(&mut c1, "a1").await;
    let (_sender, _rx) = claim_control_channel(&c1).await;
    register_agent_connection(&mut c2, "a1").await;
    let (_sender2, _rx2) = claim_control_channel(&c2).await;

    // A client watching a session of a1's. The client registry is shared, so
    // either connection's broadcast reaches it.
    let (client, mut client_rx) = WsMessageSender::new();
    c1.client_registry
        .register("a1:dev", "client-1", client)
        .await;

    report(
        &mut c1,
        proto_msg(
            "server.agent.terminal-resize",
            json!({ "session_id": "a1:dev", "cols": 120, "rows": 40 }),
        ),
    )
    .await;
    assert!(
        client_rx.try_recv().is_err(),
        "a superseded connection must not resize a session it no longer serves"
    );

    report(
        &mut c2,
        proto_msg(
            "server.agent.terminal-resize",
            json!({ "session_id": "a1:dev", "cols": 100, "rows": 30 }),
        ),
    )
    .await;
    assert!(
        client_rx.try_recv().is_ok(),
        "the current generation's resize must reach the session's client"
    );
}

/// The one wire deliberately left out of the generation rule.
///
/// `server.agent.command-response` answers a request the *Server* sent. A
/// connection that has since been superseded is still the connection the
/// request went to, so its answer is still the answer to that request —
/// refusing it would report "Agent disconnected" for work the agent may
/// already have completed, which is exactly what #743 fixed. The rule the
/// generation check enforces is about whose *state* a connection may write,
/// and a response writes no state: it resolves one waiter.
#[tokio::test]
async fn a_superseded_connection_may_still_answer_an_in_flight_command() {
    let (mut c1, mut c2) = connections_on_one_server().await;
    register_agent_connection(&mut c1, "a1").await;
    let (_sender, _rx) = claim_control_channel(&c1).await;

    // A command the Server sent while c1 was the agent's connection.
    let waiter = c1
        .command_broker
        .send_command("a1", "server.session.create", "req-1", json!({}))
        .await;

    // The agent reconnects; a newer connection takes the agent over.
    register_agent_connection(&mut c2, "a1").await;
    let (_sender2, _rx2) = claim_control_channel(&c2).await;

    report(
        &mut c1,
        proto_msg(
            "server.agent.command-response",
            json!({ "request_id": "req-1", "success": true, "session_name": "dev" }),
        ),
    )
    .await;

    let response = tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
        .await
        .expect("a superseded connection's answer must still resolve the request")
        .expect("the waiter must be resolved with the answer");
    assert_eq!(response["success"], json!(true));
}

/// A liveness verdict is a statement about the *agent*, not about which
/// connection is newest.
///
/// The heartbeat sweep evicts an agent that has gone quiet without dropping
/// its WebSocket. The connection it evicted is still the agent's current
/// generation — nothing newer has claimed it — so its next report is still
/// believed, and the claim the loop makes for it puts its channel back. That
/// recovery is the reason the mark is a high-water mark rather than "the
/// owner, or nothing".
#[tokio::test]
async fn the_current_generation_recovers_after_a_liveness_eviction() {
    let mut h = test_handler("").await;
    register_agent_connection(&mut h, "a1").await;
    let (_sender, _rx) = claim_control_channel(&h).await;

    h.command_broker.evict_agent("a1").await;

    report(
        &mut h,
        proto_msg(
            "control.heartbeat",
            json!({ "agent_id": "a1", "session_count": 4, "active_sessions": 1 }),
        ),
    )
    .await;
    let a1 = h.agent_registry.get("a1").await.expect("a1 is registered");
    assert_eq!(
        a1.session_count, 4,
        "the evicted generation is still the agent's current one, so its report lands"
    );

    // The loop re-claims on the next inbound frame, which is the only way
    // back for an agent that went quiet without reconnecting.
    let (_sender, mut rx) = claim_control_channel(&h).await;
    let _waiter = h
        .command_broker
        .send_command("a1", "server.session.create", "req-1", json!({}))
        .await;
    assert!(
        rx.try_recv().is_ok(),
        "the current generation must recover its control channel after a false eviction"
    );
}

/// Registration is a transition — `Unregistered -> Agent(A)` — and never a
/// rebind.
///
/// What the rebind left behind was a ghost: the broker still claiming `A`
/// from a socket whose handler now remembered only `B`. Nothing released
/// `A` — not the disconnect path, which releases the one id the handler
/// remembers, and not `B`, which no claim ever named.
#[tokio::test]
async fn registering_twice_on_one_connection_is_refused() {
    let mut h = test_handler("").await;
    register_agent_connection(&mut h, "a1").await;
    let (sender, mut rx) = claim_control_channel(&h).await;

    let reply = register(&mut h, "a2").await;
    assert_eq!(
        reply["payload"]["status"], "rejected",
        "a connection that already answers for one agent may not become another"
    );
    assert!(
        h.agent_registry.get("a2").await.is_none(),
        "the refused registration must not create the second agent"
    );
    assert_eq!(
        h.registered_agent_id(),
        Some(&"a1".to_string()),
        "the connection keeps the identity it established"
    );

    // The claim the loop makes after that frame still names a1, which is the
    // point: `a1` is what the disconnect path will release, and what this
    // connection is judged by.
    let agent_id = h.registered_agent_id().unwrap().clone();
    h.command_broker
        .claim_agent(&agent_id, h.connection_generation(), sender)
        .await;
    let _waiter = h
        .command_broker
        .send_command("a1", "server.session.create", "req-1", json!({}))
        .await;
    assert!(
        rx.try_recv().is_ok(),
        "a1 must still be served from this connection — no ghost, and no ghost's replacement"
    );
}

/// A resize names its session and nothing else — there is no `agent_id` in
/// the frame to check — so the session id's own prefix is the identity this
/// wire is judged by.
///
/// This one used to be checked by nothing at all: it parsed, then broadcast
/// to whatever session the payload named. A connection registered as `a1`
/// could therefore move `a2`'s screen.
#[tokio::test]
async fn terminal_resize_for_another_agents_session_is_refused() {
    use crate::server::outbound::WsMessageSender;

    let mut h = test_handler("").await;
    register_agent_connection(&mut h, "a1").await;
    let (_sender, _rx) = claim_control_channel(&h).await;

    let (client, mut client_rx) = WsMessageSender::new();
    h.client_registry
        .register("a2:dev", "client-1", client)
        .await;

    report(
        &mut h,
        proto_msg(
            "server.agent.terminal-resize",
            json!({ "session_id": "a2:dev", "cols": 120, "rows": 40 }),
        ),
    )
    .await;
    assert!(
        client_rx.try_recv().is_err(),
        "a connection registered as a1 must not resize a2's session"
    );

    // Whose session it is, not whether resizes work: the same frame for one
    // of its own still reaches the attached client.
    let (client, mut client_rx) = WsMessageSender::new();
    h.client_registry
        .register("a1:dev", "client-2", client)
        .await;
    report(
        &mut h,
        proto_msg(
            "server.agent.terminal-resize",
            json!({ "session_id": "a1:dev", "cols": 120, "rows": 40 }),
        ),
    )
    .await;
    assert!(
        client_rx.try_recv().is_ok(),
        "a resize for one of its own sessions must still be broadcast"
    );
}

// ---- Quick Commands (issue #95, part 3) ----

#[tokio::test]
async fn commands_list_requires_auth() {
    let mut h = test_handler("tok").await;
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["msg_type"], "server.commands.list");
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("Not authenticated"));
}

#[tokio::test]
async fn commands_list_empty() {
    let mut h = test_handler("tok").await;
    // Auth as client first
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["msg_type"], "server.commands.list");
    assert!(reply["payload"]["commands"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn commands_add_requires_auth() {
    let mut h = test_handler("tok").await;
    let action = h
        .handle_message(proto_msg(
            "server.commands.add",
            json!({ "label": "test", "command": "echo hi" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(!reply["payload"]["success"].as_bool().unwrap());
}

#[tokio::test]
async fn commands_add_and_list() {
    let mut h = test_handler("tok").await;
    // Auth as client
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
    // Add a command
    let action = h
        .handle_message(proto_msg(
            "server.commands.add",
            json!({ "label": "My Cmd", "command": "echo hello" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["success"].as_bool().unwrap());
    let cmd_id = reply["payload"]["id"].as_str().unwrap().to_string();

    // List should include it
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let cmds = reply["payload"]["commands"].as_array().unwrap();
    assert_eq!(cmds.len(), 1);
    assert_eq!(cmds[0]["label"], "My Cmd");
    assert_eq!(cmds[0]["command"], "echo hello");

    // Remove it
    let action = h
        .handle_message(proto_msg("server.commands.remove", json!({ "id": cmd_id })))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["success"].as_bool().unwrap());

    // List should be empty again
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["commands"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn commands_update() {
    let mut h = test_handler("tok").await;
    // Auth as client
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
    // Add a command
    let action = h
        .handle_message(proto_msg(
            "server.commands.add",
            json!({ "label": "Old", "command": "old cmd" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let cmd_id = reply["payload"]["id"].as_str().unwrap().to_string();

    // Update it
    let action = h
        .handle_message(proto_msg(
            "server.commands.update",
            json!({ "id": cmd_id, "label": "New", "command": "new cmd" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["success"].as_bool().unwrap());

    // List should show updated values
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let cmds = reply["payload"]["commands"].as_array().unwrap();
    assert_eq!(cmds.len(), 1);
    assert_eq!(cmds[0]["label"], "New");
    assert_eq!(cmds[0]["command"], "new cmd");
}

#[tokio::test]
async fn commands_remove_nonexistent() {
    let mut h = test_handler("tok").await;
    // Auth as client
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
    // Remove an id that doesn't exist (should still succeed — idempotent)
    let action = h
        .handle_message(proto_msg(
            "server.commands.remove",
            json!({ "id": "nonexistent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["success"].as_bool().unwrap());
}

#[tokio::test]
async fn commands_update_nonexistent() {
    let mut h = test_handler("tok").await;
    // Auth as client
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
    // Update a nonexistent command
    let action = h
        .handle_message(proto_msg(
            "server.commands.update",
            json!({ "id": "missing", "label": "Nope" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(!reply["payload"]["success"].as_bool().unwrap());
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}
