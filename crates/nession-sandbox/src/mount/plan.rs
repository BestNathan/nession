//! Typed mount planning for one prepared Sandbox composition (#3695).
//!
//! The plan binds **prepared host views** to in-Sandbox targets. It is
//! deliberately independent of the physical mountpoint a backend derives:
//! client policy can never name a host path or a host mountpoint, and the
//! `MountPlan` carries only the typed source plus the Sandbox target.
//!
//! Compilation validates the plan's shape (roles, targets, overlap and
//! duplicates) deterministically. Execution resolves each entry through its
//! backend and retains an identified consumer lease.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use nession_protocol::contracts::sandbox::v1::SandboxWorkspaceOwnership;

use crate::error::{Result, SandboxError};
use crate::policy::{CompiledComposition, CompiledImage};
use crate::settings::SandboxSettings;

use super::overlay::OverlayWorkspaceKey;
use super::view::MountedComposition;

/// The maximum number of independent mount views one composition may bind.
pub const MAX_MOUNT_VIEWS: usize = 32;

/// An Overlay view. One persistent Workspace identity has one shared physical
/// Merged View; a transient RootFS has no workspace identity and is owned by a
/// single execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlaySource {
    /// `Some` for the persistent managed Workspace view; `None` for a
    /// transient writable RootFS.
    pub workspace: Option<OverlayWorkspaceKey>,
    /// Ordered read-only lowers; the first has the highest priority.
    pub lowers: Vec<ErofsSource>,
}

/// One typed, prepared host view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MountSource {
    /// An immutable, verified EROFS image file mounted read-only.
    Erofs(ErofsSource),
    /// A writable Overlay over one or more ordered read-only lowers.
    Overlay(OverlaySource),
    /// An Agent-validated canonical directory bound as-is.
    Bind {
        directory: PathBuf,
        ownership: SandboxWorkspaceOwnership,
    },
}

/// One prepared read-only EROFS source. The path is Agent-authorized; the
/// backend re-verifies it beneath the configured image root and hashes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErofsSource {
    pub digest: String,
    pub source: PathBuf,
}

impl ErofsSource {
    pub fn new(digest: impl Into<String>, source: impl Into<PathBuf>) -> Self {
        Self {
            digest: digest.into(),
            source: source.into(),
        }
    }
}

impl From<&CompiledImage> for ErofsSource {
    fn from(image: &CompiledImage) -> Self {
        Self {
            digest: image.digest.clone(),
            source: image.source.clone(),
        }
    }
}

/// The role one view plays in the composed execution.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum MountRole {
    /// The Base Runtime at `/`.
    Base,
    /// The writable `/workspace` view.
    Workspace,
    /// One read-only toolchain at `/opt/<name>`.
    Toolchain,
}

/// The backend family a source needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MountSourceKind {
    Erofs,
    Overlay,
    Bind,
}

impl MountRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Workspace => "workspace",
            Self::Toolchain => "toolchain",
        }
    }
}

/// One planned view: a prepared host source and its independent Sandbox target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountPlanEntry {
    pub role: MountRole,
    pub source: MountSource,
    /// The absolute in-Sandbox target. It is never a host mountpoint.
    pub target: PathBuf,
}

impl MountPlanEntry {
    pub fn source_kind(&self) -> MountSourceKind {
        match self.source {
            MountSource::Erofs(_) => MountSourceKind::Erofs,
            MountSource::Overlay(_) => MountSourceKind::Overlay,
            MountSource::Bind { .. } => MountSourceKind::Bind,
        }
    }

    pub fn read_only(&self) -> bool {
        !matches!(
            self.source,
            MountSource::Overlay(_) | MountSource::Bind { .. }
        )
    }
}

/// The identified consumer of every view in one plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountConsumer {
    execution_id: String,
}

impl MountConsumer {
    pub fn new(execution_id: impl Into<String>) -> Result<Self> {
        let execution_id = execution_id.into();
        if execution_id.trim().is_empty() {
            return Err(SandboxError::InvalidPolicy(
                "a Sandbox mount consumer needs a non-empty execution id".to_string(),
            ));
        }
        Ok(Self { execution_id })
    }

