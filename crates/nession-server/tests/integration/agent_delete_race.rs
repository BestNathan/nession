//! #3067 source-aligned runtime Cases: client-initiated Agent deletion is
//! ordered against registration and heartbeat recovery for the same Agent id.
//!
//! The tests drive the real handlers, registries, broker and SQLite. The
//! interleavings are ordered by the same per-Agent gates production takes, not
//! by wall-clock sleeps.

use std::sync::Arc;

use chrono::Utc;
use nession_protocol::contracts::agent::v1::AgentMetadata;
use nession_protocol::contracts::env::v1::SessionEnvObservedState;
use nession_server::db::Database;
use nession_server::env::{BindingRecord, EnvService};
use nession_server::registry::agent::{AgentDeleteClaim, AgentInfo, AgentRegistry, AgentStatus};
use nession_server::registry::session::{SessionInfo, SessionRegistry, SessionStatus};
use nession_server::server::client_registry::ClientRegistry;
use nession_server::server::command_broker::CommandBroker;
use nession_server::server::{
    ConnectionHandler, ConnectionHandlerConfig, ConnectionHandlerDeps, HandlerAction,
    WebClientRegistry,
};
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

const AGENT_ID: &str = "a1";

struct Fixture {
    _db_dir: tempfile::TempDir,
    db: Arc<Database>,
    agents: Arc<AgentRegistry>,
    sessions: Arc<SessionRegistry>,
    env: Arc<EnvService>,
    web: Arc<WebClientRegistry>,
    broker: Arc<CommandBroker>,
}

async fn fixture() -> anyhow::Result<Fixture> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("server.db").to_string_lossy().into_owned();
    let db = Arc::new(Database::new(&path).await?);
    Ok(Fixture {
        _db_dir: dir,
        agents: Arc::new(AgentRegistry::new(1, Arc::clone(&db))),
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
            p2p_broker: Arc::new(nession_server::broker::ConnectionBroker::new(300)),
        })
    }

    /// One authenticated Web client on this Server.
    async fn client(&self) -> anyhow::Result<ConnectionHandler> {
        let mut handler = ConnectionHandler::new(self.handler_deps()?, config());
        let reply = parse_reply(
            handler
                .handle_message(text_message(
                    "server.auth",
                    serde_json::json!({ "auth_token": "secret" }),
                ))
                .await?,
        )?;
        anyhow::ensure!(
            status(&reply) == Some("success"),
            "client auth must succeed: {reply}"
        );
        Ok(handler)
    }

    /// One unauthenticated Agent connection; registration carries its own auth.
    fn agent(&self) -> anyhow::Result<ConnectionHandler> {
        Ok(ConnectionHandler::new(self.handler_deps()?, config()))
    }
}

fn text_message(msg_type: &str, payload: Value) -> Message {
    Message::Text(
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
        HandlerAction::Reply(Some(Message::Text(text))) => Ok(serde_json::from_str(&text)?),
        _ => anyhow::bail!("expected Reply(Some(Text))"),
    }
}

fn status(reply: &Value) -> Option<&str> {
    reply.get("payload")?.get("status")?.as_str()
}

fn success(reply: &Value) -> Option<bool> {
    reply.get("payload")?.get("success")?.as_bool()
}

fn error(reply: &Value) -> Option<&str> {
    reply.get("payload")?.get("error")?.as_str()
}

fn register_payload(agent_id: &str) -> Value {
    serde_json::json!({
        "agent_id": agent_id,
        "hostname": "host-1",
        "ip_address": "10.0.0.1",
        "port": 19091,
        "auth_token": "secret",
        "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
        "addresses": [],
        "connect_url": null,
        "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" }
    })
}

fn delete_payload(agent_id: &str) -> Value {
    serde_json::json!({ "agent_id": agent_id })
}

