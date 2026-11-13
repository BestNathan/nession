//! Agent-owned named, discoverable, reusable Workspace resources (#3407).
//!
//! This manager owns the physical registry and durable bytes for **managed**
//! Workspaces. A Project Existing Location is a Project declaration that the
//! Agent only validates and references; it is never stored or deleted here.
//!
//! Layout under the configured root (the Agent data directory's
//! `workspaces/` subdirectory in production):
//!
//! ```text
//! <root>/registry.json                  versioned metadata, atomically replaced
//! <root>/workspaces/<workspace_id>/     durable user content
//! ```
//!
//! The physical directory is keyed by an opaque `ws_<uuid>` identity, never by
//! the human name. Names are lookup aliases unique within one namespace; the
//! namespace is the Project id when the caller has one, otherwise `default`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use nession_protocol::contracts::workspace::v1::{
    is_valid_workspace_id, normalize_workspace_name, validate_workspace_name,
    validate_workspace_namespace, DEFAULT_WORKSPACE_NAMESPACE, WORKSPACE_ID_PREFIX,
};

/// The only registry schema this build understands.
const REGISTRY_VERSION: u32 = 1;

/// The status an Agent reports for one Workspace resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceStatus {
    /// The durable directory exists and no execution holds it.
    Available,
    /// An execution holds an RW lease.
    InUse,
    /// Metadata exists but the durable directory is missing.
    Missing,
    /// The path or metadata cannot be used safely.
    Error,
}

/// One managed Workspace as the Agent observed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentWorkspace {
    pub workspace_id: String,
    pub name: String,
    pub namespace: String,
    pub auto_created: bool,
    pub created_at: u64,
    pub last_used_at: u64,
    pub status: WorkspaceStatus,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryFile {
    version: u32,
    workspaces: Vec<WorkspaceRecord>,
}

impl Default for RegistryFile {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            workspaces: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceRecord {
    workspace_id: String,
    name: String,
    normalized_name: String,
    namespace: String,
    auto_created: bool,
    created_at: u64,
    last_used_at: u64,
}

/// The Agent's durable named Workspace registry.
pub struct WorkspaceManager {
    root: PathBuf,
    /// Serializes every registry read-modify-write and lease transition.
    registry: AsyncMutex<()>,
    /// In-memory RW attachments. A restart clears them; execution records are
    /// the durable attachment authority and will rebuild them in #3405's
    /// implementation.
    leases: Mutex<HashMap<String, u32>>,
}

fn protocol_validation(result: Result<(), String>) -> Result<()> {
    result.map_err(anyhow::Error::msg)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn normalize_namespace(namespace: Option<&str>) -> Result<String> {
    let namespace = match namespace {
        None => DEFAULT_WORKSPACE_NAMESPACE,
        Some(value) => {
            let value = value.trim();
            if value.is_empty() {
                anyhow::bail!("workspace namespace must not be empty");
            }
            value
        }
    };
    protocol_validation(validate_workspace_namespace(namespace))?;
    Ok(namespace.to_string())
}

impl WorkspaceManager {
    /// Open (or create) the durable registry under `root`.
    ///
    /// The caller owns the durability declaration: production passes the Agent
    /// data directory's `workspaces/` child. An unreadable or malformed
    /// registry is an error; this manager never fabricates readiness.
    pub fn open(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&root)
            .with_context(|| format!("cannot create workspace root {}", root.display()))?;
        let metadata = std::fs::symlink_metadata(&root)
            .with_context(|| format!("cannot inspect workspace root {}", root.display()))?;
        if metadata.file_type().is_symlink() {
            anyhow::bail!("workspace root {} must not be a symlink", root.display());
        }
        if !metadata.is_dir() {
            anyhow::bail!("workspace root {} is not a directory", root.display());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700));
        }
        std::fs::create_dir_all(root.join("workspaces")).with_context(|| {
            format!("cannot create workspace data root under {}", root.display())
        })?;
        let manager = Self {
            root,
            registry: AsyncMutex::new(()),
            leases: Mutex::new(HashMap::new()),
        };
        manager.reconcile()?;
        Ok(manager)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn registry_path(&self) -> PathBuf {
        self.root.join("registry.json")
    }

