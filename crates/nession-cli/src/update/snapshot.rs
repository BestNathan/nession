//! Durable-state inventory and independent archive snapshots (#4592 §2).
//!
//! An upgrade **retains** Current's configuration, identity and durable state
//! in place; the archive receives *independent copies* of a bounded, owned
//! subset — never a rename of Current, never a blanket copy of the home.
//! Content-addressed stores (Server image blobs, Agent EROFS CAS) are
//! referenced by location/digest, not duplicated; reproducible caches and logs
//! are omitted; unknown durable roots are preserved in place and surfaced as
//! coverage gaps instead of a fake complete archive.
//!
//! The manifest is the archive's coverage record: it distinguishes
//! binary-complete from state-complete/runnable so historical selection can
//! gate data-touching commands on proven ownership (§5).

use crate::update::download;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Manifest schema written into every new archive.
///
/// Schema 2 (#4660) replaces the flat `gaps` list with typed `coverage` entries
/// so policy exclusions, provably-empty references and absent components are
/// distinguished from genuine missing state. Schema-1 archives are still read
/// conservatively by [`crate::versions::archive_state_coverage`]; they are never
/// rewritten or silently promoted to proven.
pub const MANIFEST_SCHEMA: u32 = 2;
pub const MANIFEST_FILE: &str = "manifest.json";

/// Agent-owned durable subdirectories snapshotted beside the identity file.
const AGENT_SNAPSHOT_DIRS: [&str; 4] = ["sessions", "claude", "env-bindings", "envs"];
/// Server-owned durable subdirectories snapshotted beside the database.
const SERVER_SNAPSHOT_DIRS: [&str; 1] = ["envs"];
/// Top-level home entries that are never part of a snapshot.
const EXCLUDED_ROOTS: [&str; 6] = [
    "versions",
    "update-check.json",
    ".update-cache",
    ".install-transaction.json",
    ".install-transaction.json.tmp",
    "erofs",
];

/// Installation-owned client connection context (#4682): retained in place
/// across upgrades, never copied into a release archive. Recognized so the
/// coverage record names them deliberately instead of as unknown entries.
const INSTALLATION_CLIENT_ENTRIES: [&str; 3] = [
    nession_common::paths::CLIENT_CONFIG_FILE,
    nession_common::paths::CLIENT_CONFIG_LOCK_FILE,
    nession_common::paths::CLIENT_CREDENTIALS_DIR,
];

/// The Agent's durable inbound credential file beside `agent-config.toml`
/// (owned by `nession-agent/src/token.rs`, #3440). It is a non-regenerable
/// secret bound to the Agent identity, so it is captured privately — never
/// treated as an unknown root and never exposed in diagnostics.
const AGENT_TOKEN_FILE: &str = "agent-config.token";

/// How one inventory entry is covered by the archive (#4660 Fix Direction 2).
///
/// The classes separate *intentional* omission from *unproven* state so a
/// policy exclusion or a provably-empty store can never masquerade as a missing
/// required snapshot, while a failed required capture or an unknown durable root
/// still fails closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageClass {
    /// An independent copy was captured and digest-verified.
    Captured,
    /// The component/data is absent by design (e.g. no Server DB on an
    /// Agent-only installation); there is nothing to snapshot.
    NotApplicable,
    /// Intentional policy exclusion: logs, runtime files, reproducible build
    /// workspace, regenerable shell caches, redundant config backups. Retained
    /// in place; never required runtime state.
    Excluded,
    /// A content-addressed store referenced in place, not copied. An empty
    /// store is safe (nothing to lose); a nonempty store needs verified
    /// independent ownership or pin/retention before historical execution.
    Referenced,
    /// A required capture failed (e.g. the SQLite backup). A genuine gap.
    Missing,
    /// An unknown durable root or unproven ownership. Preserved in place;
    /// historical execution that could touch it fails closed.
    Unknown,
}

/// Which component's required state an entry belongs to (#4660 Fix Direction 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageComponent {
    Agent,
    Server,
    /// A shared resource (content-addressed store) both components may touch.
    Shared,
}

/// One typed coverage record in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoverageEntry {
    /// Relative entry path, or a named category for a whole omitted class.
    pub path: String,
    pub class: CoverageClass,
    pub component: CoverageComponent,
    /// Non-secret explanation (never config/credential text).
    pub detail: String,
}

impl CoverageEntry {
    pub fn new(
        path: impl Into<String>,
        class: CoverageClass,
        component: CoverageComponent,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            path: path.into(),
            class,
            component,
            detail: detail.into(),
        }
    }

    /// Whether this entry blocks historical execution of `component`.
    ///
    /// Exclusions and provably-empty references never block. A nonempty
    /// referenced store is unsafe until pinned/owned (never assumed safe).
    /// Missing/unknown state blocks its owner; unknown shared state blocks both.
    pub fn blocks(&self, component: CoverageComponent, referenced_nonempty: bool) -> bool {
        match self.class {
            CoverageClass::Captured | CoverageClass::NotApplicable | CoverageClass::Excluded => {
                false
            }
            CoverageClass::Referenced => referenced_nonempty,
            CoverageClass::Missing | CoverageClass::Unknown => {
                self.component == component || self.component == CoverageComponent::Shared
            }
        }
    }
}

/// One independent copy in the snapshot plan, relative to the home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyEntry {
    pub relative: PathBuf,
    pub kind: CopyKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyKind {
    /// Byte-for-byte file copy (configs, identity, metadata records).
    File,
    /// Consistent SQLite backup (WAL accounted for).
    SqliteBackup,
}

