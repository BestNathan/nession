//! #2997 source-aligned runtime Cases: heartbeat-offline grace cleanup is
//! bound to the offline episode that scheduled it.
//!
//! The 30-second policy itself is unchanged; these tests drive the owner
//! directly so the two offline episodes and the recovery boundary can be
//! ordered deterministically instead of by wall-clock waiting.

use std::sync::Arc;

use chrono::Utc;
use nession_protocol::contracts::agent::v1::AgentMetadata;
use nession_protocol::contracts::env::v1::SessionEnvObservedState;
use nession_server::db::Database;
use nession_server::env::{BindingRecord, EnvService};
use nession_server::registry::agent::{AgentInfo, AgentRegistry, AgentStatus};
use nession_server::registry::session::{SessionInfo, SessionRegistry, SessionStatus};
use nession_server::server::offline_grace::{
    clean_up_expired_offline_agent, remove_expired_offline_agent_sessions,
};
use nession_server::server::WebClientRegistry;

struct Fixture {
    _db_dir: tempfile::TempDir,
    db: Arc<Database>,
    agents: Arc<AgentRegistry>,
    sessions: Arc<SessionRegistry>,
    env: Arc<EnvService>,
    web: Arc<WebClientRegistry>,
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
        db,
    })
}

/// Register an Agent whose heartbeat is already older than the registry's
/// timeout, so the next sweep deterministically opens an offline episode
/// without waiting for one.
async fn register_stale_agent(agents: &AgentRegistry, agent_id: &str) {
    agents
        .register(AgentInfo {
            agent_id: agent_id.to_string(),
            hostname: format!("host-{agent_id}"),
            ip_address: "10.0.0.1".to_string(),
            port: 19091,
            display_name: None,
            connect_url: None,
            addresses: vec![],
            registered_at: Utc::now(),
            last_heartbeat: Utc::now() - chrono::Duration::seconds(60),
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
            agent_token: None,
            probe_generation: 0,
            offline_generation: 0,
        })
        .await;
}

fn session_info(agent_id: &str, session_name: &str) -> SessionInfo {
    SessionInfo {
        session_id: format!("{agent_id}:{session_name}"),
        agent_id: agent_id.to_string(),
        session_name: session_name.to_string(),
        status: SessionStatus::Active,
        window_count: 1,
        attached_clients: 0,
        foreground_command: None,
        working_dir: None,
        instance_id: None,
        created_at: Utc::now(),
        last_activity: Utc::now(),
    }
}

