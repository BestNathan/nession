//! Session Environment Binding: durable desired state and the observed cache
//! (#170 Phase A).
//!
//! The Server owns user intent (ordered profile selection, its revision, and
//! the content hashes materialized for that revision). The Agent owns what is
//! actually applied to a Session. This module keeps the first durable and the
//! second rebuildable: the observed half is an in-memory cache filled from
//! Agent replies and reconnect reports, never the authority.
//!
//! `EnvUsageRegistry` used to be the authority for the in-use lock and the
//! visibility projection. It is gone: the same questions are answered from the
//! desired binding rows, which survive a restart without a rebuild step.

use crate::db::{Database, SessionEnvBindingRow};
use anyhow::{Context, Result};
use nession_protocol::contracts::env::v1::{
    ActiveEnvFile, EnvFileRef, EnvSnapshot, EnvSource, SessionEnvObservedState,
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

/// One profile materialized at a binding revision.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MaterializedProfile {
    pub profile: EnvFileRef,
    /// `"create"` or `"attach"` — provenance for the legacy visibility wire.
    pub phase: String,
    /// SHA-256 of the profile's content at this revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

/// One Session's desired binding.
#[derive(Debug, Clone)]
pub struct BindingRecord {
    pub session_id: String,
    pub agent_id: String,
    pub desired_revision: u64,
    pub profiles: Vec<MaterializedProfile>,
    pub updated_at: i64,
}

impl BindingRecord {
    /// An empty binding for a Session that has never been set. Revision 0 is a
    /// valid state, not a missing one.
    pub fn empty(session_id: &str, agent_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
            desired_revision: 0,
            profiles: Vec::new(),
            updated_at: 0,
        }
    }

    /// The visibility projection the Web already reads. `phase` preserves the
    /// create/attach provenance; `applied_by` is gone because no client owns a
    /// Session binding.
    pub fn active(&self) -> Vec<ActiveEnvFile> {
        self.profiles
            .iter()
            .map(|materialized| ActiveEnvFile {
                name: materialized.profile.name.clone(),
                source: materialized.profile.source,
                agent_id: materialized.profile.agent_id.clone(),
                phase: materialized.phase.clone(),
                applied_by: None,
            })
            .collect()
    }

    /// Whether this Session's desired binding contains the file.
    pub fn uses(&self, name: &str, source: EnvSource, agent_id: Option<&str>) -> bool {
        self.profiles.iter().any(|materialized| {
            materialized.profile.name == name
                && materialized.profile.source == source
                && materialized.profile.agent_id.as_deref() == agent_id
        })
    }
}

/// Durable store for desired Session Environment Bindings.
#[derive(Clone)]
pub struct EnvBindingStore {
    db: Arc<Database>,
}

impl EnvBindingStore {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub async fn get(&self, session_id: &str) -> Result<Option<BindingRecord>> {
        self.db
            .get_session_env_binding(session_id)
            .await?
            .map(record_from_row)
            .transpose()
    }

    pub async fn put(&self, record: &BindingRecord) -> Result<()> {
        let profiles_json = serde_json::to_string(&record.profiles)
            .context("serialising materialized env binding profiles")?;
        self.db
            .upsert_session_env_binding(&SessionEnvBindingRow {
                session_id: record.session_id.clone(),
                agent_id: record.agent_id.clone(),
                desired_revision: record.desired_revision,
                profiles_json,
                updated_at: record.updated_at,
            })
            .await
    }

    /// Remove one Session's binding. Called when the Session is killed or the
    /// Agent reports it gone.
    pub async fn clear_session(&self, session_id: &str) {
        if let Err(e) = self.db.delete_session_env_binding(session_id).await {
            tracing::error!("Failed to delete env binding for {session_id}: {e:#}");
        }
    }

    /// Remove every binding owned by an Agent that is no longer registered.
    pub async fn clear_agent(&self, agent_id: &str) {
        if let Err(e) = self.db.delete_session_env_bindings_by_agent(agent_id).await {
            tracing::error!("Failed to delete env bindings for agent {agent_id}: {e:#}");
        }
    }

