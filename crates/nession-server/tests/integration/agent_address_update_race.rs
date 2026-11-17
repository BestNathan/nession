//! #3723 source-aligned runtime Case: an address update is fenced by the same
//! per-Agent registration gate as registration, and applies only the intended
//! address fields to the current row.
//!
//! The tests drive the real handlers, registries, broker and SQLite. The
//! interleavings are ordered by the production gates, not by wall-clock sleeps.

use std::sync::Arc;
use std::task::Poll;

use nession_runtime::frame::WsFrame;
use nession_server::db::Database;
use nession_server::env::EnvService;
use nession_server::registry::agent::{AgentInfo, AgentRegistry};
use nession_server::registry::session::SessionRegistry;
use nession_server::server::client_registry::ClientRegistry;
use nession_server::server::command_broker::CommandBroker;
use nession_server::server::{
    ConnectionHandler, ConnectionHandlerConfig, ConnectionHandlerDeps, HandlerAction,
    WebClientRegistry,
};
use serde_json::Value;

const AGENT_ID: &str = "a1";
const FIRST_URL: &str = "ws://10.0.0.1:19091/ws";
const SECOND_URL: &str = "ws://10.0.0.9:19091/ws";

struct Fixture {
    db: Arc<Database>,
    agents: Arc<AgentRegistry>,
    sessions: Arc<SessionRegistry>,
    env: Arc<EnvService>,
    web: Arc<WebClientRegistry>,
    broker: Arc<CommandBroker>,
}

async fn fixture() -> anyhow::Result<Fixture> {
    let db = Arc::new(Database::new(":memory:").await?);
    Ok(Fixture {
        agents: Arc::new(AgentRegistry::new(60, Arc::clone(&db))),
        sessions: Arc::new(SessionRegistry::new(Arc::clone(&db))),
        env: EnvService::new(Arc::clone(&db)),
        web: Arc::new(WebClientRegistry::new()),
        broker: Arc::new(CommandBroker::new()),
        db,
    })
}

fn image_manager(db: Arc<Database>) -> anyhow::Result<Arc<nession_server::image::ImageManager>> {
    Ok(Arc::new(nession_server::image::ImageManager::unavailable(
        db,
        std::env::temp_dir().join(format!("nession-image-test-{}", uuid::Uuid::new_v4())),
    )?))
}

fn config() -> ConnectionHandlerConfig {
    ConnectionHandlerConfig {
        server_auth_token: "secret".to_string(),
        heartbeat_interval_secs: 30,
        terminal_cols: nession_common::config::DEFAULT_TERMINAL_COLS,
        terminal_web_font_size: nession_common::config::DEFAULT_TERMINAL_WEB_FONT_SIZE,
        mcp_enabled: false,
        mcp_path: "/mcp".to_string(),
    }
}

impl Fixture {
    fn handler_deps(&self) -> anyhow::Result<ConnectionHandlerDeps> {
        Ok(ConnectionHandlerDeps {
            agent_registry: Arc::clone(&self.agents),
            session_registry: Arc::clone(&self.sessions),
            command_broker: Arc::clone(&self.broker),
            client_registry: Arc::new(ClientRegistry::new()),
            web_client_registry: Arc::clone(&self.web),
            env_service: Arc::clone(&self.env),
            image_manager: image_manager(Arc::clone(&self.db))?,
            db: Arc::clone(&self.db),
        })
    }

    /// One unauthenticated Agent connection; registration carries its own auth.
    fn agent(&self) -> anyhow::Result<ConnectionHandler> {
        Ok(ConnectionHandler::new(self.handler_deps()?, config()))
    }

    async fn current(&self) -> anyhow::Result<AgentInfo> {
        self.agents
            .get(AGENT_ID)
            .await
            .ok_or_else(|| anyhow::anyhow!("Agent {AGENT_ID} is registered"))
    }

    async fn persisted(&self) -> anyhow::Result<nession_server::db::AgentRow> {
        self.db
            .list_agents()
            .await?
            .into_iter()
            .find(|row| row.agent_id == AGENT_ID)
            .ok_or_else(|| anyhow::anyhow!("Agent {AGENT_ID} is persisted"))
    }
}

fn text_message(msg_type: &str, payload: Value) -> WsFrame {
    WsFrame::Text(
        serde_json::json!({
            "msg_type": msg_type,
            "id": format!("{msg_type}-test"),
            "timestamp": 0,
            "payload": payload,
        })
        .to_string(),
    )
}