    fn workspace_dir(&self, workspace_id: &str) -> PathBuf {
        self.root.join("workspaces").join(workspace_id)
    }

    /// The durable directory for one validated managed Workspace identity.
    ///
    /// The caller must still acquire a lease; this accessor only maps the
    /// stable identity to its owned path.
    pub fn workspace_directory(&self, workspace_id: &str) -> Result<PathBuf> {
        if !is_valid_workspace_id(workspace_id) {
            anyhow::bail!("workspace id is not a valid managed workspace identity");
        }
        Ok(self.workspace_dir(workspace_id))
    }

    fn read_registry(&self) -> Result<RegistryFile> {
        let path = self.registry_path();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RegistryFile::default())
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("cannot read workspace registry {}", path.display()))
            }
        };
        let registry: RegistryFile = serde_json::from_slice(&bytes)
            .with_context(|| format!("workspace registry {} is malformed", path.display()))?;
        if registry.version != REGISTRY_VERSION {
            anyhow::bail!(
                "workspace registry version {} is not supported; expected {REGISTRY_VERSION}",
                registry.version
            );
        }
        registry.validate()?;
        Ok(registry)
    }

    fn write_registry(&self, registry: &RegistryFile) -> Result<()> {
        registry.validate()?;
        let path = self.registry_path();
        let temporary = self.root.join("registry.json.tmp");
        let bytes = serde_json::to_vec_pretty(registry)
            .context("cannot serialize the workspace registry")?;
        {
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temporary)
                .with_context(|| {
                    format!("cannot create workspace registry {}", temporary.display())
                })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
            }
            file.write_all(&bytes)
                .context("cannot write the workspace registry")?;
            file.sync_all()
                .context("cannot fsync the workspace registry")?;
        }
        std::fs::rename(&temporary, &path).with_context(|| {
            format!(
                "cannot publish workspace registry {} as {}",
                temporary.display(),
                path.display()
            )
        })?;
        if let Ok(directory) = std::fs::File::open(&self.root) {
            let _ = directory.sync_all();
        }
        Ok(())
    }

    /// Report missing directories without creating or adopting anything.
    fn reconcile(&self) -> Result<()> {
        let registry = self.read_registry()?;
        for record in &registry.workspaces {
            if !self.workspace_dir(&record.workspace_id).is_dir() {
                tracing::warn!(
                    workspace_id = %record.workspace_id,
                    "Agent Workspace metadata exists but its durable directory is missing"
                );
            }
        }
        Ok(())
    }

    fn lease_count(&self, workspace_id: &str) -> u32 {
        self.leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(workspace_id)
            .copied()
            .unwrap_or(0)
    }

    fn status_for(&self, workspace_id: &str) -> (WorkspaceStatus, Option<String>) {
        if self.lease_count(workspace_id) > 0 {
            return (WorkspaceStatus::InUse, None);
        }
        let path = self.workspace_dir(workspace_id);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => (
                WorkspaceStatus::Error,
                Some("workspace path is a symlink".to_string()),
            ),
            Ok(metadata) if metadata.is_dir() => (WorkspaceStatus::Available, None),
            Ok(_) => (
                WorkspaceStatus::Error,
                Some("workspace path is not a directory".to_string()),
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (
                WorkspaceStatus::Missing,
                Some("workspace directory is missing".to_string()),
            ),
            Err(error) => (
                WorkspaceStatus::Error,
                Some(format!("cannot inspect the workspace directory: {error}")),
            ),
        }
    }

    fn descriptor(&self, record: &WorkspaceRecord) -> AgentWorkspace {
        let (status, detail) = self.status_for(&record.workspace_id);
        AgentWorkspace {
            workspace_id: record.workspace_id.clone(),
            name: record.name.clone(),
            namespace: record.namespace.clone(),
            auto_created: record.auto_created,
            created_at: record.created_at,
            last_used_at: record.last_used_at,
            status,
            detail,
        }
    }

    /// List managed Workspaces, optionally filtered to one namespace.
    ///
    /// Status is measured now: a missing directory is `missing`, never
    /// recreated or claimed available.
    pub async fn list(&self, namespace: Option<&str>) -> Result<Vec<AgentWorkspace>> {
        let namespace = namespace.map(|value| value.trim().to_string());
        if let Some(namespace) = &namespace {
            if !namespace.is_empty() {
                protocol_validation(validate_workspace_namespace(namespace))?;
            }
        }
        let _guard = self.registry.lock().await;
        let registry = self.read_registry()?;
        let mut workspaces: Vec<AgentWorkspace> = registry
            .workspaces
            .iter()
            .filter(|record| {
                namespace
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .is_none_or(|value| record.namespace == value)
            })
            .map(|record| self.descriptor(record))
            .collect();
        workspaces.sort_by(|left, right| {
            left.namespace
                .cmp(&right.namespace)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.workspace_id.cmp(&right.workspace_id))
        });
        Ok(workspaces)
    }

    /// Idempotently resolve one managed Workspace by namespace and name.
    ///
    /// A missing directory is refused rather than recreated; an existing
    /// record and its bytes are reused. Concurrent callers observe one stable
    /// id because the registry mutation is serialized and persisted atomically.
    pub async fn get_or_create(
        &self,
        namespace: Option<&str>,
        name: &str,
        auto_created: bool,
    ) -> Result<AgentWorkspace> {
        protocol_validation(validate_workspace_name(name))?;
        let namespace = normalize_namespace(namespace)?;
        let normalized_name = normalize_workspace_name(name);
        let _guard = self.registry.lock().await;
        let mut registry = self.read_registry()?;
        if let Some(record) = registry.workspaces.iter_mut().find(|record| {
            record.namespace == namespace && record.normalized_name == normalized_name
        }) {
            if !self.workspace_dir(&record.workspace_id).is_dir() {
                anyhow::bail!(
                    "workspace `{}` exists in metadata but its durable directory is missing; refusing to recreate it",
                    record.name
                );
            }
            record.last_used_at = unix_now();
            let descriptor = self.descriptor(record);
            self.write_registry(&registry)?;
            return Ok(descriptor);
        }
        let workspace_id = format!("{WORKSPACE_ID_PREFIX}{}", Uuid::new_v4());
        let directory = self.workspace_dir(&workspace_id);
        std::fs::create_dir(&directory)
            .with_context(|| format!("cannot create managed workspace {}", directory.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700));
        }
        let now = unix_now();
        registry.workspaces.push(WorkspaceRecord {
            workspace_id,
            name: name.trim().to_string(),
            normalized_name,
            namespace,
            auto_created,
            created_at: now,
            last_used_at: now,
        });
        if let Err(error) = self.write_registry(&registry) {
            let _ = std::fs::remove_dir_all(&directory);
            return Err(error);
        }
        let Some(record) = registry.workspaces.last() else {
            anyhow::bail!("workspace registry lost the record it just inserted");
        };
        Ok(self.descriptor(record))
    }

    /// Delete one **managed** Workspace and its durable bytes.
    ///
    /// Refused while an RW lease exists. The path is one direct child named by
    /// the validated opaque id; this can never remove a Project Location.
    pub async fn delete(&self, workspace_id: &str) -> Result<()> {
        if !is_valid_workspace_id(workspace_id) {
            anyhow::bail!("workspace id is not a valid managed workspace identity");
        }
        let _guard = self.registry.lock().await;
        if self.lease_count(workspace_id) > 0 {
            anyhow::bail!("workspace is in use; release every attachment before deleting it");
        }
        let mut registry = self.read_registry()?;
        let Some(index) = registry
            .workspaces
            .iter()
            .position(|record| record.workspace_id == workspace_id)
        else {
            anyhow::bail!("workspace not found");
        };
        let directory = self.workspace_dir(workspace_id);
        match std::fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                anyhow::bail!("refusing to delete a workspace path that is a symlink")
            }
            Ok(metadata) if metadata.is_dir() => {
                std::fs::remove_dir_all(&directory).with_context(|| {
                    format!("cannot delete managed workspace {}", directory.display())
                })?;
            }
            Ok(_) => {
                anyhow::bail!("refusing to delete a workspace path that is not a directory")
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("cannot inspect managed workspace {}", directory.display())
                })
            }
        }
        registry.workspaces.remove(index);
        self.write_registry(&registry)
    }

    /// Acquire an exclusive RW attachment. The lease is in-memory and must be
    /// dropped when the execution releases the workspace.
    pub async fn lease(self: &Arc<Self>, workspace_id: &str) -> Result<WorkspaceLease> {
        if !is_valid_workspace_id(workspace_id) {
            anyhow::bail!("workspace id is not a valid managed workspace identity");
        }
        let _guard = self.registry.lock().await;
        let registry = self.read_registry()?;
        let Some(record) = registry
            .workspaces
            .iter()
            .find(|record| record.workspace_id == workspace_id)
        else {
            anyhow::bail!("workspace not found");
        };
        if !self.workspace_dir(&record.workspace_id).is_dir() {
            anyhow::bail!("workspace directory is missing");
        }
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *leases.entry(workspace_id.to_string()).or_insert(0) += 1;
        Ok(WorkspaceLease {
            manager: Arc::clone(self),
            workspace_id: workspace_id.to_string(),
        })
    }

    fn release(&self, workspace_id: &str) {
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(count) = leases.get_mut(workspace_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                leases.remove(workspace_id);
            }
        }
    }
}