    pub fn execution_id(&self) -> &str {
        &self.execution_id
    }
}

/// The measured backend availability the plan depends on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MountCapabilities {
    /// The Agent's shared EROFS read-only mount manager plus an authorized
    /// image root.
    pub erofs_ro: bool,
    /// The Agent's shared Workspace Overlay manager.
    pub workspace_overlay: bool,
    /// The unprivileged `fuse-overlayfs`/`fusermount` helpers plus the
    /// authorized EROFS source root for an execution-owned transient view.
    pub transient_overlay: bool,
    /// A validated Agent-owned or Project Location directory can be bound.
    pub bind: bool,
}

impl MountCapabilities {
    pub fn from_settings(settings: &SandboxSettings) -> Self {
        let erofs_ro = settings.mount_manager.is_some() && settings.erofs_image_root.is_some();
        Self {
            erofs_ro,
            workspace_overlay: settings.overlay_manager.is_some(),
            transient_overlay: erofs_ro
                && nession_erofs::mount::executable(&settings.fuse_overlayfs_path)
                && nession_erofs::mount::executable(&settings.fusermount_path),
            bind: true,
        }
    }
}

/// A validated plan of independent views.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountPlan {
    entries: Vec<MountPlanEntry>,
}

impl MountPlan {
    /// Compile the prepared composition into independent views.
    ///
    /// Compilation performs no mount. It resolves the managed Workspace
    /// identity through the Agent-authorized Overlay manager, so an
    /// unauthorized writable directory fails before any host resource is
    /// created.
    pub fn compile(composition: &CompiledComposition, settings: &SandboxSettings) -> Result<Self> {
        let mut entries = Vec::new();
        let base_source = if composition.base_writable {
            MountSource::Overlay(OverlaySource {
                workspace: None,
                lowers: vec![ErofsSource::from(&composition.base)],
            })
        } else {
            MountSource::Erofs(ErofsSource::from(&composition.base))
        };
        entries.push(MountPlanEntry {
            role: MountRole::Base,
            source: base_source,
            target: Path::new("/").to_path_buf(),
        });
        let Some(workspace) = &composition.workspace else {
            return Err(SandboxError::InvalidPolicy(
                "filesystem.composition requires a workspace view".to_string(),
            ));
        };
        let workspace_entry = if workspace.has_lowers() {
            if workspace.ownership == SandboxWorkspaceOwnership::ProjectLocation {
                return Err(SandboxError::InvalidPolicy(
                    "a Project Location workspace cannot carry a Project EROFS lower".to_string(),
                ));
            }
            let manager = settings.overlay_manager.as_ref().ok_or_else(|| {
                SandboxError::UnsupportedPolicy(
                    "the workspace Overlay requires the Agent's shared Workspace Overlay \
                     manager"
                        .to_string(),
                )
            })?;
            let key = manager
                .resolve_workspace(&workspace.write)
                .map_err(|error| {
                    SandboxError::InvalidPolicy(format!(
                        "the workspace write directory {} is not an authorized Overlay \
                         workspace: {error:#}",
                        workspace.write.display()
                    ))
                })?;
            MountPlanEntry {
                role: MountRole::Workspace,
                source: MountSource::Overlay(OverlaySource {
                    workspace: Some(key),
                    lowers: workspace.lowers.iter().map(ErofsSource::from).collect(),
                }),
                target: Path::new("/workspace").to_path_buf(),
            }
        } else {
            MountPlanEntry {
                role: MountRole::Workspace,
                source: MountSource::Bind {
                    directory: workspace.write.clone(),
                    ownership: workspace.ownership,
                },
                target: Path::new("/workspace").to_path_buf(),
            }
        };
        entries.push(workspace_entry);
        for toolchain in &composition.toolchains {
            entries.push(MountPlanEntry {
                role: MountRole::Toolchain,
                source: MountSource::Erofs(ErofsSource::from(toolchain)),
                target: toolchain.target.clone(),
            });
        }
        let plan = Self { entries };
        plan.validate()?;
        Ok(plan)
    }