fn parse_reply(action: HandlerAction) -> anyhow::Result<Value> {
    match action {
        HandlerAction::Reply(Some(WsFrame::Text(text))) => Ok(serde_json::from_str(&text)?),
        _ => anyhow::bail!("expected Reply(Some(Text))"),
    }
}

fn status(reply: &Value) -> Option<&str> {
    reply.get("payload")?.get("status")?.as_str()
}

async fn register(agent: &mut ConnectionHandler, token: &str, url: &str) -> anyhow::Result<()> {
    let reply = parse_reply(
        agent
            .handle_message(text_message(
                "server.agent.register",
                serde_json::json!({
                    "agent_id": AGENT_ID,
                    "hostname": "host-1",
                    "ip_address": "10.0.0.1",
                    "port": 19091,
                    "auth_token": "secret",
                    "agent_token": token,
                    "protocol_manifest": {
                        "provider": "test-agent",
                        "protocols": {
                            "git.status": { "versions": [1], "wire": ["git.status"] }
                        }
                    },
                    "addresses": [{ "url": url, "network_type": "lan" }],
                    "connect_url": null,
                    "metadata": {
                        "tmux_version": "3.3",
                        "os_version": "linux",
                        "nession_version": "0.1"
                    }
                }),
            ))
            .await?,
    )?;
    anyhow::ensure!(
        status(&reply) == Some("accepted"),
        "registration must be accepted: {reply}"
    );
    Ok(())
}

async fn address_update(agent: &mut ConnectionHandler, url: &str) -> anyhow::Result<()> {
    agent
        .handle_message(text_message(
            "server.agent.address-update",
            serde_json::json!({
                "agent_id": AGENT_ID,
                "addresses": [{ "url": url, "network_type": "lan" }],
            }),
        ))
        .await?;
    Ok(())
}

/// SC-01: the fence itself refuses a superseded generation and admits the
/// current one without raising the high-water mark.
#[tokio::test]
async fn sc01_the_fence_refuses_a_superseded_generation() -> anyhow::Result<()> {
    let f = fixture().await?;
    let stale = f.broker.new_connection_generation();
    let current = f.broker.new_connection_generation();
    let registration = f
        .broker
        .begin_registration(AGENT_ID, current)
        .await
        .ok_or_else(|| anyhow::anyhow!("the newer generation registers"))?;
    drop(registration);

    assert!(
        f.broker
            .begin_address_update(AGENT_ID, stale)
            .await
            .is_none(),
        "a superseded generation must be refused before any registry write"
    );
    let guard = f
        .broker
        .begin_address_update(AGENT_ID, current)
        .await
        .ok_or_else(|| anyhow::anyhow!("the current generation may update"))?;
    assert!(
        f.broker.is_current_generation(AGENT_ID, current).await,
        "an update must not raise the registration high-water mark"
    );
    drop(guard);
    Ok(())
}

/// SC-01: an address update is a fenced read-modify-write. With the per-Agent
/// registration gate held (an in-flight registration transition), the update
/// must wait at the gate instead of reading and publishing around it.
///
/// `begin_deletion` is the public way to hold that same gate without owning a
/// connection generation; it does not mutate the Agent.
#[tokio::test]
async fn sc01_an_address_update_waits_for_the_registration_gate() -> anyhow::Result<()> {
    let f = fixture().await?;
    let mut agent = f.agent()?;
    register(&mut agent, "token-one", FIRST_URL).await?;

    let gate = f.broker.begin_deletion(AGENT_ID).await;
    let mut update = Box::pin(agent.handle_message(text_message(
        "server.agent.address-update",
        serde_json::json!({
            "agent_id": AGENT_ID,
            "addresses": [{ "url": SECOND_URL, "network_type": "lan" }],
        }),
    )));

    assert!(
        matches!(futures_util::poll!(update.as_mut()), Poll::Pending),
        "the update must wait for the Agent's registration gate"
    );

    drop(gate);
    update.await?;

    let current = f.current().await?;
    assert_eq!(
        current.addresses.first().map(|a| a.address.url.as_str()),
        Some(SECOND_URL),
        "the update applies after the gate is released"
    );
    Ok(())
}