/// A content-addressed store retained in place and referenced, not copied.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CasReference {
    pub relative: String,
    pub entries: u64,
    pub bytes: u64,
}

/// The archive coverage record (`manifest.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub release: String,
    /// The contract that produced this archive.
    pub created_by: String,
    pub binaries: BTreeMap<String, String>,
    /// Config copy digests (of the archived text) and rewrite actions.
    pub configs: BTreeMap<String, ConfigCoverage>,
    /// Snapshot entry digests, relative to the archive root.
    pub state: BTreeMap<String, String>,
    /// Content-addressed stores referenced but not copied.
    pub references: Vec<CasReference>,
    /// Typed coverage records (schema 2). Empty on legacy schema-1 archives,
    /// which are classified conservatively from `state_complete`/`gaps`.
    #[serde(default)]
    pub coverage: Vec<CoverageEntry>,
    /// Honest coverage gaps. Schema 2 keeps only genuine missing/unknown state
    /// here for display compatibility; schema 1 mixed exclusions into this list.
    #[serde(default)]
    pub gaps: Vec<String>,
    /// External mutable paths the archived config still declares.
    pub external_dependencies: Vec<String>,
    /// Whether every owned durable record was captured independently.
    pub state_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigCoverage {
    pub digest: String,
    pub rewritten_fields: Vec<String>,
    pub retained_fields: Vec<String>,
}

/// The bounded snapshot plan for one home.
#[derive(Debug, Clone, Default)]
pub struct SnapshotPlan {
    pub copies: Vec<CopyEntry>,
    pub references: Vec<CasReference>,
    /// Typed coverage for every inventory entry (schema 2).
    pub coverage: Vec<CoverageEntry>,
    pub estimated_bytes: u64,
}

impl SnapshotPlan {
    /// Whether a referenced store path holds any entries (nonempty CAS needs
    /// pin/retention before it is safe for historical execution).
    pub fn reference_nonempty(&self, relative: &str) -> bool {
        self.references
            .iter()
            .any(|r| r.relative == relative && r.entries > 0)
    }
}