fn agent_info(agent_id: &str, last_heartbeat: chrono::DateTime<Utc>) -> AgentInfo {
    AgentInfo {
        agent_id: agent_id.to_string(),
        hostname: format!("host-{agent_id}"),
        ip_address: "10.0.0.1".to_string(),
        port: 19091,
        display_name: None,
        connect_url: None,
        addresses: vec![],
        registered_at: last_heartbeat,
        last_heartbeat,
        status: AgentStatus::Online,
        metadata: AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "linux".to_string(),
            nession_version: "0.1".to_string(),
            image_tag: "test".to_string(),
        },
        session_count: 0,
        active_sessions: 0,
        protocol_manifest: None,
        probe_generation: 0,
        offline_generation: 0,
    }
}

/// Register an Agent whose heartbeat is already past the registry's timeout,
/// then open its offline episode deterministically.
async fn offline_agent(agents: &AgentRegistry, agent_id: &str) {
    agents
        .register(agent_info(
            agent_id,
            Utc::now() - chrono::Duration::seconds(60),
        ))
        .await;
    let transitions = agents.check_offline_agents().await;
    assert!(
        transitions
            .iter()
            .any(|transition| transition.agent_id == agent_id),
        "the fixture must open an offline episode for {agent_id}"
    );
    assert_eq!(
        agents.get(agent_id).await.map(|agent| agent.status),
        Some(AgentStatus::Offline)
    );
}

async fn add_session_with_binding(
    f: &Fixture,
    agent_id: &str,
    name: &str,
) -> anyhow::Result<String> {
    let session = SessionInfo {
        session_id: format!("{agent_id}:{name}"),
        agent_id: agent_id.to_string(),
        session_name: name.to_string(),
        status: SessionStatus::Active,
        window_count: 1,
        attached_clients: 0,
        foreground_command: None,
        working_dir: None,
        instance_id: None,
        created_at: Utc::now(),
        last_activity: Utc::now(),
    };
    let session_id = session.session_id.clone();
    f.sessions.update_session(session).await;
    f.env
        .bindings
        .put(&BindingRecord::empty(&session_id, agent_id))
        .await?;
    f.env.observed.set(
        &session_id,
        SessionEnvObservedState {
            applied_revision: 0,
            status: "in_sync".to_string(),
            profiles: vec![],
            managed_keys: vec![],
            shell: None,
            shell_revision: None,
            last_error: None,
        },
    );
    Ok(session_id)
}

async fn assert_agent_gone(f: &Fixture) -> anyhow::Result<()> {
    anyhow::ensure!(
        f.agents.get(AGENT_ID).await.is_none(),
        "registry entry removed"
    );
    anyhow::ensure!(
        f.db.list_agents()
            .await?
            .iter()
            .all(|row| row.agent_id != AGENT_ID),
        "SQLite Agent row removed"
    );
    anyhow::ensure!(
        f.sessions
            .list()
            .await
            .iter()
            .all(|session| session.agent_id != AGENT_ID),
        "in-memory Sessions removed"
    );
    anyhow::ensure!(
        f.db.list_all_sessions()
            .await?
            .iter()
            .all(|row| row.agent_id != AGENT_ID),
        "SQLite Session rows removed"
    );
    Ok(())
}

fn agent_row_exists(rows: &[nession_server::db::AgentRow]) -> bool {
    rows.iter().any(|row| row.agent_id == AGENT_ID)
}