/// SC-01: with C2's newer registration complete, C1's resumed address update
/// cannot change C2's addresses, Agent Token, manifest or persisted address.
#[tokio::test]
async fn sc01_a_superseded_update_cannot_overwrite_the_successor() -> anyhow::Result<()> {
    let f = fixture().await?;
    let mut c1 = f.agent()?;
    let mut c2 = f.agent()?;
    register(&mut c1, "token-one", FIRST_URL).await?;
    register(&mut c2, "token-two", SECOND_URL).await?;

    let before = f.current().await?;

    // C1's frame was authorized against its own registration; by the time it
    // resumes, C2 owns the Agent. It must not write at all.
    address_update(&mut c1, "ws://stale.example:19091/ws").await?;

    let after = f.current().await?;
    assert_eq!(
        after
            .agent_token
            .as_ref()
            .map(nession_protocol::SecretString::as_str),
        Some("token-two"),
        "the stale update must not restore the superseded Token"
    );
    assert_eq!(
        after.addresses.first().map(|a| a.address.url.as_str()),
        Some(SECOND_URL)
    );
    assert_eq!(after.protocol_manifest, before.protocol_manifest);
    assert_eq!(after.registered_at, before.registered_at);
    assert_eq!(after.last_heartbeat, before.last_heartbeat);
    assert!(after
        .addresses
        .iter()
        .all(|a| a.address.url != "ws://stale.example:19091/ws"));

    let persisted = f.persisted().await?;
    assert!(
        persisted.addresses.contains(SECOND_URL),
        "C2's persisted address must survive: {}",
        persisted.addresses
    );
    assert!(
        !persisted.addresses.contains("ws://stale.example:19091/ws"),
        "the stale address must not be persisted: {}",
        persisted.addresses
    );
    Ok(())
}

/// SC-01: the current generation's update still succeeds.
#[tokio::test]
async fn sc01_the_current_generation_can_still_update_its_addresses() -> anyhow::Result<()> {
    let f = fixture().await?;
    let mut agent = f.agent()?;
    register(&mut agent, "token-one", FIRST_URL).await?;

    address_update(&mut agent, SECOND_URL).await?;

    let current = f.current().await?;
    assert_eq!(
        current.addresses.first().map(|a| a.address.url.as_str()),
        Some(SECOND_URL)
    );
    assert_eq!(current.ip_address, "10.0.0.9");
    let persisted = f.persisted().await?;
    assert!(persisted.addresses.contains(SECOND_URL));
    assert_eq!(persisted.ip_address, "10.0.0.9");
    Ok(())
}

/// SC-02: a normal update changes only addresses and their persistence. The
/// Token, manifest, timestamps, status, session counts, display name and
/// generations remain the registration's.
#[tokio::test]
async fn sc02_a_current_update_changes_only_addresses() -> anyhow::Result<()> {
    let f = fixture().await?;
    let mut agent = f.agent()?;
    register(&mut agent, "token-one", FIRST_URL).await?;

    let before = f.current().await?;
    let persisted_before = f.persisted().await?;

    address_update(&mut agent, SECOND_URL).await?;

    let after = f.current().await?;
    assert_eq!(
        after.addresses.first().map(|a| a.address.url.as_str()),
        Some(SECOND_URL)
    );
    assert_eq!(after.ip_address, "10.0.0.9");
    assert_eq!(after.agent_token, before.agent_token);
    assert_eq!(after.protocol_manifest, before.protocol_manifest);
    assert_eq!(after.hostname, before.hostname);
    assert_eq!(after.port, before.port);
    assert_eq!(after.display_name, before.display_name);
    assert_eq!(after.connect_url, before.connect_url);
    assert_eq!(after.registered_at, before.registered_at);
    assert_eq!(after.last_heartbeat, before.last_heartbeat);
    assert_eq!(after.status, before.status);
    assert_eq!(after.session_count, before.session_count);
    assert_eq!(after.active_sessions, before.active_sessions);
    assert_eq!(after.probe_generation, before.probe_generation);
    assert_eq!(after.offline_generation, before.offline_generation);

    let persisted_after = f.persisted().await?;
    assert_eq!(persisted_after.ip_address, "10.0.0.9");
    assert!(persisted_after.addresses.contains(SECOND_URL));
    assert!(!persisted_after.addresses.contains(FIRST_URL));
    assert_eq!(persisted_after.hostname, persisted_before.hostname);
    assert_eq!(persisted_after.port, persisted_before.port);
    assert_eq!(
        persisted_after.registered_at,
        persisted_before.registered_at
    );
    assert_eq!(
        persisted_after.last_heartbeat,
        persisted_before.last_heartbeat
    );
    assert_eq!(persisted_after.status, persisted_before.status);
    assert_eq!(persisted_after.metadata, persisted_before.metadata);
    assert_eq!(persisted_after.display_name, persisted_before.display_name);
    assert_eq!(persisted_after.connect_url, persisted_before.connect_url);
    Ok(())
}