/// Inventory the home and build the snapshot plan.
///
/// Fails closed on active mount points under the home (a mounted tree must
/// never be recursively copied) and on symlink aliasing that escapes the
/// intended roots. Unknown durable entries are preserved in place and recorded
/// as gaps — never blanket-moved or deleted.
pub fn plan(home: &Path) -> Result<SnapshotPlan> {
    let mounts = active_mounts_under(home)?;
    if !mounts.is_empty() {
        bail!(
            "active mount points exist under the Nession home ({}); upgrading now could copy \
             or disturb a live filesystem. Unmount them (or stop their consumers) and re-run \
             the install.",
            mounts
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    let mut plan = SnapshotPlan::default();
    let mut estimated = 0u64;

    // Configs: independent byte copies. An absent config is not-applicable for
    // its component (e.g. an Agent-only installation has no server config),
    // never a missing snapshot.
    for (name, component) in [
        ("agent-config.toml", CoverageComponent::Agent),
        ("server-config.toml", CoverageComponent::Server),
    ] {
        let path = home.join(name);
        if path.is_file() {
            estimated += file_len(&path);
            plan.copies.push(CopyEntry {
                relative: PathBuf::from(name),
                kind: CopyKind::File,
            });
            plan.coverage.push(CoverageEntry::new(
                name,
                CoverageClass::Captured,
                component,
                "independent byte copy of the retained config",
            ));
        } else {
            plan.coverage.push(CoverageEntry::new(
                name,
                CoverageClass::NotApplicable,
                component,
                "no such config at Current; the component is not configured",
            ));
        }
    }

    // The Agent's durable inbound credential (#3440, nession-agent/token.rs).
    // Provenance is known: a non-regenerable secret bound to the Agent identity.
    // Capture it privately so the archive preserves the credential pairing; it
    // is never an unknown root and its value never enters diagnostics.
    let token = home.join(AGENT_TOKEN_FILE);
    if token.is_file() {
        estimated += file_len(&token);
        plan.copies.push(CopyEntry {
            relative: PathBuf::from(AGENT_TOKEN_FILE),
            kind: CopyKind::File,
        });
        plan.coverage.push(CoverageEntry::new(
            AGENT_TOKEN_FILE,
            CoverageClass::Captured,
            CoverageComponent::Agent,
            "Agent inbound credential captured privately (owner: nession-agent token.rs)",
        ));
    }

    // The installation-owned client connection context (#4682): profile
    // metadata, its mutation lock and the private credential fallback are
    // live installation state, deliberately retained in place and NEVER
    // copied into a release archive (no secret duplication, no reset of the
    // current selection on upgrade). An intentional policy exclusion, so it
    // never blocks historical execution and is never an unknown root.
    for name in INSTALLATION_CLIENT_ENTRIES {
        if home.join(name).exists() {
            plan.coverage.push(CoverageEntry::new(
                name,
                CoverageClass::Excluded,
                CoverageComponent::Shared,
                "installation-owned client context retained in place, never archived (#4682)",
            ));
        }
    }

    // Agent identity + owned metadata subsets.
    let agent = home.join("agent");
    if agent.is_dir() {
        let identity = agent.join("identity");
        if identity.is_file() {
            estimated += file_len(&identity);
            plan.copies.push(CopyEntry {
                relative: PathBuf::from("agent/identity"),
                kind: CopyKind::File,
            });
            plan.coverage.push(CoverageEntry::new(
                "agent/identity",
                CoverageClass::Captured,
                CoverageComponent::Agent,
                "independent copy of the Agent identity",
            ));
        }
        for dir in AGENT_SNAPSHOT_DIRS {
            let root = agent.join(dir);
            if root.is_dir() {
                collect_tree(home, &root, &mut plan, &mut estimated)?;
            }
        }
        // Everything else under agent/ (logs, pid files, sockets, unknown
        // records) is preserved in place; an intentional policy exclusion.
        plan.coverage.push(CoverageEntry::new(
            "agent/logs+runtime",
            CoverageClass::Excluded,
            CoverageComponent::Agent,
            "logs and runtime files retained in place, not required runtime state",
        ));
    } else {
        plan.coverage.push(CoverageEntry::new(
            "agent",
            CoverageClass::NotApplicable,
            CoverageComponent::Agent,
            "no Agent state directory at Current",
        ));
    }

    // Server database (consistent backup) + owned env records.
    let server = home.join("server");
    if server.is_dir() {
        let db = server.join("server.db");
        if db.is_file() {
            estimated += file_len(&db) + file_len(&server.join("server.db-wal"));
            plan.copies.push(CopyEntry {
                relative: PathBuf::from("server/server.db"),
                kind: CopyKind::SqliteBackup,
            });
            // The capture reports Captured/Missing once the backup runs.
            plan.coverage.push(CoverageEntry::new(
                "server/server.db",
                CoverageClass::Captured,
                CoverageComponent::Server,
                "consistent SQLite backup (WAL accounted for)",
            ));
        } else {
            plan.coverage.push(CoverageEntry::new(
                "server/server.db",
                CoverageClass::NotApplicable,
                CoverageComponent::Server,
                "no Server database at Current; nothing to snapshot",
            ));
        }
        for dir in SERVER_SNAPSHOT_DIRS {
            let root = server.join(dir);
            if root.is_dir() {
                collect_tree(home, &root, &mut plan, &mut estimated)?;
            }
        }
        // Image blob store: content-addressed, referenced not copied. An empty
        // store is safe; a nonempty one needs pin/retention (never assumed safe).
        let blobs = server.join("images").join("blobs");
        if blobs.is_dir() {
            let reference = cas_reference(home, &blobs);
            let detail = if reference.entries == 0 {
                "empty content-addressed store referenced in place; nothing to lose"
            } else {
                "nonempty content-addressed store referenced in place; requires pin/retention \
                 or verified independent ownership before historical execution"
            };
            plan.coverage.push(CoverageEntry::new(
                "server/images/blobs",
                CoverageClass::Referenced,
                CoverageComponent::Server,
                detail,
            ));
            plan.references.push(reference);
        }
        let build = server.join("images").join("build");
        if build.is_dir() {
            plan.coverage.push(CoverageEntry::new(
                "server/images/build",
                CoverageClass::Excluded,
                CoverageComponent::Server,
                "reproducible build workspace retained in place, not required runtime state",
            ));
        }
        plan.coverage.push(CoverageEntry::new(
            "server/logs+runtime",
            CoverageClass::Excluded,
            CoverageComponent::Server,
            "logs and runtime files retained in place, not required runtime state",
        ));
    } else {
        plan.coverage.push(CoverageEntry::new(
            "server",
            CoverageClass::NotApplicable,
            CoverageComponent::Server,
            "no Server state directory at Current",
        ));
    }

    // Agent EROFS CAS (default root): referenced, never duplicated.
    let erofs = home.join("erofs");
    if erofs.is_dir() {
        let reference = cas_reference(home, &erofs);
        let detail = if reference.entries == 0 {
            "empty content-addressed store referenced in place; nothing to lose"
        } else {
            "nonempty content-addressed store referenced in place; requires pin/retention \
             or verified independent ownership before historical execution"
        };
        plan.coverage.push(CoverageEntry::new(
            "erofs",
            CoverageClass::Referenced,
            CoverageComponent::Shared,
            detail,
        ));
        plan.references.push(reference);
    }

    // Remaining top-level entries: classify by proven ownership/shape. Known
    // reproducible caches and redundant config backups are intentional
    // exclusions (retained in place); genuinely unknown durable roots are
    // preserved and surfaced as unproven, never blanket-copied or deleted.
    if let Ok(entries) = fs::read_dir(home) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if EXCLUDED_ROOTS.contains(&name.as_str())
                || name == "agent-config.toml"
                || name == "server-config.toml"
                || name == AGENT_TOKEN_FILE
                || name == "agent"
                || name == "server"
                || INSTALLATION_CLIENT_ENTRIES.contains(&name.as_str())
            {
                continue;
            }
            if is_config_backup(&name) {
                plan.coverage.push(CoverageEntry::new(
                    name,
                    CoverageClass::Excluded,
                    CoverageComponent::Agent,
                    "redundant config backup retained in place; the live config is captured",
                ));
            } else if is_regenerable_shell_cache(&name) {
                plan.coverage.push(CoverageEntry::new(
                    name,
                    CoverageClass::Excluded,
                    CoverageComponent::Shared,
                    "regenerable zsh completion/word-code cache retained in place",
                ));
            } else {
                plan.coverage.push(CoverageEntry::new(
                    name,
                    CoverageClass::Unknown,
                    CoverageComponent::Shared,
                    "unknown durable entry preserved in place; ownership unproven",
                ));
            }
        }
    }

    plan.estimated_bytes = estimated;
    Ok(plan)
}