/// SC-01: a registration that completed before the deletion commit makes the
/// pending deletion refuse truthfully.
#[tokio::test]
async fn sc01_registration_that_completed_first_is_not_erased() -> anyhow::Result<()> {
    let f = fixture().await?;
    let mut agent = f.agent()?;
    let accepted = parse_reply(
        agent
            .handle_message(text_message(
                "server.agent.register",
                register_payload(AGENT_ID),
            ))
            .await?,
    )?;
    assert_eq!(status(&accepted), Some("accepted"));
    let session = add_session_with_binding(&f, AGENT_ID, "dev").await?;

    let mut client = f.client().await?;
    let deleted = parse_reply(
        client
            .handle_message(text_message(
                "server.agent.delete",
                delete_payload(AGENT_ID),
            ))
            .await?,
    )?;
    assert_eq!(success(&deleted), Some(false));
    assert!(
        error(&deleted)
            .is_some_and(|message| message.contains("only offline agents can be deleted")),
        "the refusal must name the online precondition: {deleted}"
    );
    let current = f
        .agents
        .get(AGENT_ID)
        .await
        .ok_or_else(|| anyhow::anyhow!("the Agent must survive"))?;
    assert_eq!(current.status, AgentStatus::Online);
    assert!(
        agent_row_exists(&f.db.list_agents().await?),
        "the newly registered SQLite row must survive the refused deletion"
    );
    assert!(
        f.sessions.get(&session).await.is_some(),
        "the newly registered Agent's Session must survive"
    );
    Ok(())
}

/// SC-01: with the deletion claim held, a concurrent registration is ordered
/// behind it and applies only after the deletion has finished.
#[tokio::test]
async fn sc01_deletion_claim_orders_a_concurrent_registration() -> anyhow::Result<()> {
    let f = fixture().await?;
    offline_agent(&f.agents, AGENT_ID).await;

    // The handler takes the broker gate, then the registry liveness gate,
    // before any destructive write. Hold the same pair here and prove a
    // registration is parked at the broker gate.
    let registration_order = f.broker.begin_deletion(AGENT_ID).await;
    let deletion = match f.agents.begin_agent_deletion(AGENT_ID).await {
        AgentDeleteClaim::Claimed(guard) => guard,
        _ => anyhow::bail!("an Offline Agent must be claimable for deletion"),
    };

    let mut agent = f.agent()?;
    let mut register = Box::pin(agent.handle_message(text_message(
        "server.agent.register",
        register_payload(AGENT_ID),
    )));
    assert!(
        matches!(
            futures_util::poll!(register.as_mut()),
            std::task::Poll::Pending
        ),
        "the registration must wait while the deletion claim is held"
    );

    drop(deletion);
    drop(registration_order);
    let accepted = parse_reply(register.await?)?;
    assert_eq!(status(&accepted), Some("accepted"));
    let current = f
        .agents
        .get(AGENT_ID)
        .await
        .ok_or_else(|| anyhow::anyhow!("registered Agent"))?;
    assert_eq!(current.status, AgentStatus::Online);
    assert!(
        agent_row_exists(&f.db.list_agents().await?),
        "the post-delete registration's SQLite row is present"
    );
    Ok(())
}

/// SC-02: an Agent that stays Offline is fully deletable, and the same process
/// can register normally after the completed deletion.
#[tokio::test]
async fn sc02_offline_deletion_removes_all_state_and_allows_reregistration() -> anyhow::Result<()> {
    let f = fixture().await?;
    offline_agent(&f.agents, AGENT_ID).await;
    let session = add_session_with_binding(&f, AGENT_ID, "dev").await?;

    let mut client = f.client().await?;
    let deleted = parse_reply(
        client
            .handle_message(text_message(
                "server.agent.delete",
                delete_payload(AGENT_ID),
            ))
            .await?,
    )?;
    assert_eq!(success(&deleted), Some(true));
    assert_agent_gone(&f).await?;
    assert!(
        f.env.bindings.get(&session).await?.is_none(),
        "the Environment Binding is removed with the Agent"
    );
    assert!(
        f.env.observed.get(&session).is_none(),
        "the observed Environment state is removed with the Agent"
    );

    let mut reborn = f.agent()?;
    let accepted = parse_reply(
        reborn
            .handle_message(text_message(
                "server.agent.register",
                register_payload(AGENT_ID),
            ))
            .await?,
    )?;
    assert_eq!(status(&accepted), Some("accepted"));
    assert_eq!(
        f.agents.get(AGENT_ID).await.map(|agent| agent.status),
        Some(AgentStatus::Online)
    );
    assert!(
        agent_row_exists(&f.db.list_agents().await?),
        "the new incarnation persists its own row"
    );
    Ok(())
}

