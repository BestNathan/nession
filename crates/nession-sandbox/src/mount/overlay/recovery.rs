//! Durable identity and restart reconciliation for shared writable Overlays
//! (#3582).
//!
//! A physical `fuse-overlayfs` mount is only ever served again when all of the
//! following agree:
//!
//! - the durable identity sidecar names the requested authorized workspace;
//! - its generation, mountpoint, Agent identity and mount namespace match;
//! - the durable owner lock can be acquired (no live process owns the bytes);
//! - mountinfo still reports a `fuse-overlayfs` mount at the manager-derived
//!   mountpoint;
//! - the read-only EROFS lower can be re-adopted from its own durable
//!   identity.
//!
//! A mount that exists without this proof is `Orphaned`: it is never adopted
//! merely because a path exists, and reclamation never deletes durable bytes.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use nession_erofs::digest::is_valid_digest;
use nession_erofs::mount_manager::ConsumerRef;

use super::manager::{
    adopt_token, lock, lower_consumer_id, OverlayMountManager, ProtectedWorkspaces,
};
use super::state::{OverlayBinding, OverlayConsumerRef, OverlayRecoveryReport, OverlayState};
use super::storage::{self, OverlayWorkspaceKey, OwnerLock};

/// The durable identity of one physical Overlay mount.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct OverlayIdentityFile {
    pub(super) workspace: OverlayWorkspaceKey,
    pub(super) mountpoint: PathBuf,
    pub(super) generation: String,
    pub(super) lower_digest: String,
    pub(super) lower_mountpoint: PathBuf,
    pub(super) lower_generation: String,
    pub(super) agent_identity: String,
    pub(super) mount_namespace: String,
    pub(super) created_at: u64,
}

impl OverlayIdentityFile {
    pub(super) fn from_binding(
        binding: &OverlayBinding,
        agent_identity: &str,
        mount_namespace: &str,
    ) -> Self {
        Self {
            workspace: binding.workspace.clone(),
            mountpoint: binding.mountpoint.clone(),
            generation: binding.generation.clone(),
            lower_digest: binding.lower_digest.clone(),
            lower_mountpoint: binding.lower_mountpoint.clone(),
            lower_generation: binding.lower_generation.clone(),
            agent_identity: agent_identity.to_string(),
            mount_namespace: mount_namespace.to_string(),
            created_at: storage::now_seconds(),
        }
    }

    pub(super) fn binding(&self) -> OverlayBinding {
        OverlayBinding {
            workspace: self.workspace.clone(),
            mountpoint: self.mountpoint.clone(),
            generation: self.generation.clone(),
            lower_digest: self.lower_digest.clone(),
            lower_mountpoint: self.lower_mountpoint.clone(),
            lower_generation: self.lower_generation.clone(),
        }
    }
}