impl RegistryFile {
    fn validate(&self) -> Result<()> {
        let mut ids = HashMap::new();
        let mut names = HashMap::new();
        for record in &self.workspaces {
            if !is_valid_workspace_id(&record.workspace_id) {
                anyhow::bail!(
                    "workspace registry contains an invalid workspace id `{}`",
                    record.workspace_id
                );
            }
            protocol_validation(validate_workspace_name(&record.name))?;
            if record.normalized_name != normalize_workspace_name(&record.name) {
                anyhow::bail!(
                    "workspace registry name `{}` has an inconsistent normalized alias",
                    record.name
                );
            }
            protocol_validation(validate_workspace_namespace(&record.namespace))?;
            if ids.insert(record.workspace_id.clone(), ()).is_some() {
                anyhow::bail!(
                    "workspace registry contains duplicate id `{}`",
                    record.workspace_id
                );
            }
            let key = (record.namespace.clone(), record.normalized_name.clone());
            if names.insert(key, ()).is_some() {
                anyhow::bail!(
                    "workspace registry contains duplicate name `{}` in namespace `{}`",
                    record.name,
                    record.namespace
                );
            }
        }
        Ok(())
    }
}

/// One RW attachment to a managed Workspace. Dropping it releases the lease.
pub struct WorkspaceLease {
    manager: Arc<WorkspaceManager>,
    workspace_id: String,
}