    /// Sessions whose desired binding uses the file. This is the in-use lock's
    /// new authority, and it is rebuildable because it is the stored intent.
    pub async fn sessions_using(
        &self,
        name: &str,
        source: EnvSource,
        agent_id: Option<&str>,
    ) -> Vec<String> {
        match self.db.list_session_env_bindings().await {
            Ok(rows) => {
                let mut result: Vec<String> = rows
                    .into_iter()
                    .filter_map(|row| record_from_row(row).ok())
                    .filter(|record| record.uses(name, source, agent_id))
                    .map(|record| record.session_id)
                    .collect();
                result.sort();
                result
            }
            Err(e) => {
                tracing::error!("Failed to read env bindings for the in-use lock: {e:#}");
                Vec::new()
            }
        }
    }
}

fn record_from_row(row: SessionEnvBindingRow) -> Result<BindingRecord> {
    let profiles: Vec<MaterializedProfile> = serde_json::from_str(&row.profiles_json)
        .with_context(|| format!("parsing env binding profiles for {}", row.session_id))?;
    Ok(BindingRecord {
        session_id: row.session_id,
        agent_id: row.agent_id,
        desired_revision: row.desired_revision,
        profiles,
        updated_at: row.updated_at,
    })
}

/// The observed half: what each Agent last told us it materialized.
///
/// In-memory and rebuilt by the Agent's registration report or by a live
/// `agent.session.env.binding.get` query. Losing it on a Server restart is
/// acceptable because the Agent is the authority.
#[derive(Default)]
pub struct ObservedBindings {
    inner: RwLock<HashMap<String, SessionEnvObservedState>>,
}

impl ObservedBindings {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, session_id: &str, observed: SessionEnvObservedState) {
        self.inner
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id.to_string(), observed);
    }

    pub fn get(&self, session_id: &str) -> Option<SessionEnvObservedState> {
        self.inner
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .cloned()
    }

    pub fn clear_session(&self, session_id: &str) {
        self.inner
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
    }

    pub fn clear_agent(&self, agent_id: &str) {
        let prefix = format!("{agent_id}:");
        self.inner
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|session_id, _| !session_id.starts_with(&prefix));
    }
}