/// SC-03: two overlapping delete requests for the same Offline Agent settle
/// consistently — exactly one success, one truthful not-found failure — and the
/// Agent's state is removed once.
#[tokio::test]
async fn sc03_overlapping_deletes_settle_with_one_success() -> anyhow::Result<()> {
    let f = fixture().await?;
    offline_agent(&f.agents, AGENT_ID).await;
    add_session_with_binding(&f, AGENT_ID, "dev").await?;

    let mut first = f.client().await?;
    let mut second = f.client().await?;
    let first_delete = first.handle_message(text_message(
        "server.agent.delete",
        delete_payload(AGENT_ID),
    ));
    let second_delete = second.handle_message(text_message(
        "server.agent.delete",
        delete_payload(AGENT_ID),
    ));
    let (first_reply, second_reply) = tokio::join!(first_delete, second_delete);
    let first_reply = parse_reply(first_reply?)?;
    let second_reply = parse_reply(second_reply?)?;

    let successes = [&first_reply, &second_reply]
        .iter()
        .filter(|reply| success(reply) == Some(true))
        .count();
    assert_eq!(
        successes, 1,
        "exactly one concurrent deletion may report success: {first_reply} / {second_reply}"
    );
    let failure = if success(&first_reply) == Some(true) {
        &second_reply
    } else {
        &first_reply
    };
    assert_eq!(success(failure), Some(false));
    assert!(
        error(failure).is_some_and(|message| message.contains("not found")),
        "the losing deletion must report the Agent is gone: {failure}"
    );
    assert_agent_gone(&f).await?;
    Ok(())
}

/// SC-01: the delete handler itself waits on the per-Agent registration gate
/// the registration handler uses. Holding that gate externally parks the
/// destructive transition before any write.
#[tokio::test]
async fn sc01_delete_handler_waits_for_the_registration_gate() -> anyhow::Result<()> {
    let f = fixture().await?;
    offline_agent(&f.agents, AGENT_ID).await;

    let gate = f.broker.begin_deletion(AGENT_ID).await;
    let mut client = f.client().await?;
    let mut delete = Box::pin(client.handle_message(text_message(
        "server.agent.delete",
        delete_payload(AGENT_ID),
    )));
    assert!(
        matches!(
            futures_util::poll!(delete.as_mut()),
            std::task::Poll::Pending
        ),
        "the delete handler must wait on the registration gate before writing"
    );
    assert!(
        f.agents.get(AGENT_ID).await.is_some(),
        "no destructive write may happen while the gate is held"
    );

    drop(gate);
    let reply = parse_reply(delete.await?)?;
    assert_eq!(success(&reply), Some(true));
    assert_agent_gone(&f).await?;
    Ok(())
}

/// SC-01: the delete handler revalidates Offline under the Agent's liveness
/// gate, the same gate registration and heartbeat recovery take.
#[tokio::test]
async fn sc01_delete_handler_waits_for_the_liveness_gate() -> anyhow::Result<()> {
    let f = fixture().await?;
    offline_agent(&f.agents, AGENT_ID).await;

    let claim = match f.agents.begin_agent_deletion(AGENT_ID).await {
        AgentDeleteClaim::Claimed(guard) => guard,
        _ => anyhow::bail!("an Offline Agent must be claimable for deletion"),
    };
    let mut client = f.client().await?;
    let mut delete = Box::pin(client.handle_message(text_message(
        "server.agent.delete",
        delete_payload(AGENT_ID),
    )));
    assert!(
        matches!(
            futures_util::poll!(delete.as_mut()),
            std::task::Poll::Pending
        ),
        "the delete handler must revalidate under the liveness gate"
    );
    assert!(
        f.agents.get(AGENT_ID).await.is_some(),
        "no destructive write may happen while the liveness gate is held"
    );

    drop(claim);
    let reply = parse_reply(delete.await?)?;
    assert_eq!(success(&reply), Some(true));
    assert_agent_gone(&f).await?;
    Ok(())
}