/// Whether a top-level entry is a redundant backup of a known config file
/// (`<config>.bak` or `<config>.bak-<suffix>`). The live config is captured
/// independently, so the backup is not required runtime state. This recognizes
/// the backup *shape* only; it never excludes the live config or user history.
fn is_config_backup(name: &str) -> bool {
    for config in ["agent-config.toml", "server-config.toml"] {
        if name == format!("{config}.bak") || name.starts_with(&format!("{config}.bak-")) {
            return true;
        }
    }
    false
}

/// Whether a top-level entry is a regenerable zsh cache. `.zcompdump*` is
/// rebuilt by `compinit`; `*.zwc` is compiled word code rebuilt by `zcompile`.
/// User history (`.zsh_history`) and config (`.zshrc`, `.zprofile`, …) are NOT
/// regenerable and are never matched here.
fn is_regenerable_shell_cache(name: &str) -> bool {
    name.starts_with(".zcompdump") || name.ends_with(".zwc")
}

/// Recursively collect regular files under `root`, refusing escape symlinks
/// and skipping sockets/FIFOs (runtime state, never durable records).
fn collect_tree(
    home: &Path,
    root: &Path,
    plan: &mut SnapshotPlan,
    estimated: &mut u64,
) -> Result<()> {
    let entries =
        fs::read_dir(root).with_context(|| format!("failed to inventory {}", root.display()))?;
    let component = if relative(home, root).starts_with("server") {
        CoverageComponent::Server
    } else {
        CoverageComponent::Agent
    };
    plan.coverage.push(CoverageEntry::new(
        relative(home, root).display().to_string(),
        CoverageClass::Captured,
        component,
        "owned durable subtree snapshotted as independent copies",
    ));
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            let target = fs::read_link(&path)?;
            let resolved = if target.is_absolute() {
                target.clone()
            } else {
                path.parent().unwrap_or(home).join(&target)
            };
            if !resolved.starts_with(home) {
                bail!(
                    "the snapshot entry {} is a symlink escaping the Nession home ({}); \
                     refusing to follow it. Replace it with a regular file or an in-home \
                     target before upgrading.",
                    path.display(),
                    resolved.display()
                );
            }
            plan.coverage.push(CoverageEntry::new(
                relative(home, &path).display().to_string(),
                CoverageClass::Unknown,
                component,
                "symlink preserved in place, not snapshotted; ownership unproven",
            ));
            continue;
        }
        if file_type.is_dir() {
            collect_tree(home, &path, plan, estimated)?;
            continue;
        }
        if !file_type.is_file() {
            // Sockets, FIFOs, devices: runtime artifacts, excluded.
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".pid") || name.ends_with(".sock") {
            continue;
        }
        *estimated += file_len(&path);
        plan.copies.push(CopyEntry {
            relative: relative(home, &path),
            kind: CopyKind::File,
        });
    }
    Ok(())
}