impl WorkspaceLease {
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }
}

impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        self.manager.release(&self.workspace_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn manager(root: &Path) -> Arc<WorkspaceManager> {
        Arc::new(WorkspaceManager::open(root.join("workspaces")).unwrap())
    }

    #[tokio::test]
    async fn concurrent_get_or_create_returns_one_stable_id() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path()).await;
        let first = tokio::spawn({
            let manager = Arc::clone(&manager);
            async move {
                manager
                    .get_or_create(None, "fix-terminal", true)
                    .await
                    .unwrap()
            }
        });
        let second = tokio::spawn({
            let manager = Arc::clone(&manager);
            async move {
                manager
                    .get_or_create(None, "fix-terminal", true)
                    .await
                    .unwrap()
            }
        });
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(first.workspace_id, second.workspace_id);
        assert!(is_valid_workspace_id(&first.workspace_id));
        assert!(manager.workspace_dir(&first.workspace_id).is_dir());
        assert_eq!(manager.list(None).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn restart_reuses_the_same_id_and_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = {
            let manager = manager(dir.path()).await;
            let workspace = manager
                .get_or_create(None, "reusable", false)
                .await
                .unwrap();
            std::fs::write(
                manager
                    .workspace_dir(&workspace.workspace_id)
                    .join("file.txt"),
                b"durable work",
            )
            .unwrap();
            workspace
        };
        let reopened = manager(dir.path()).await;
        let listed = reopened.list(None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_id, workspace.workspace_id);
        assert_eq!(listed[0].status, WorkspaceStatus::Available);
        assert_eq!(
            std::fs::read(
                reopened
                    .workspace_dir(&workspace.workspace_id)
                    .join("file.txt")
            )
            .unwrap(),
            b"durable work"
        );
    }

    #[tokio::test]
    async fn names_are_unique_per_namespace_not_globally() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path()).await;
        let default = manager.get_or_create(None, "dev", true).await.unwrap();
        let project = manager
            .get_or_create(Some("project:project-1"), "dev", true)
            .await
            .unwrap();
        assert_ne!(default.workspace_id, project.workspace_id);
        assert_eq!(manager.list(None).await.unwrap().len(), 2);
        let scoped = manager.list(Some("project:project-1")).await.unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].namespace, "project:project-1");
    }

    #[tokio::test]
    async fn a_missing_directory_is_missing_and_never_recreated() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path()).await;
        let workspace = manager.get_or_create(None, "vanished", true).await.unwrap();
        std::fs::remove_dir_all(manager.workspace_dir(&workspace.workspace_id)).unwrap();
        let listed = manager.list(None).await.unwrap();
        assert_eq!(listed[0].status, WorkspaceStatus::Missing);
        let error = manager
            .get_or_create(None, "vanished", true)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("refusing to recreate"));
        assert!(!manager.workspace_dir(&workspace.workspace_id).exists());
    }

    #[tokio::test]
    async fn delete_refuses_a_lease_and_removes_the_unleased_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path()).await;
        let workspace = manager
            .get_or_create(None, "temporary", false)
            .await
            .unwrap();
        let lease = manager.lease(&workspace.workspace_id).await.unwrap();
        assert_eq!(
            manager.list(None).await.unwrap()[0].status,
            WorkspaceStatus::InUse
        );
        let in_use = manager.delete(&workspace.workspace_id).await.unwrap_err();
        assert!(format!("{in_use:#}").contains("in use"));
        drop(lease);
        manager.delete(&workspace.workspace_id).await.unwrap();
        assert!(!manager.workspace_dir(&workspace.workspace_id).exists());
        assert!(manager.list(None).await.unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delete_refuses_a_symlinked_workspace_path() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep.txt"), b"keep").unwrap();
        let manager = manager(dir.path()).await;
        let workspace = manager.get_or_create(None, "link", false).await.unwrap();
        let path = manager.workspace_dir(&workspace.workspace_id);
        std::fs::remove_dir_all(&path).unwrap();
        std::os::unix::fs::symlink(outside.path(), &path).unwrap();
        let error = manager.delete(&workspace.workspace_id).await.unwrap_err();
        assert!(format!("{error:#}").contains("symlink"));
        assert!(outside.path().join("keep.txt").exists());
    }

    #[tokio::test]
    async fn invalid_names_namespaces_and_ids_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path()).await;
        for name in ["", "   ", ".", "..", "a/b", "a\\b"] {
            assert!(
                manager.get_or_create(None, name, true).await.is_err(),
                "{name}"
            );
        }
        for namespace in ["", "bad space", "bad/namespace"] {
            assert!(manager
                .get_or_create(Some(namespace), "ok", true)
                .await
                .is_err());
        }
        assert!(manager.delete("ws_not-a-uuid").await.is_err());
        assert!(manager.lease("ws_not-a-uuid").await.is_err());
    }

    #[tokio::test]
    async fn name_normalization_is_the_uniqueness_alias() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path()).await;
        let first = manager
            .get_or_create(None, "  Fix   Terminal ", true)
            .await
            .unwrap();
        let second = manager
            .get_or_create(None, "fix-terminal", false)
            .await
            .unwrap();
        assert_eq!(first.workspace_id, second.workspace_id);
        assert!(first.auto_created, "the original provenance is preserved");
    }

    #[tokio::test]
    async fn a_corrupt_or_unknown_registry_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspaces");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("registry.json"), b"{not-json").unwrap();
        assert!(WorkspaceManager::open(root.clone()).is_err());
        std::fs::write(
            root.join("registry.json"),
            br#"{"version":99,"workspaces":[]}"#,
        )
        .unwrap();
        assert!(WorkspaceManager::open(root).is_err());
    }
}