pub(super) fn read_identity(path: &Path) -> Result<OverlayIdentityFile> {
    let bytes =
        std::fs::read(path).with_context(|| format!("read Overlay identity {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("parse Overlay identity {}", path.display()))
}

pub(super) fn write_identity(path: &Path, identity: &OverlayIdentityFile) -> Result<()> {
    let bytes =
        serde_json::to_vec_pretty(identity).context("serialize the durable Overlay identity")?;
    storage::write_private_atomic(path, &bytes)
}

pub(super) fn remove_identity(path: &Path) {
    let _ = std::fs::remove_file(path);
}

impl OverlayMountManager {
    /// Adopt durable consumers recovered from authoritative execution records.
    ///
    /// A consumer is adopted only when the durable identity, generation,
    /// Agent identity, mount namespace, owner lock and mountinfo agree and the
    /// lower can be re-adopted. A missing or unproven mount is reported
    /// unavailable, never served.
    pub fn adopt_consumers(&self, consumers: &[OverlayConsumerRef]) -> OverlayRecoveryReport {
        let mut report = OverlayRecoveryReport::default();
        for consumer in consumers {
            let workspace_text = consumer.workspace.identity();
            if consumer.execution_id.trim().is_empty() {
                report
                    .unavailable
                    .push((workspace_text, "empty execution id".to_string()));
                continue;
            }
            if let Err(error) = self.validate_workspace(&consumer.workspace) {
                report
                    .unavailable
                    .push((workspace_text, format!("{error:#}")));
                continue;
            }
            let entry = match self.entry_or_create(&consumer.workspace) {
                Ok(entry) => entry,
                Err(error) => {
                    report
                        .unavailable
                        .push((workspace_text, format!("{error:#}")));
                    continue;
                }
            };
            let mut state = lock(&entry.state);
            if state.consumers.values().any(|known| {
                known.execution_id == consumer.execution_id
                    && known.generation == consumer.generation
            }) {
                continue;
            }
            if matches!(
                state.phase,
                OverlayState::Mounting | OverlayState::Unmounting
            ) {
                report.unavailable.push((
                    workspace_text,
                    "the physical Overlay is transitioning".to_string(),
                ));
                continue;
            }
            let identity = match read_identity(&entry.identity_path) {
                Ok(identity) => identity,
                Err(error) => {
                    report
                        .unavailable
                        .push((workspace_text, format!("{error:#}")));
                    continue;
                }
            };
            let reason = identity_mismatch(&identity, &entry.workspace, entry.mountpoint.as_path())
                .or_else(|| {
                    (identity.agent_identity != self.inner.agent_identity).then(|| {
                        format!(
                            "the durable Overlay is owned by Agent identity {}",
                            identity.agent_identity
                        )
                    })
                })
                .or_else(|| {
                    (identity.mount_namespace != self.inner.mount_namespace).then(|| {
                        format!(
                            "the durable Overlay was created in mount namespace {}; this process \
                             cannot adopt it",
                            identity.mount_namespace
                        )
                    })
                })
                .or_else(|| {
                    (identity.generation != consumer.generation)
                        .then(|| "generation mismatch".to_string())
                })
                .or_else(|| {
                    (identity.lower_digest != consumer.lower_digest
                        || identity.lower_generation != consumer.lower_generation)
                        .then(|| "lower identity mismatch".to_string())
                });
            if let Some(reason) = reason {
                report.unavailable.push((workspace_text, reason));
                continue;
            }
            if !self.inner.backend.is_overlay_mount(&entry.mountpoint) {
                report.unavailable.push((
                    workspace_text,
                    "the physical Overlay mount is no longer present".to_string(),
                ));
                continue;
            }
            if state.owner.is_none() {
                match OwnerLock::acquire(&entry.workspace.directory()) {
                    Ok(owner) => state.owner = Some(owner),
                    Err(error) => {
                        report
                            .unavailable
                            .push((workspace_text, format!("{error:#}")));
                        continue;
                    }
                }
            }
            match storage::read_owner_record(&entry.workspace.directory()) {
                Ok(Some(record)) => {
                    if record.agent_identity != self.inner.agent_identity {
                        report.unavailable.push((
                            workspace_text,
                            format!(
                                "the durable owner record names Agent identity {}",
                                record.agent_identity
                            ),
                        ));
                        continue;
                    }
                    if record.generation != identity.generation {
                        report.unavailable.push((
                            workspace_text,
                            "the durable owner record names a different generation".to_string(),
                        ));
                        continue;
                    }
                    if record.mountpoint != entry.mountpoint {
                        report.unavailable.push((
                            workspace_text,
                            "the durable owner record names a non-manager mountpoint".to_string(),
                        ));
                        continue;
                    }
                }
                Ok(None) => {
                    report.unavailable.push((
                        workspace_text,
                        "the durable owner record is missing".to_string(),
                    ));
                    continue;
                }
                Err(error) => {
                    report
                        .unavailable
                        .push((workspace_text, format!("{error:#}")));
                    continue;
                }
            }
            if state.lower.is_none() {
                let adoption = self.inner.lower.adopt_lowers(&[ConsumerRef {
                    digest: consumer.lower_digest.clone(),
                    execution_id: lower_consumer_id(&entry.workspace),
                    generation: consumer.lower_generation.clone(),
                }]);
                let adopted = adoption.adopted.iter().any(|(digest, execution)| {
                    digest == &consumer.lower_digest
                        && execution == &lower_consumer_id(&entry.workspace)
                });
                if !adopted {
                    let reason = adoption
                        .unavailable
                        .first()
                        .map(|(_, reason)| reason.clone())
                        .unwrap_or_else(|| {
                            "the read-only lower could not be re-adopted".to_string()
                        });
                    report.unavailable.push((workspace_text, reason));
                    continue;
                }
                state.lower = Some(super::manager::LowerHandle::Adopted {
                    digest: consumer.lower_digest.clone(),
                    generation: consumer.lower_generation.clone(),
                });
            }
            state.phase = OverlayState::Mounted;
            state.binding = Some(identity.binding());
            state.failure = None;
            let token = adopt_token(&mut state, &consumer.execution_id, &consumer.generation);
            let _ = token;
            entry.transitioned.notify_all();
            self.inner
                .adoptions
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            report
                .adopted
                .push((workspace_text, consumer.execution_id.clone()));
        }
        report
    }

    /// Reclaim physical Overlays that no surviving execution record protects
    /// and that no live process still owns.
    ///
    /// Durable bytes (`upper`/`work`) are never deleted. A sidecar that names
    /// another Agent identity, an unauthorized root or a non-derived
    /// mountpoint is left for an operator and reported as a failure.
    pub fn reclaim_orphans(&self, protected: &ProtectedWorkspaces) -> OverlayRecoveryReport {
        let mut report = OverlayRecoveryReport::default();
        let mut known_mountpoints: HashSet<PathBuf> = HashSet::new();
        let mut sidecars: Vec<PathBuf> = Vec::new();
        match std::fs::read_dir(self.inner.root.join("state")) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
                        sidecars.push(path);
                    }
                }
            }
            Err(error) => {
                report.reclaim_failed.push((
                    self.inner.root.join("state").display().to_string(),
                    format!("read the Overlay identity directory: {error}"),
                ));
            }
        }
        for path in &sidecars {
            match read_identity(path) {
                Ok(identity) => {
                    known_mountpoints.insert(identity.mountpoint.clone());
                }
                Err(error) => {
                    // An unreadable sidecar proves no identity; leave any mount
                    // for an operator instead of guessing at it.
                    report.reclaim_failed.push((
                        path.display().to_string(),
                        format!("unreadable Overlay identity: {error:#}"),
                    ));
                }
            }
        }
        for path in sidecars {
            let identity = match read_identity(&path) {
                Ok(identity) => identity,
                Err(_) => continue,
            };
            let workspace_text = identity.workspace.identity();
            if protected.contains(&identity.workspace) {
                continue;
            }
            if let Err(error) = identity.workspace.validate() {
                report
                    .reclaim_failed
                    .push((workspace_text, format!("{error:#}")));
                continue;
            }
            if !self
                .inner
                .workspace_roots
                .iter()
                .any(|root| root == identity.workspace.root())
            {
                report.reclaim_failed.push((
                    workspace_text,
                    "the identity names an unauthorized workspace root".to_string(),
                ));
                continue;
            }
            if identity.agent_identity != self.inner.agent_identity {
                report.reclaim_failed.push((
                    workspace_text,
                    format!(
                        "the identity is owned by Agent identity {}",
                        identity.agent_identity
                    ),
                ));
                continue;
            }
            let entry = match self.entry_or_create(&identity.workspace) {
                Ok(entry) => entry,
                Err(error) => {
                    report
                        .reclaim_failed
                        .push((workspace_text, format!("{error:#}")));
                    continue;
                }
            };
            if identity_mismatch(&identity, &entry.workspace, entry.mountpoint.as_path()).is_some()
            {
                report.reclaim_failed.push((
                    workspace_text,
                    "the durable identity does not match its manager-derived workspace".to_string(),
                ));
                continue;
            }
            {
                let state = lock(&entry.state);
                if !state.consumers.is_empty() {
                    continue;
                }
            }
            if let Err(error) = storage::verify(&identity.workspace.directory()) {
                report
                    .reclaim_failed
                    .push((workspace_text, format!("{error:#}")));
                continue;
            }
            // A live process (this manager or another) owns the durable bytes:
            // never reclaim underneath it.
            let owner = match OwnerLock::acquire(&identity.workspace.directory()) {
                Ok(owner) => owner,
                Err(_) => continue,
            };
            if self.inner.backend.is_overlay_mount(&identity.mountpoint) {
                if let Err(error) = self
                    .inner
                    .backend
                    .unmount(&self.inner.settings, &identity.mountpoint)
                {
                    let mut state = lock(&entry.state);
                    state.phase = OverlayState::Failed;
                    state.failure = Some(format!("{error:#}"));
                    entry.transitioned.notify_all();
                    report
                        .reclaim_failed
                        .push((workspace_text, format!("{error:#}")));
                    continue;
                }
            }
            // The Overlay is gone; the stale lower consumer and sidecars are
            // safe to clear. Durable upper/work are untouched.
            if is_valid_digest(&identity.lower_digest) {
                let _ = self.inner.lower.release_lower(
                    &identity.lower_digest,
                    &lower_consumer_id(&identity.workspace),
                    Some(&identity.lower_generation),
                );
            }
            remove_identity(&path);
            storage::remove_owner_record(&identity.workspace.directory());
            {
                let mut state = lock(&entry.state);
                state.phase = OverlayState::Idle;
                state.binding = None;
                state.lower = None;
                state.owner = None;
                state.failure = None;
            }
            drop(owner);
            report.reclaimed.push(workspace_text);
        }

        // A physical mount without any durable identity is never guessed at
        // and never adopted. Report it so an operator can inspect it.
        if let Ok(entries) = std::fs::read_dir(self.inner.root.join("mounts")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !self.inner.backend.is_overlay_mount(&path) {
                    continue;
                }
                if known_mountpoints.contains(&path) {
                    continue;
                }
                report.reclaim_failed.push((
                    path.display().to_string(),
                    "physical Overlay mount without a durable identity".to_string(),
                ));
            }
        }
        report
    }
}