    pub fn entries(&self) -> &[MountPlanEntry] {
        &self.entries
    }

    /// Deterministic shape validation: no duplicate targets, no nested
    /// non-root targets, exactly one Base at `/`, one Workspace at
    /// `/workspace`, and only typed, absolute prepared sources.
    fn validate(&self) -> Result<()> {
        if self.entries.len() > MAX_MOUNT_VIEWS {
            return Err(SandboxError::InvalidPolicy(format!(
                "a Sandbox mount plan may carry at most {MAX_MOUNT_VIEWS} views"
            )));
        }
        let mut bases = 0usize;
        let mut workspaces = 0usize;
        let mut targets = BTreeSet::new();
        for entry in &self.entries {
            validate_target(&entry.target)?;
            if !targets.insert(entry.target.clone()) {
                return Err(SandboxError::InvalidPolicy(format!(
                    "sandbox mount target {} is duplicated",
                    entry.target.display()
                )));
            }
            match entry.role {
                MountRole::Base => {
                    bases += 1;
                    let valid = entry.target == Path::new("/")
                        && match &entry.source {
                            MountSource::Erofs(_) => true,
                            MountSource::Overlay(overlay) => overlay.workspace.is_none(),
                            MountSource::Bind { .. } => false,
                        };
                    if !valid {
                        return Err(SandboxError::InvalidPolicy(
                            "the Base Runtime view must be a read-only EROFS or a transient \
                             writable Overlay at `/`"
                                .to_string(),
                        ));
                    }
                }
                MountRole::Workspace => {
                    workspaces += 1;
                    if entry.target != Path::new("/workspace") {
                        return Err(SandboxError::InvalidPolicy(
                            "the Workspace view target must be /workspace".to_string(),
                        ));
                    }
                    let valid = match &entry.source {
                        MountSource::Overlay(overlay) => overlay.workspace.is_some(),
                        MountSource::Bind { .. } => true,
                        MountSource::Erofs(_) => false,
                    };
                    if !valid {
                        return Err(SandboxError::InvalidPolicy(
                            "the Workspace view must be a persistent writable Overlay or an \
                             authorized Bind"
                                .to_string(),
                        ));
                    }
                }
                MountRole::Toolchain => {
                    if entry.source_kind() != MountSourceKind::Erofs {
                        return Err(SandboxError::InvalidPolicy(
                            "a Toolchain view must be a read-only EROFS image".to_string(),
                        ));
                    }
                }
            }
            match &entry.source {
                MountSource::Erofs(source) => validate_erofs_source(source)?,
                MountSource::Overlay(overlay) => {
                    if let Some(workspace) = &overlay.workspace {
                        workspace.validate().map_err(|error| {
                            SandboxError::InvalidPolicy(format!(
                                "the Overlay workspace identity is invalid: {error:#}"
                            ))
                        })?;
                    }
                    validate_overlay_lowers(&overlay.lowers)?;
                }
                MountSource::Bind { directory, .. } => {
                    if !directory.is_absolute() {
                        return Err(SandboxError::InvalidPolicy(format!(
                            "the Workspace Bind directory {} must be absolute",
                            directory.display()
                        )));
                    }
                }
            }
        }
        if bases != 1 || workspaces != 1 {
            return Err(SandboxError::InvalidPolicy(
                "a Sandbox mount plan requires exactly one Base and one Workspace view".to_string(),
            ));
        }
        let non_root: Vec<&PathBuf> = targets
            .iter()
            .filter(|target| target.as_path() != Path::new("/"))
            .collect();
        for (index, left) in non_root.iter().enumerate() {
            for right in non_root.iter().skip(index + 1) {
                if left.starts_with(right) || right.starts_with(left) {
                    return Err(SandboxError::InvalidPolicy(format!(
                        "sandbox mount targets {} and {} overlap; one would hide the other",
                        left.display(),
                        right.display()
                    )));
                }
            }
        }
        Ok(())
    }