/// Content hash of one resolved profile.
///
/// The canonical bytes are `key \0 value \0` in snapshot order. They are not
/// secret-derived only: the hash exists to answer "did this profile change
/// since the Session materialized it", and a hash of the vars is enough for
/// that without storing the content twice.
pub fn snapshot_hash(snapshot: &EnvSnapshot) -> String {
    let mut hasher = Sha256::new();
    for (key, value) in &snapshot.vars {
        hasher.update(key.as_bytes());
        hasher.update([0]);
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

/// Preserve the phase of a profile that was already in the binding; a profile
/// new to this replacement gets `default_phase`.
pub fn materialized_profiles(
    existing: &[MaterializedProfile],
    refs: &[EnvFileRef],
    default_phase: &str,
) -> Vec<MaterializedProfile> {
    refs.iter()
        .map(|profile| {
            let phase = existing
                .iter()
                .find(|old| same_profile(&old.profile, profile))
                .map_or_else(|| default_phase.to_string(), |old| old.phase.clone());
            MaterializedProfile {
                profile: profile.clone(),
                phase,
                content_hash: None,
            }
        })
        .collect()
}

pub fn same_profile(left: &EnvFileRef, right: &EnvFileRef) -> bool {
    left.name == right.name && left.source == right.source && left.agent_id == right.agent_id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(name: &str) -> EnvFileRef {
        EnvFileRef {
            name: name.to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }
    }

    fn snapshot(name: &str, vars: &[(&str, &str)]) -> EnvSnapshot {
        EnvSnapshot {
            name: name.to_string(),
            source: EnvSource::Server,
            agent_id: None,
            vars: vars
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn content_hash_changes_with_a_value_and_is_order_sensitive() {
        let a = snapshot("a.env", &[("X", "1"), ("Y", "2")]);
        let b = snapshot("a.env", &[("X", "1"), ("Y", "3")]);
        let c = snapshot("a.env", &[("Y", "2"), ("X", "1")]);
        assert_ne!(snapshot_hash(&a), snapshot_hash(&b));
        assert_ne!(snapshot_hash(&a), snapshot_hash(&c));
        assert_eq!(
            snapshot_hash(&a),
            snapshot_hash(&snapshot("a.env", &[("X", "1"), ("Y", "2")]))
        );
    }

    #[test]
    fn replacement_preserves_the_phase_of_a_profile_it_already_had() {
        let existing = vec![MaterializedProfile {
            profile: reference("base.env"),
            phase: "create".to_string(),
            content_hash: Some("old".to_string()),
        }];
        let profiles = materialized_profiles(
            &existing,
            &[reference("base.env"), reference("extra.env")],
            "attach",
        );
        assert_eq!(profiles[0].phase, "create");
        assert_eq!(profiles[1].phase, "attach");
        assert!(profiles[0].content_hash.is_none());
    }

    #[test]
    fn active_projection_carries_order_and_phase_without_an_applier() {
        let record = BindingRecord {
            session_id: "a:s".to_string(),
            agent_id: "a".to_string(),
            desired_revision: 2,
            profiles: materialized_profiles(&[], &[reference("a.env")], "create"),
            updated_at: 0,
        };
        let active = record.active();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].phase, "create");
        assert!(active[0].applied_by.is_none());
    }

    #[tokio::test]
    async fn a_reopened_database_recovers_the_desired_binding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nession.db");
        let path = path.to_string_lossy().into_owned();

        let profiles = materialized_profiles(&[], &[reference("shared.env")], "create");
        {
            let db = Arc::new(Database::new(&path).await.unwrap());
            let store = EnvBindingStore::new(db);
            store
                .put(&BindingRecord {
                    session_id: "a1:s1".to_string(),
                    agent_id: "a1".to_string(),
                    desired_revision: 4,
                    profiles: profiles.clone(),
                    updated_at: 0,
                })
                .await
                .unwrap();
        }

        // A Server restart opens the same file with no shared in-memory state.
        let reopened = Arc::new(Database::new(&path).await.unwrap());
        let store = EnvBindingStore::new(reopened);
        let record = store
            .get("a1:s1")
            .await
            .unwrap()
            .expect("the desired binding is durable in the database file");
        assert_eq!(record.desired_revision, 4);
        assert_eq!(record.profiles.len(), profiles.len());
        assert_eq!(
            record.profiles.first().map(|p| &p.profile),
            profiles.first().map(|p| &p.profile)
        );
        assert_eq!(
            record.profiles.first().map(|p| p.phase.as_str()),
            profiles.first().map(|p| p.phase.as_str())
        );
    }

    #[tokio::test]
    async fn bindings_are_durable_and_the_usage_index_reads_intent() {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let store = EnvBindingStore::new(Arc::clone(&db));
        let profiles = materialized_profiles(&[], &[reference("shared.env")], "create");
        store
            .put(&BindingRecord {
                session_id: "a1:s1".to_string(),
                agent_id: "a1".to_string(),
                desired_revision: 1,
                profiles: profiles.clone(),
                updated_at: 0,
            })
            .await
            .unwrap();

        let reloaded = EnvBindingStore::new(db);
        let record = reloaded.get("a1:s1").await.unwrap().expect("durable");
        assert_eq!(record.desired_revision, 1);
        assert_eq!(
            reloaded
                .sessions_using("shared.env", EnvSource::Server, None)
                .await,
            vec!["a1:s1".to_string()]
        );
        reloaded.clear_session("a1:s1").await;
        assert!(reloaded.get("a1:s1").await.unwrap().is_none());
    }
}