fn identity_mismatch(
    identity: &OverlayIdentityFile,
    workspace: &OverlayWorkspaceKey,
    mountpoint: &Path,
) -> Option<String> {
    if identity.workspace.identity() != workspace.identity() {
        return Some("the durable identity names a different workspace".to_string());
    }
    if identity.mountpoint != mountpoint {
        return Some(format!(
            "the durable identity mountpoint {} is not the manager-derived {}",
            identity.mountpoint.display(),
            mountpoint.display()
        ));
    }
    if identity.generation.trim().is_empty() || identity.lower_generation.trim().is_empty() {
        return Some("the durable identity has an empty generation".to_string());
    }
    if !is_valid_digest(&identity.lower_digest) {
        return Some("the durable identity has an invalid lower digest".to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_durable_identity_round_trips() {
        let root = tempfile::tempdir().unwrap();
        let workspace = OverlayWorkspaceKey::new(root.path(), "ws_identity").unwrap();
        std::fs::create_dir_all(workspace.directory()).unwrap();
        let binding = OverlayBinding {
            workspace,
            mountpoint: root.path().join("merged"),
            generation: "generation-1".to_string(),
            lower_digest: format!("sha256:{}", "a".repeat(64)),
            lower_mountpoint: root.path().join("lower"),
            lower_generation: "lower-1".to_string(),
        };
        let identity = OverlayIdentityFile::from_binding(&binding, "agent-a", "mnt:[1]");
        let path = root.path().join("state.json");
        write_identity(&path, &identity).unwrap();
        let read = read_identity(&path).unwrap();
        assert_eq!(read.binding(), binding);
        assert_eq!(read.agent_identity, "agent-a");
        assert_eq!(read.mount_namespace, "mnt:[1]");
        remove_identity(&path);
        assert!(read_identity(&path).is_err());
    }
}