    /// Fail closed before execution when a required backend is unavailable.
    pub fn check_capabilities(&self, capabilities: &MountCapabilities) -> Result<()> {
        for entry in &self.entries {
            let (available, field) = match entry.source_kind() {
                MountSourceKind::Erofs => (
                    capabilities.erofs_ro,
                    "the shared EROFS read-only mount manager and an authorized image root",
                ),
                MountSourceKind::Overlay => {
                    let transient = matches!(
                        &entry.source,
                        MountSource::Overlay(OverlaySource {
                            workspace: None,
                            ..
                        })
                    );
                    if transient {
                        (
                            capabilities.transient_overlay,
                            "the unprivileged fuse-overlayfs/fusermount helpers and an authorized \
                             EROFS source root",
                        )
                    } else {
                        (
                            capabilities.workspace_overlay,
                            "the shared Workspace Overlay manager",
                        )
                    }
                }
                MountSourceKind::Bind => (capabilities.bind, "an authorized Bind directory"),
            };
            if !available {
                return Err(SandboxError::UnsupportedPolicy(format!(
                    "the {} view at {} requires {field}",
                    entry.role.as_str(),
                    entry.target.display()
                )));
            }
        }
        Ok(())
    }

    /// Acquire every planned view, retaining one identified consumer lease per
    /// view. A failure releases every view acquired so far.
    pub fn execute(
        &self,
        consumer: &MountConsumer,
        settings: &SandboxSettings,
        execution_dir: &Path,
    ) -> Result<MountedComposition> {
        self.check_capabilities(&MountCapabilities::from_settings(settings))?;
        let mut views = Vec::with_capacity(self.entries.len());
        for entry in &self.entries {
            let view = super::backends::acquire(entry, consumer, settings, execution_dir).map_err(
                |error| match error {
                    SandboxError::InvalidPolicy(message)
                    | SandboxError::UnsupportedPolicy(message)
                    | SandboxError::BackendUnavailable(message)
                    | SandboxError::Prepare(message)
                    | SandboxError::Verify(message)
                    | SandboxError::Cleanup(message) => SandboxError::Prepare(format!(
                        "cannot acquire the {} view at {}: {message}",
                        entry.role.as_str(),
                        entry.target.display()
                    )),
                    other @ SandboxError::UnsupportedRequests(_) => other,
                },
            );
            match view {
                Ok(view) => views.push(view),
                Err(error) => {
                    for view in views.iter_mut().rev() {
                        let _ = view.release();
                    }
                    return Err(error);
                }
            }
        }
        MountedComposition::new(views)
    }
}

fn validate_overlay_lowers(lowers: &[ErofsSource]) -> Result<()> {
    if lowers.is_empty() {
        return Err(SandboxError::InvalidPolicy(
            "an Overlay view needs at least one read-only lower".to_string(),
        ));
    }
    if lowers.len() > super::overlay::MAX_OVERLAY_LOWERS {
        return Err(SandboxError::InvalidPolicy(format!(
            "an Overlay view accepts at most {} ordered lowers",
            super::overlay::MAX_OVERLAY_LOWERS
        )));
    }
    let mut seen = BTreeSet::new();
    for lower in lowers {
        validate_erofs_source(lower)?;
        if !seen.insert(lower.digest.clone()) {
            return Err(SandboxError::InvalidPolicy(format!(
                "the ordered Overlay lower set repeats digest {}",
                lower.digest
            )));
        }
    }
    Ok(())
}

fn validate_erofs_source(source: &ErofsSource) -> Result<()> {
    if !nession_erofs::digest::is_valid_digest(&source.digest) {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image digest `{}` must be sha256:<64 lowercase hex>",
            source.digest
        )));
    }
    if !source.source.is_absolute() {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image source {} must be absolute",
            source.source.display()
        )));
    }
    Ok(())
}