/// Add a live Session and both halves of its Environment Binding state.
async fn add_session_with_binding(
    f: &Fixture,
    agent_id: &str,
    session_name: &str,
) -> anyhow::Result<String> {
    let session = session_info(agent_id, session_name);
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

async fn persisted_session_ids(db: &Database, agent_id: &str) -> anyhow::Result<Vec<String>> {
    let mut ids: Vec<String> = db
        .list_all_sessions()
        .await?
        .into_iter()
        .filter(|row| row.agent_id == agent_id)
        .map(|row| row.session_id)
        .collect();
    ids.sort();
    Ok(ids)
}

/// SC-01: Offline(t0) → Online(t5) → Offline(t10).
///
/// The cleanup scheduled for the t0 episode must not remove the Session or its
/// Environment Binding when it wakes during the second offline interval: that
/// episode is independently young and keeps its own full grace. Only the second
/// episode's own cleanup removes the Session.
#[tokio::test]
async fn sc01_prior_episode_cleanup_cannot_remove_sessions_of_a_newer_offline_interval() {
    let f = fixture().await.unwrap();
    let agent_id = "a1";

    register_stale_agent(&f.agents, agent_id).await;
    let session_id = add_session_with_binding(&f, agent_id, "dev").await.unwrap();

    // t0: the sweep opens the first offline episode and schedules cleanup.
    let first = f.agents.check_offline_agents().await;
    assert_eq!(first.len(), 1, "one Online→Offline transition");
    assert_eq!(first[0].agent_id, agent_id);
    let first_generation = first[0].offline_generation;

    // t5: a heartbeat brings the Agent back Online; the Session survives.
    assert!(
        f.agents.update_heartbeat(agent_id, 1, 0).await,
        "Offline → Online is a meaningful transition"
    );
    assert_eq!(
        f.agents.get(agent_id).await.unwrap().status,
        AgentStatus::Online
    );
    assert!(
        f.sessions.get(&session_id).await.is_some(),
        "recovery within the grace period preserves the Session"
    );

    // t10: the Agent is silent again, and the sweep opens a new, independent
    // episode. Re-registration is the deterministic way to move the heartbeat
    // timestamp back; the transition under test is Online → Offline.
    register_stale_agent(&f.agents, agent_id).await;
    let second = f.agents.check_offline_agents().await;
    assert_eq!(second.len(), 1, "the second interval opens another episode");
    assert_eq!(second[0].agent_id, agent_id);
    let second_generation = second[0].offline_generation;
    assert_ne!(
        first_generation, second_generation,
        "each offline interval has its own episode generation"
    );

    // t30: the t0 cleanup wakes during the second interval. It must stand down:
    // the second interval's grace has not expired, so nothing may be removed.
    let removed = clean_up_expired_offline_agent(
        &f.agents,
        &f.sessions,
        &f.env,
        &f.web,
        agent_id,
        first_generation,
    )
    .await;
    assert!(
        !removed,
        "cleanup bound to the earlier episode must not act on the later one"
    );
    assert!(
        f.sessions.get(&session_id).await.is_some(),
        "the Session must survive the prior episode's cleanup"
    );
    assert_eq!(
        persisted_session_ids(&f.db, agent_id).await.unwrap(),
        vec![session_id.clone()],
        "the Session row must survive in SQLite as well"
    );
    assert!(
        f.env.bindings.get(&session_id).await.unwrap().is_some(),
        "the desired Environment Binding must survive"
    );
    assert!(
        f.env.observed.get(&session_id).is_some(),
        "the observed Environment Binding cache must survive"
    );

    // t40: the second episode's own cleanup, after its full grace, is the one
    // that removes the Session and its Environment Binding state.
    let removed = clean_up_expired_offline_agent(
        &f.agents,
        &f.sessions,
        &f.env,
        &f.web,
        agent_id,
        second_generation,
    )
    .await;
    assert!(
        removed,
        "the current episode's own expired cleanup must remove the Session"
    );
    assert!(f.sessions.get(&session_id).await.is_none());
    assert!(persisted_session_ids(&f.db, agent_id)
        .await
        .unwrap()
        .is_empty());
    assert!(f.env.bindings.get(&session_id).await.unwrap().is_none());
    assert!(f.env.observed.get(&session_id).is_none());
}

/// SC-02: a continuously offline Agent's expired episode cleanup removes only
/// that Agent's Sessions and Environment Binding state.
#[tokio::test]
async fn sc02_continuous_offline_cleanup_removes_only_that_agents_sessions_and_bindings() {
    let f = fixture().await.unwrap();

    register_stale_agent(&f.agents, "a1").await;
    register_stale_agent(&f.agents, "a2").await;
    let a1_session = add_session_with_binding(&f, "a1", "dev").await.unwrap();
    let a2_session = add_session_with_binding(&f, "a2", "dev").await.unwrap();

    let transitions = f.agents.check_offline_agents().await;
    assert_eq!(transitions.len(), 2, "both Agents go Offline");
    let a1_generation = transitions
        .iter()
        .find(|transition| transition.agent_id == "a1")
        .expect("a1 transition")
        .offline_generation;

    let removed =
        clean_up_expired_offline_agent(&f.agents, &f.sessions, &f.env, &f.web, "a1", a1_generation)
            .await;
    assert!(
        removed,
        "a continuously offline Agent is still cleaned after the grace interval"
    );

    assert!(f.sessions.get(&a1_session).await.is_none());
    assert!(
        persisted_session_ids(&f.db, "a1").await.unwrap().is_empty(),
        "the expired Agent's Session rows are removed"
    );
    assert!(f.env.bindings.get(&a1_session).await.unwrap().is_none());
    assert!(f.env.observed.get(&a1_session).is_none());

    assert!(
        f.sessions.get(&a2_session).await.is_some(),
        "another Agent's Session must not be removed"
    );
    assert_eq!(
        persisted_session_ids(&f.db, "a2").await.unwrap(),
        vec![a2_session.clone()],
        "another Agent's Session row must not be removed"
    );
    assert!(
        f.env.bindings.get(&a2_session).await.unwrap().is_some(),
        "another Agent's Environment Binding must not be removed"
    );
    assert!(f.env.observed.get(&a2_session).is_some());
}

/// SC-02: recovery concurrent with the destructive boundary cannot lose a
/// Session the Agent restores.
///
/// The expired cleanup holds the episode claim across its removal, so the
/// recovery's heartbeat waits for it and its Session resync lands afterwards.
/// A cleanup that did not own the boundary could interleave after the resync
/// and delete the restored Session.
#[tokio::test]
async fn sc02_recovery_at_the_cleanup_boundary_keeps_the_restored_session() {
    let f = fixture().await.unwrap();
    let agent_id = "a1";

    register_stale_agent(&f.agents, agent_id).await;
    let stale_session = add_session_with_binding(&f, agent_id, "dev").await.unwrap();

    let transitions = f.agents.check_offline_agents().await;
    assert_eq!(transitions.len(), 1);
    let generation = transitions[0].offline_generation;

    // The cleanup claims the expired episode and now owns its destructive
    // boundary.
    let claim = f
        .agents
        .begin_offline_cleanup(agent_id, generation)
        .await
        .expect("the expired offline episode is current");

    // Recovery runs concurrently: a heartbeat that brings the Agent Online and
    // the Session resync that follows it.
    let recovery = {
        let agents = Arc::clone(&f.agents);
        let sessions = Arc::clone(&f.sessions);
        tokio::spawn(async move {
            assert!(
                agents.update_heartbeat(agent_id, 1, 0).await,
                "the recovery heartbeat is a meaningful Offline → Online transition"
            );
            sessions
                .update_session(session_info(agent_id, "restored"))
                .await;
        })
    };

    // Let the recovery task reach the liveness gate. With the claim held it
    // must park there rather than apply its Online transition.
    tokio::task::yield_now().await;

    // The expired cleanup performs its removal while still owning the episode.
    remove_expired_offline_agent_sessions(&claim, &f.sessions, &f.env, &f.web, agent_id).await;
    assert!(
        f.sessions.get(&stale_session).await.is_none(),
        "the expired episode's stale Session is removed"
    );
    drop(claim);

    recovery.await.expect("recovery task completes");
    assert_eq!(
        f.agents.get(agent_id).await.unwrap().status,
        AgentStatus::Online,
        "the recovery takes effect after the cleanup's boundary"
    );
    assert!(
        f.sessions.get("a1:restored").await.is_some(),
        "the Session restored by the concurrent recovery survives the cleanup"
    );
}