fn relative(home: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(home).unwrap_or(path).to_path_buf()
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn cas_reference(home: &Path, root: &Path) -> CasReference {
    let mut entries = 0u64;
    let mut bytes = 0u64;
    if let Ok(walker) = fs::read_dir(root) {
        for entry in walker.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    entries += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    CasReference {
        relative: relative(home, root).display().to_string(),
        entries,
        bytes,
    }
}

/// Execute the plan into `staging` (the private archive stage). Current's
/// authoritative paths are never touched. Returns the per-entry digests and
/// whether the SQLite snapshot (if planned) succeeded.
pub fn capture(home: &Path, staging: &Path, plan: &SnapshotPlan) -> Result<CaptureReport> {
    let mut report = CaptureReport::default();
    for entry in &plan.copies {
        let source = home.join(&entry.relative);
        let destination = staging.join(&entry.relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        match entry.kind {
            CopyKind::File => {
                refuse_symlink(&source)?;
                fs::copy(&source, &destination).with_context(|| {
                    format!(
                        "failed to snapshot {} to {}",
                        source.display(),
                        destination.display()
                    )
                })?;
                private_mode(&destination);
            }
            CopyKind::SqliteBackup => match backup_sqlite(&source, &destination) {
                Ok(()) => {
                    private_mode(&destination);
                    report.db_captured = true;
                }
                Err(error) => {
                    // A failed required snapshot is a genuine `missing` gap,
                    // never a fake complete archive; Current's live DB is
                    // untouched. The backup API may have created a partial
                    // destination before failing — remove it so nothing
                    // masquerades as a snapshot.
                    let _ = fs::remove_file(&destination);
                    let _ = fs::remove_file(destination.with_extension("db-wal"));
                    let _ = fs::remove_file(destination.with_extension("db-shm"));
                    report.missing.push(format!(
                        "server/server.db: consistent backup failed ({error:#}); the archive \
                         has no independent database snapshot"
                    ));
                }
            },
        }
        if destination.is_file() {
            let digest = download::sha256_file(&destination)
                .with_context(|| format!("failed to hash snapshot {}", destination.display()))?;
            report
                .digests
                .insert(entry.relative.display().to_string(), digest);
        }
    }
    Ok(report)
}

/// What the capture actually produced.
#[derive(Debug, Clone, Default)]
pub struct CaptureReport {
    pub digests: BTreeMap<String, String>,
    /// Required captures that failed (genuine `missing` gaps).
    pub missing: Vec<String>,
    /// Whether the planned SQLite backup succeeded.
    pub db_captured: bool,
}

/// Finalize the plan's typed coverage with the capture result: a planned
/// `server/server.db` copy becomes `captured` only when the backup succeeded,
/// otherwise `missing`. Returns the coverage records and the genuine gaps
/// (missing/unknown only) for display compatibility.
pub fn finalize_coverage(
    plan: &SnapshotPlan,
    capture: &CaptureReport,
) -> (Vec<CoverageEntry>, Vec<String>) {
    let mut coverage = plan.coverage.clone();
    for entry in &mut coverage {
        if entry.path == "server/server.db" && entry.class == CoverageClass::Captured {
            if capture.db_captured {
                entry.detail = "consistent SQLite backup captured (WAL accounted for)".into();
            } else {
                entry.class = CoverageClass::Missing;
                entry.detail =
                    "required SQLite backup failed; no independent database snapshot".into();
            }
        }
    }
    let gaps = coverage
        .iter()
        .filter(|e| matches!(e.class, CoverageClass::Missing | CoverageClass::Unknown))
        .map(|e| format!("{}: {}", e.path, e.detail))
        .collect();
    (coverage, gaps)
}

/// Whether the typed coverage proves complete independent state for the whole
/// archive: no missing/unknown entries and no nonempty referenced store left
/// unpinned. External dependencies are checked separately by the caller.
pub fn coverage_state_complete(coverage: &[CoverageEntry], plan: &SnapshotPlan) -> bool {
    coverage.iter().all(|entry| match entry.class {
        CoverageClass::Missing | CoverageClass::Unknown => false,
        CoverageClass::Referenced => !plan.reference_nonempty(&entry.path),
        _ => true,
    })
}

/// Whether the typed coverage proves the required state of one component is
/// independently owned and safe for historical execution (#4660 Fix Direction
/// 3). The component's own entries must not be missing/unknown, and every
/// shared entry must be safe (a nonempty referenced store blocks until pinned).
/// Exclusions and provably-empty references never block.
pub fn coverage_component_proven(
    coverage: &[CoverageEntry],
    plan: &SnapshotPlan,
    component: CoverageComponent,
) -> bool {
    coverage.iter().all(|entry| {
        let nonempty =
            entry.class == CoverageClass::Referenced && plan.reference_nonempty(&entry.path);
        !entry.blocks(component, nonempty)
    })
}

/// Consistent SQLite snapshot via the backup API (WAL accounted for).
///
/// The upgrade preflight refuses a live Server, so the source is stopped;
/// the backup API still produces a transactionally consistent image even if
/// a WAL remains from an unclean shutdown.
pub fn backup_sqlite(source: &Path, destination: &Path) -> Result<()> {
    use rusqlite::{Connection, OpenFlags};
    let src = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("failed to open the source database {}", source.display()))?;
    let mut dst = Connection::open(destination)
        .with_context(|| format!("failed to create the snapshot {}", destination.display()))?;
    let backup = rusqlite::backup::Backup::new(&src, &mut dst)
        .context("failed to initialize the SQLite backup")?;
    backup
        .run_to_completion(256, Duration::from_millis(5), None)
        .context("the SQLite backup did not complete")?;
    Ok(())
}

fn refuse_symlink(path: &Path) -> Result<()> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            bail!(
                "refusing to snapshot through a symlink at {}; replace it with a regular file",
                path.display()
            );
        }
    }
    Ok(())
}