fn validate_target(target: &Path) -> Result<()> {
    if !target.is_absolute() {
        return Err(SandboxError::InvalidPolicy(format!(
            "sandbox mount target {} must be absolute",
            target.display()
        )));
    }
    for component in target.components() {
        match component {
            Component::RootDir | Component::Normal(_) => {}
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                return Err(SandboxError::InvalidPolicy(format!(
                    "sandbox mount target {} must be normalized without `.` or `..`",
                    target.display()
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{CompiledImage, CompiledWorkspace};

    fn image(digest_char: char, source: &str, target: &str) -> CompiledImage {
        CompiledImage {
            digest: format!("sha256:{}", digest_char.to_string().repeat(64)),
            source: PathBuf::from(source),
            target: PathBuf::from(target),
            env: Vec::new(),
            path_prepend: None,
        }
    }

    fn composition(
        workspace: Option<CompiledWorkspace>,
        toolchains: Vec<CompiledImage>,
    ) -> CompiledComposition {
        CompiledComposition {
            base: image('a', "/images/base.erofs", "/"),
            base_writable: false,
            workspace: Some(workspace.unwrap_or(CompiledWorkspace {
                lowers: Vec::new(),
                write: PathBuf::from("/tmp/nession-workspace"),
                ownership: SandboxWorkspaceOwnership::Agent,
            })),
            toolchains,
        }
    }

    fn settings(root: &Path) -> SandboxSettings {
        SandboxSettings::new(
            root.join("state"),
            PathBuf::from("/bin/true"),
            PathBuf::from("/bin/true"),
            PathBuf::from("/bin/true"),
        )
    }

    #[test]
    fn a_bind_and_erofs_plan_separates_host_views_from_sandbox_targets() {
        let root = tempfile::tempdir().unwrap();
        let plan = MountPlan::compile(
            &composition(
                None,
                vec![image('b', "/images/tool.erofs", "/opt/toolchain")],
            ),
            &settings(root.path()),
        )
        .unwrap();
        assert_eq!(plan.entries().len(), 3);
        assert_eq!(plan.entries()[0].target, PathBuf::from("/"));
        assert_eq!(plan.entries()[0].source_kind(), MountSourceKind::Erofs);
        assert_eq!(plan.entries()[1].target, PathBuf::from("/workspace"));
        assert_eq!(plan.entries()[1].source_kind(), MountSourceKind::Bind);
        let MountSource::Bind { directory, .. } = &plan.entries()[1].source else {
            panic!("a bind workspace");
        };
        assert_eq!(directory, Path::new("/tmp/nession-workspace"));
        assert_eq!(plan.entries()[2].target, PathBuf::from("/opt/toolchain"));
    }

    #[test]
    fn duplicate_and_nested_targets_are_refused_deterministically() {
        let root = tempfile::tempdir().unwrap();
        let duplicate = composition(
            None,
            vec![
                image('b', "/images/one.erofs", "/opt/tool"),
                image('c', "/images/two.erofs", "/opt/tool"),
            ],
        );
        assert!(MountPlan::compile(&duplicate, &settings(root.path())).is_err());
        let nested = composition(
            None,
            vec![
                image('b', "/images/one.erofs", "/opt/tool"),
                image('c', "/images/two.erofs", "/opt/tool/nested"),
            ],
        );
        let error = MountPlan::compile(&nested, &settings(root.path())).unwrap_err();
        assert!(format!("{error}").contains("overlap"), "{error}");
    }

    #[test]
    fn an_unsafe_or_duplicate_source_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let mut relative = image('b', "/images/tool.erofs", "/opt/tool");
        relative.source = PathBuf::from("relative/tool.erofs");
        let error = MountPlan::compile(&composition(None, vec![relative]), &settings(root.path()))
            .unwrap_err();
        assert!(format!("{error}").contains("must be absolute"), "{error}");
        let mut bad_digest = image('z', "/images/tool.erofs", "/opt/tool");
        bad_digest.digest = "sha256:short".to_string();
        assert!(
            MountPlan::compile(&composition(None, vec![bad_digest]), &settings(root.path()))
                .is_err()
        );
    }

    #[test]
    fn a_missing_backend_is_an_explicit_unsupported_policy() {
        let root = tempfile::tempdir().unwrap();
        let plan = MountPlan::compile(
            &composition(None, vec![image('b', "/images/tool.erofs", "/opt/tool")]),
            &settings(root.path()),
        )
        .unwrap();
        let error = plan
            .check_capabilities(&MountCapabilities::default())
            .unwrap_err();
        assert!(format!("{error}").contains("shared EROFS read-only mount manager"));
        assert!(plan
            .check_capabilities(&MountCapabilities {
                erofs_ro: true,
                workspace_overlay: false,
                transient_overlay: true,
                bind: true,
            })
            .is_ok());
    }

    #[test]
    fn a_writable_base_is_a_transient_overlay_and_requires_the_overlay_capability() {
        let root = tempfile::tempdir().unwrap();
        let mut compiled = composition(None, Vec::new());
        compiled.base_writable = true;
        let plan = MountPlan::compile(&compiled, &settings(root.path())).unwrap();
        let MountSource::Overlay(source) = &plan.entries()[0].source else {
            panic!("a writable base is an Overlay source");
        };
        assert!(source.workspace.is_none(), "a RootFS has no workspace key");
        assert_eq!(source.lowers.len(), 1);
        let error = plan
            .check_capabilities(&MountCapabilities {
                erofs_ro: true,
                workspace_overlay: false,
                transient_overlay: false,
                bind: true,
            })
            .unwrap_err();
        assert!(format!("{error}").contains("fuse-overlayfs"), "{error}");
    }

    #[test]
    fn an_ordered_lower_set_is_typed_and_order_sensitive_in_the_plan() {
        let workspace = OverlayWorkspaceKey::new("/workspaces", "ws_a").unwrap();
        let lower = |digest_char: char, source: &str| {
            ErofsSource::new(
                format!("sha256:{}", digest_char.to_string().repeat(64)),
                source,
            )
        };
        let plan = MountPlan {
            entries: vec![
                MountPlanEntry {
                    role: MountRole::Base,
                    source: MountSource::Erofs(lower('a', "/images/base.erofs")),
                    target: PathBuf::from("/"),
                },
                MountPlanEntry {
                    role: MountRole::Workspace,
                    source: MountSource::Overlay(OverlaySource {
                        workspace: Some(workspace),
                        lowers: vec![
                            lower('b', "/images/top.erofs"),
                            lower('c', "/images/bottom.erofs"),
                        ],
                    }),
                    target: PathBuf::from("/workspace"),
                },
            ],
        };
        plan.validate().unwrap();
        let MountSource::Overlay(source) = &plan.entries()[1].source else {
            panic!("an Overlay workspace");
        };
        assert_eq!(
            source
                .lowers
                .iter()
                .map(|lower| lower.digest.clone())
                .collect::<Vec<_>>(),
            vec![
                format!("sha256:{}", "b".repeat(64)),
                format!("sha256:{}", "c".repeat(64))
            ]
        );

        let mut duplicate = plan.clone();
        let MountSource::Overlay(source) = &mut duplicate.entries[1].source else {
            panic!("an Overlay workspace");
        };
        source.lowers[1].digest = source.lowers[0].digest.clone();
        let error = duplicate.validate().unwrap_err();
        assert!(format!("{error}").contains("repeats digest"), "{error}");
    }

    #[test]
    fn a_workspace_overlay_needs_the_overlay_manager_and_an_authorized_root() {
        let root = tempfile::tempdir().unwrap();
        let workspace_root = root.path().join("workspaces");
        std::fs::create_dir_all(workspace_root.join("ws_a")).unwrap();
        let workspace = CompiledWorkspace {
            lowers: vec![image('d', "/images/project.erofs", "/workspace")],
            write: workspace_root.join("ws_a"),
            ownership: SandboxWorkspaceOwnership::Agent,
        };
        let error = MountPlan::compile(
            &composition(Some(workspace), Vec::new()),
            &settings(root.path()),
        )
        .unwrap_err();
        assert!(format!("{error}").contains("Overlay manager"), "{error}");

        // A Project Location can never carry a lower.
        let project = CompiledWorkspace {
            lowers: vec![image('d', "/images/project.erofs", "/workspace")],
            write: workspace_root.join("ws_a"),
            ownership: SandboxWorkspaceOwnership::ProjectLocation,
        };
        let error = MountPlan::compile(
            &composition(Some(project), Vec::new()),
            &settings(root.path()),
        )
        .unwrap_err();
        assert!(format!("{error}").contains("Project Location"), "{error}");
    }
}