fn private_mode(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Write the archive manifest (owner-private; it names credential-bearing
/// config copies but never contains their text).
pub fn write_manifest(archive: &Path, manifest: &Manifest) -> Result<()> {
    let path = archive.join(MANIFEST_FILE);
    let body = serde_json::to_vec_pretty(manifest).context("failed to serialize the manifest")?;
    let mut options = fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .with_context(|| format!("failed to create {}", path.display()))?;
    use std::io::Write;
    file.write_all(&body)?;
    file.sync_all()?;
    Ok(())
}

/// Read an archive manifest, if present. Legacy archives have none.
pub fn read_manifest(archive: &Path) -> Option<Manifest> {
    let bytes = fs::read(archive.join(MANIFEST_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Active mount points at or under `home`. A mounted tree must never be
/// recursively copied by a snapshot.
pub fn active_mounts_under(home: &Path) -> Result<Vec<PathBuf>> {
    let table = mount_table()?;
    Ok(table
        .into_iter()
        .filter(|mount| mount.starts_with(home))
        .collect())
}

fn mount_table() -> Result<Vec<PathBuf>> {
    #[cfg(target_os = "linux")]
    {
        let text =
            fs::read_to_string("/proc/self/mounts").context("failed to read /proc/self/mounts")?;
        Ok(parse_proc_mounts(&text))
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("mount")
            .output()
            .context("failed to run mount to inspect active filesystems")?;
        Ok(parse_macos_mounts(&String::from_utf8_lossy(&output.stdout)))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Ok(Vec::new())
    }
}

/// Parse `/proc/self/mounts` mount points (second field, octal-escaped).
pub fn parse_proc_mounts(text: &str) -> Vec<PathBuf> {
    text.lines()
        .filter_map(|line| {
            let field = line.split_whitespace().nth(1)?;
            Some(PathBuf::from(unescape_octal(field)))
        })
        .collect()
}

/// Parse macOS `mount` output: `<device> on <mount point> (<type>, ...)`.
pub fn parse_macos_mounts(text: &str) -> Vec<PathBuf> {
    text.lines()
        .filter_map(|line| {
            let rest = line.split_once(" on ")?.1;
            let mount = rest.split_once(" (")?.0;
            Some(PathBuf::from(mount))
        })
        .collect()
}

fn unescape_octal(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes.get(i) == Some(&b'\\') && i + 4 <= bytes.len() {
            if let Some(digits) = field.get(i + 1..i + 4) {
                if digits.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
                    if let Ok(value) = u8::from_str_radix(digits, 8) {
                        out.push(value);
                        i += 4;
                        continue;
                    }
                }
            }
        }
        if let Some(&byte) = bytes.get(i) {
            out.push(byte);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn home_fixture() -> TempDir {
        let root = TempDir::new().unwrap();
        let home = root.path();
        fs::write(home.join("agent-config.toml"), "agent-config").unwrap();
        fs::write(home.join("server-config.toml"), "server-config").unwrap();
        fs::create_dir_all(home.join("agent/sessions/inst-1")).unwrap();
        fs::write(home.join("agent/identity"), "agent-123").unwrap();
        fs::write(home.join("agent/sessions/inst-1/meta.json"), "{}").unwrap();
        fs::create_dir_all(home.join("agent/logs")).unwrap();
        fs::write(home.join("agent/logs/agent.log"), "log").unwrap();
        fs::create_dir_all(home.join("agent/claude")).unwrap();
        fs::write(home.join("agent/claude/binding.json"), "{}").unwrap();
        fs::create_dir_all(home.join("server/envs")).unwrap();
        fs::write(home.join("server/envs/prod.env"), "K=V").unwrap();
        fs::create_dir_all(home.join("server/images/blobs")).unwrap();
        fs::write(home.join("server/images/blobs/sha256-abc"), "blob").unwrap();
        fs::create_dir_all(home.join("server/images/build")).unwrap();
        fs::write(home.join("server/images/build/tmp"), "build").unwrap();
        fs::create_dir_all(home.join("server/logs")).unwrap();
        fs::write(home.join("server/logs/server.log"), "log").unwrap();
        root
    }

    #[test]
    fn the_plan_copies_owned_records_and_references_cas() {
        let root = home_fixture();
        let plan = plan(root.path()).unwrap();
        let relatives: Vec<String> = plan
            .copies
            .iter()
            .map(|c| c.relative.display().to_string())
            .collect();
        assert!(relatives.contains(&"agent-config.toml".to_string()));
        assert!(relatives.contains(&"server-config.toml".to_string()));
        assert!(relatives.contains(&"agent/identity".to_string()));
        assert!(relatives.contains(&"agent/sessions/inst-1/meta.json".to_string()));
        assert!(relatives.contains(&"agent/claude/binding.json".to_string()));
        assert!(relatives.contains(&"server/envs/prod.env".to_string()));
        // Logs, build workspace and blobs are never copied.
        assert!(!relatives.iter().any(|r| r.contains("logs")));
        assert!(!relatives.iter().any(|r| r.contains("images")));
        assert_eq!(plan.references.len(), 1);
        assert_eq!(plan.references[0].relative, "server/images/blobs");
        assert_eq!(plan.references[0].entries, 1);
        assert!(plan.estimated_bytes > 0);
        // The nonempty blob store is a referenced dependency, not a copy.
        assert!(plan
            .coverage
            .iter()
            .any(|e| e.path == "server/images/blobs" && e.class == CoverageClass::Referenced));
        // Logs/build are intentional exclusions, never missing state.
        assert!(plan
            .coverage
            .iter()
            .any(|e| e.path == "server/images/build" && e.class == CoverageClass::Excluded));
        assert!(!plan
            .coverage
            .iter()
            .any(|e| matches!(e.class, CoverageClass::Missing | CoverageClass::Unknown)));
    }

    /// #4682: the installation-owned client context is retained in place and
    /// never copied into an archive — and recognizing it must not mark the
    /// snapshot state-incomplete (it is not an "unknown durable entry").
    #[test]
    fn the_installation_client_context_is_retained_not_archived() {
        let root = home_fixture();
        let home = root.path();
        fs::write(
            home.join(nession_common::paths::CLIENT_CONFIG_FILE),
            "schema_version = 1\ncurrent_profile = \"home\"\n",
        )
        .unwrap();
        fs::write(
            home.join(nession_common::paths::CLIENT_CONFIG_LOCK_FILE),
            "",
        )
        .unwrap();
        fs::create_dir_all(home.join(nession_common::paths::CLIENT_CREDENTIALS_DIR)).unwrap();
        fs::write(
            home.join(nession_common::paths::CLIENT_CREDENTIALS_DIR)
                .join("home.toml"),
            "endpoint = \"ws://host/ws\"\ntoken = \"canary\"\n",
        )
        .unwrap();

        let plan = plan(home).unwrap();
        let relatives: Vec<String> = plan
            .copies
            .iter()
            .map(|c| c.relative.display().to_string())
            .collect();
        assert!(
            !relatives.iter().any(|r| r.contains("client-")),
            "client context must never be copied into an archive: {relatives:?}"
        );
        // Schema 2: each client entry is a deliberate policy exclusion, never
        // an unknown/missing root, and never blocks historical execution.
        for name in INSTALLATION_CLIENT_ENTRIES {
            let entry = plan
                .coverage
                .iter()
                .find(|e| e.path == name)
                .unwrap_or_else(|| panic!("{name} must be recognized in coverage"));
            assert_eq!(entry.class, CoverageClass::Excluded, "{name}");
            assert!(!entry.blocks(CoverageComponent::Agent, false));
            assert!(!entry.blocks(CoverageComponent::Server, false));
        }
        assert!(
            !plan.coverage.iter().any(|e| e.path.contains("client-")
                && matches!(e.class, CoverageClass::Unknown | CoverageClass::Missing)),
            "recognized client entries are not unknown/missing: {:?}",
            plan.coverage
        );
    }

    #[test]
    fn unknown_durable_roots_are_gaps_not_copies() {
        let root = home_fixture();
        fs::create_dir_all(root.path().join("mystery-state")).unwrap();
        fs::write(root.path().join("mystery-state/record"), "x").unwrap();
        let plan = plan(root.path()).unwrap();
        assert!(plan.coverage.iter().any(|e| e.path == "mystery-state"
            && e.class == CoverageClass::Unknown
            && e.detail.contains("preserved in place")));
        assert!(!plan
            .copies
            .iter()
            .any(|c| c.relative.starts_with("mystery-state")));
    }

    #[test]
    fn agent_only_empty_stores_and_known_caches_are_not_missing() {
        let root = TempDir::new().unwrap();
        let home = root.path();
        // Agent-only installation: agent config/identity, a durable token,
        // a redundant config backup, regenerable zsh caches, empty CAS stores
        // and a server/ tree holding only images/{blobs,build} and logs.
        fs::write(home.join("agent-config.toml"), "agent-config").unwrap();
        fs::write(home.join("agent-config.token"), "secret-token-value").unwrap();
        fs::write(home.join("agent-config.toml.bak-20261127"), "old").unwrap();
        fs::write(home.join(".zcompdump-host-5.9"), "cache").unwrap();
        fs::write(home.join(".zshrc.zwc"), "compiled").unwrap();
        fs::create_dir_all(home.join("agent")).unwrap();
        fs::write(home.join("agent/identity"), "agent-id").unwrap();
        fs::create_dir_all(home.join("server/images/blobs")).unwrap();
        fs::create_dir_all(home.join("server/images/build")).unwrap();
        fs::create_dir_all(home.join("server/logs")).unwrap();
        fs::create_dir_all(home.join("erofs")).unwrap();

        let plan = plan(home).unwrap();
        // The token is a captured Agent credential, never an unknown root.
        assert!(plan
            .copies
            .iter()
            .any(|c| c.relative == Path::new("agent-config.token")));
        assert!(plan.coverage.iter().any(|e| e.path == "agent-config.token"
            && e.class == CoverageClass::Captured
            && e.component == CoverageComponent::Agent));
        // Config backup and zsh caches are exclusions; user history is unknown.
        assert!(plan
            .coverage
            .iter()
            .any(|e| e.path == "agent-config.toml.bak-20261127"
                && e.class == CoverageClass::Excluded));
        assert!(plan
            .coverage
            .iter()
            .any(|e| e.path == ".zcompdump-host-5.9" && e.class == CoverageClass::Excluded));
        assert!(plan
            .coverage
            .iter()
            .any(|e| e.path == ".zshrc.zwc" && e.class == CoverageClass::Excluded));
        // Empty CAS stores are referenced-safe; the absent Server DB is N/A.
        assert!(plan
            .coverage
            .iter()
            .any(|e| e.path == "erofs" && e.class == CoverageClass::Referenced));
        assert!(plan
            .coverage
            .iter()
            .any(|e| e.path == "server/server.db" && e.class == CoverageClass::NotApplicable));
        assert!(!plan.reference_nonempty("erofs"));
        assert!(!plan.reference_nonempty("server/images/blobs"));
        // Agent required state is proven despite the empty server tree.
        assert!(coverage_component_proven(
            &plan.coverage,
            &plan,
            CoverageComponent::Agent
        ));
    }

    #[test]
    fn a_nonempty_referenced_store_blocks_until_pinned() {
        let root = TempDir::new().unwrap();
        let home = root.path();
        fs::write(home.join("agent-config.toml"), "agent-config").unwrap();
        fs::create_dir_all(home.join("agent")).unwrap();
        fs::write(home.join("agent/identity"), "id").unwrap();
        fs::create_dir_all(home.join("erofs")).unwrap();
        fs::write(home.join("erofs/sha256-blob"), "data").unwrap();
        let plan = plan(home).unwrap();
        assert!(plan.reference_nonempty("erofs"));
        // A nonempty shared CAS is never assumed safe.
        assert!(!coverage_component_proven(
            &plan.coverage,
            &plan,
            CoverageComponent::Agent
        ));
        assert!(!coverage_state_complete(&plan.coverage, &plan));
    }

    #[test]
    fn user_history_and_config_are_not_regenerable_caches() {
        let root = TempDir::new().unwrap();
        let home = root.path();
        fs::write(home.join(".zsh_history"), "user history").unwrap();
        fs::write(home.join(".zshrc"), "user config").unwrap();
        fs::write(home.join(".zcompdump"), "cache").unwrap();
        let plan = plan(home).unwrap();
        // User history/config are unknown durable state, never blanket-excluded.
        assert!(plan
            .coverage
            .iter()
            .any(|e| e.path == ".zsh_history" && e.class == CoverageClass::Unknown));
        assert!(plan
            .coverage
            .iter()
            .any(|e| e.path == ".zshrc" && e.class == CoverageClass::Unknown));
        // Only the regenerable completion cache is excluded.
        assert!(plan
            .coverage
            .iter()
            .any(|e| e.path == ".zcompdump" && e.class == CoverageClass::Excluded));
        assert!(!coverage_component_proven(
            &plan.coverage,
            &plan,
            CoverageComponent::Agent
        ));
    }

    #[test]
    fn capture_produces_independent_copies_and_digests() {
        let root = home_fixture();
        let staging = root.path().join("stage");
        fs::create_dir_all(&staging).unwrap();
        let plan = plan(root.path()).unwrap();
        let report = capture(root.path(), &staging, &plan).unwrap();
        assert_eq!(
            fs::read_to_string(staging.join("agent/identity")).unwrap(),
            "agent-123"
        );
        assert!(report.digests.contains_key("agent/identity"));
        // Current is untouched.
        assert!(root.path().join("agent/identity").is_file());
        assert!(root.path().join("server/envs/prod.env").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn an_escaping_symlink_is_refused() {
        let root = home_fixture();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret"),
            root.path().join("agent/sessions/inst-1/escape"),
        )
        .unwrap();
        let error = plan(root.path()).unwrap_err();
        assert!(format!("{error:#}").contains("escaping the Nession home"));
    }

    #[test]
    fn sqlite_backup_is_consistent_and_independent() {
        let root = TempDir::new().unwrap();
        let src = root.path().join("source.db");
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
                 INSERT INTO projects VALUES ('p1', 'alpha');",
            )
            .unwrap();
            // Leave a WAL behind (unclean-shutdown shape): the backup must
            // still produce a complete, independent image.
        }
        let dst = root.path().join("snapshot.db");
        backup_sqlite(&src, &dst).unwrap();
        let conn = rusqlite::Connection::open(&dst).unwrap();
        let name: String = conn
            .query_row("SELECT name FROM projects WHERE id='p1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "alpha");
        // Independent: deleting the source does not affect the snapshot.
        fs::remove_file(&src).unwrap();
        let conn = rusqlite::Connection::open(&dst).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn a_corrupt_database_is_a_gap_not_a_fake_snapshot() {
        let root = TempDir::new().unwrap();
        let home = root.path();
        fs::create_dir_all(home.join("server")).unwrap();
        fs::write(home.join("server/server.db"), "not a sqlite database").unwrap();
        let plan = plan(home).unwrap();
        let staging = home.join("stage");
        fs::create_dir_all(&staging).unwrap();
        let report = capture(home, &staging, &plan).unwrap();
        assert!(!report.db_captured);
        assert!(report.missing.iter().any(|g| g.contains("backup failed")));
        assert!(!staging.join("server/server.db").exists());
        // Finalized coverage classifies the failed required backup as missing.
        let (coverage, gaps) = finalize_coverage(&plan, &report);
        assert!(coverage
            .iter()
            .any(|e| e.path == "server/server.db" && e.class == CoverageClass::Missing));
        assert!(gaps.iter().any(|g| g.contains("server/server.db")));
        assert!(!coverage_component_proven(
            &coverage,
            &plan,
            CoverageComponent::Server
        ));
    }

    #[test]
    fn proc_mounts_parse_the_second_field() {
        let text = "/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /home/op/.nession/mnt ext4 rw 0 0\n";
        let mounts = parse_proc_mounts(text);
        assert_eq!(mounts.len(), 2);
        assert_eq!(mounts[1], PathBuf::from("/home/op/.nession/mnt"));
    }

    #[test]
    fn macos_mount_output_parses_mount_points() {
        let text = "/dev/disk3s1 on / (apfs, local, journaled)\n/dev/disk4 on /Users/op/.nession/mnt (hfs, local)\n";
        let mounts = parse_macos_mounts(text);
        assert_eq!(mounts.len(), 2);
        assert_eq!(mounts[1], PathBuf::from("/Users/op/.nession/mnt"));
    }

    #[test]
    fn octal_escapes_in_mount_points_are_decoded() {
        assert_eq!(unescape_octal("/mnt/with\\040space"), "/mnt/with space");
        assert_eq!(unescape_octal("/plain"), "/plain");
    }

    #[test]
    fn manifest_roundtrips() {
        let root = TempDir::new().unwrap();
        let manifest = Manifest {
            schema: MANIFEST_SCHEMA,
            release: "0.35.0".into(),
            created_by: crate::update::UPGRADE_CONTRACT_TOKEN.into(),
            binaries: BTreeMap::new(),
            configs: BTreeMap::new(),
            state: BTreeMap::new(),
            references: vec![CasReference {
                relative: "erofs".into(),
                entries: 2,
                bytes: 10,
            }],
            coverage: vec![CoverageEntry::new(
                "erofs",
                CoverageClass::Referenced,
                CoverageComponent::Shared,
                "nonempty store",
            )],
            gaps: vec!["erofs: referenced".into()],
            external_dependencies: vec!["/srv/db".into()],
            state_complete: false,
        };
        write_manifest(root.path(), &manifest).unwrap();
        let read = read_manifest(root.path()).unwrap();
        assert_eq!(read.release, "0.35.0");
        assert!(!read.state_complete);
        assert_eq!(read.references[0].entries, 2);
        assert_eq!(read.coverage[0].class, CoverageClass::Referenced);
        assert!(read_manifest(&root.path().join("missing")).is_none());
    }

    #[test]
    fn a_legacy_schema1_manifest_reads_without_coverage() {
        let root = TempDir::new().unwrap();
        // A schema-1 archive predates typed coverage: no `coverage` key.
        let legacy = serde_json::json!({
            "schema": 1,
            "release": "0.35.0",
            "created_by": "nession-upgrade-v1",
            "binaries": {},
            "configs": {},
            "state": {},
            "references": [],
            "gaps": ["server/logs: retained"],
            "external_dependencies": [],
            "state_complete": false
        });
        fs::write(root.path().join(MANIFEST_FILE), legacy.to_string()).unwrap();
        let read = read_manifest(root.path()).unwrap();
        assert_eq!(read.schema, 1);
        assert!(read.coverage.is_empty());
        assert!(!read.state_complete);
    }
}
