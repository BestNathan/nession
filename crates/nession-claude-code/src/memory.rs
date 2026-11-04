//! Where Claude Code keeps this Session's Auto Memory (#2689).
//!
//! The durable resolution model — ownership, the worktree/`commondir` walk,
//! the project-key algorithm, the observed overrides and the state vocabulary —
//! is documented in
//! [`docs/architecture/claude-code-memory.md`](../../../docs/architecture/claude-code-memory.md).
//! This module is its executable owner.
//!
//! ## The identity is Claude's, not Nession's
//!
//! Claude Code stores Auto Memory under
//! `<config dir>/projects/<project>/memory/`, and `<project>` is derived from
//! the **repository**, so every worktree and subdirectory of one repository
//! shares a directory while two repositories never do. The rule is implemented
//! by Claude Code, and this module reproduces that rule from the facts a
//! Session already has; it does not invent a second repository selection.
//!
//! The repository identity is deliberately **not**
//! [`git.root`](https://github.com/BestNathan/nession) (`git rev-parse
//! --show-toplevel`): that answers the *current work tree*, which for a linked
//! worktree is the worktree's own root. Claude keys memory by the main working
//! copy, so two worktrees of one repository share. Spawning git here would also
//! make Memory unavailable whenever git is missing, while Claude's own resolver
//! is a filesystem walk that needs no git process. So the walk below mirrors
//! Claude's, including the `.git`-file/`commondir` handling that maps a linked
//! worktree back to its main working copy.
//!
//! ## Nothing is guessed
//!
//! Claude's effective location can change through `CLAUDE_CONFIG_DIR`,
//! `CLAUDE_CODE_PROJECT_DIR_NAME`, `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`,
//! `CLAUDE_CODE_REMOTE_MEMORY_DIR` and the `autoMemoryDirectory` setting. The
//! host observes the environment of the Session's own tmux server
//! ([`SessionClaudeConfig`]); when that observation is unavailable the answer is
//! [`Resolution::UnsupportedOverride`], never the default directory.
//!
//! `autoMemoryDirectory` is reported as unsupported rather than honoured: its
//! effective value depends on settings precedence (policy, `--settings`, local,
//! project, user) and, for a repository-supplied file, on workspace trust — and
//! the agent can verify neither. Reporting the default instead would read a
//! directory Claude Code may not be using, which is exactly the cross-project
//! leak this requirement forbids. A malformed or unreadable settings file is
//! treated the same way for the same reason; an explicit
//! `autoMemoryEnabled: false` is reported as [`Resolution::Disabled`].
//!
//! ## Project-directory key
//!
//! Upstream sanitises the repository path by replacing every character outside
//! `[A-Za-z0-9]` with `-`, and — when the result exceeds 200 UTF-16 units —
//! truncates it and appends a base-36 hash of the **original** path. The
//! functions below reproduce both, because a key derived differently silently
//! reads another directory (or nothing) instead of failing.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

use crate::protocol::memory::v1::{MemoryFileV1, MemoryRepositoryKindV1};
use crate::session_context::SessionClaudeConfig;

/// The directory name Claude Code uses for one project's Auto Memory.
const MEMORY_DIR: &str = "memory";

/// The index file inside [`MEMORY_DIR`]. It is always listed first.
pub const MEMORY_INDEX: &str = "MEMORY.md";

/// How deep the topic-file walk may go below the memory directory.
const MAX_DEPTH: usize = 8;

/// How many memory files one listing may carry.
pub const MAX_FILES: usize = 1_000;

/// Upstream's ceiling on a sanitised project key before it appends a hash.
const PROJECT_KEY_MAX: usize = 200;

/// Upstream's `CLAUDE_CODE_PROJECT_DIR_NAME` grammar.
const PROJECT_DIR_NAME_MAX: usize = 64;

/// The canonical repository identity, and the working tree the Session is in.
///
/// `root` is what Claude keys memory by; `working_root` is where the Session's
/// own `.claude/` directory lives. They differ for a linked worktree: memory is
/// shared with the main working copy, while settings come from the worktree the
/// user is actually editing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryIdentity {
    pub root: PathBuf,
    pub working_root: PathBuf,
    pub kind: MemoryRepositoryKindV1,
}

impl RepositoryIdentity {
    /// The response fields that disclose the identity.
    pub fn describe(&self) -> (String, MemoryRepositoryKindV1) {
        (self.root.to_string_lossy().into_owned(), self.kind)
    }
}

/// Why memory could not be resolved to a directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    Ready {
        repository: RepositoryIdentity,
        memory_directory: PathBuf,
    },
    /// The host could not name the Session or its working directory.
    Unavailable,
    /// `autoMemoryEnabled: false` in a readable settings file.
    Disabled,
    /// The effective Claude Code configuration cannot be verified from here.
    UnsupportedOverride(String),
    /// The filesystem refused a question the resolution depends on.
    Error(String),
}

/// What a memory directory contains.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scan {
    Missing,
    Error(String),
    Files {
        files: Vec<MemoryFileV1>,
        truncated: bool,
    },
}

/// Resolve this Session's Auto Memory directory.
///
/// `cwd` is the host's authoritative Session working directory. `config` is the
/// host's observation of the Session's Claude Code environment; `None` means it
/// could not be observed and is answered as an unsupported override rather than
/// guessed at.
pub fn resolve(cwd: &str, config: Option<&SessionClaudeConfig>) -> Resolution {
    let Some(config) = config else {
        return Resolution::UnsupportedOverride(
            "the Session's Claude Code configuration could not be observed".to_string(),
        );
    };

    let Some(cwd) = lexical_absolute(cwd) else {
        return Resolution::Unavailable;
    };

    let repository = match repository_identity(&cwd) {
        Ok(identity) => identity,
        Err(err) => return Resolution::Error(format!("repository identity: {err}")),
    };

    let home = session_home(config);

    // Upstream order: `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` wins over settings,
    // and it is an absolute directory rather than a project key.
    if let Some(raw) = non_empty(&config.memory_path_override) {
        return match expand_directory(raw, home.as_deref()) {
            Some(directory) => Resolution::Ready {
                repository,
                memory_directory: directory,
            },
            None => Resolution::UnsupportedOverride(
                "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE is not an absolute directory".to_string(),
            ),
        };
    }

    let config_dir = match non_empty(&config.config_dir) {
        Some(raw) => match expand_directory(raw, home.as_deref()) {
            Some(directory) => directory,
            None => {
                return Resolution::UnsupportedOverride(
                    "CLAUDE_CONFIG_DIR is not an absolute directory".to_string(),
                )
            }
        },
        None => match home {
            Some(ref home) => home.join(".claude"),
            None => {
                return Resolution::UnsupportedOverride(
                    "neither the Session's HOME nor CLAUDE_CONFIG_DIR could be observed"
                        .to_string(),
                )
            }
        },
    };

    let verdict = match settings_verdict(&config_dir, &cwd, &repository) {
        Ok(verdict) => verdict,
        Err(resolution) => return resolution,
    };
    match verdict {
        SettingsVerdict::Disabled => return Resolution::Disabled,
        SettingsVerdict::Unsupported(reason) => return Resolution::UnsupportedOverride(reason),
        SettingsVerdict::Clear => {}
    }

    // `CLAUDE_CODE_REMOTE_MEMORY_DIR` replaces the projects root; with a custom
    // config directory, a valid `CLAUDE_CODE_PROJECT_DIR_NAME` replaces the key
    // itself. Both are upstream behaviour, not Nession conventions.
    let (projects_root, key) = match non_empty(&config.remote_memory_dir) {
        Some(raw) => match expand_directory(raw, home.as_deref()) {
            Some(directory) => (directory, sanitized_project_key(&repository.root)),
            None => {
                return Resolution::UnsupportedOverride(
                    "CLAUDE_CODE_REMOTE_MEMORY_DIR is not an absolute directory".to_string(),
                )
            }
        },
        None => {
            let key = match non_empty(&config.project_dir_name) {
                Some(name) if config.config_dir.is_some() && valid_project_dir_name(name) => {
                    name.to_string()
                }
                // An invalid name is ignored by Claude Code, which falls back to
                // the sanitised path; mirroring that keeps one directory, not two.
                _ => sanitized_project_key(&repository.root),
            };
            (config_dir.join("projects"), key)
        }
    };

    Resolution::Ready {
        repository,
        memory_directory: projects_root.join(key).join(MEMORY_DIR),
    }
}

/// The settings-specific projection of [`Resolution`].
enum SettingsVerdict {
    Clear,
    Disabled,
    Unsupported(String),
}

/// List the Markdown files of a resolved memory directory.
pub fn scan(directory: &Path) -> Scan {
    match fs::metadata(directory) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Scan::Error("the memory path is not a directory".to_string()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Scan::Missing,
        Err(err) => return Scan::Error(err.to_string()),
    }

    let mut files = Vec::new();
    let mut truncated = false;

    // The index is the entry point, and it is added first so a capped listing
    // can never omit it. A missing index is normal for a memory directory that
    // only holds topic files.
    if let Some(index) = memory_file(directory, MEMORY_INDEX) {
        files.push(index);
    }

    if let Err(err) = walk(directory, directory, 0, &mut files, &mut truncated) {
        return Scan::Error(err.to_string());
    }

    files.sort_by(|a, b| {
        let a_index = a.path == MEMORY_INDEX;
        let b_index = b.path == MEMORY_INDEX;
        b_index.cmp(&a_index).then_with(|| a.path.cmp(&b.path))
    });
    files.dedup_by(|a, b| a.path == b.path);

    Scan::Files { files, truncated }
}

fn walk(
    root: &Path,
    current: &Path,
    depth: usize,
    files: &mut Vec<MemoryFileV1>,
    truncated: &mut bool,
) -> io::Result<()> {
    if depth > MAX_DEPTH {
        *truncated = true;
        return Ok(());
    }

    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let file_type = entry.file_type()?;

        // A symlink is never followed: the listing is a promise that each path
        // can be opened, and the reader separately refuses anything that
        // canonicalises outside the memory root.
        if file_type.is_symlink() {
            continue;
        }

        let path = entry.path();
        if file_type.is_dir() {
            walk(root, &path, depth + 1, files, truncated)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let Some(relative) = relative_path(root, &path) else {
            continue;
        };
        if relative == MEMORY_INDEX || !relative.ends_with(".md") {
            continue;
        }
        if files.len() >= MAX_FILES {
            *truncated = true;
            return Ok(());
        }
        if let Some(file) = memory_file(root, &relative) {
            files.push(file);
        }
    }

    Ok(())
}

fn memory_file(root: &Path, relative: &str) -> Option<MemoryFileV1> {
    let path = root.join(relative);
    // A symlink is not listed: the listing is a promise that the reader can
    // open the path, and the reader refuses anything that canonicalises
    // outside the memory root.
    if fs::symlink_metadata(&path).ok()?.file_type().is_symlink() {
        return None;
    }
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(MemoryFileV1 {
        path: relative.to_string(),
        size: usize::try_from(metadata.len()).unwrap_or(usize::MAX),
        content_type: "markdown".to_string(),
    })
}

/// The contract carries `/`-separated paths on every platform.
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        parts.push(component.as_os_str().to_str()?.to_string());
    }
    Some(parts.join("/"))
}

/// The canonical repository identity of `cwd`.
///
/// Mirrors Claude Code's walk: the nearest ancestor holding a `.git` entry is
/// the working root; a `.git` *file* pointing at `<common>/worktrees/<name>` is
/// a linked worktree whose identity is the main working copy.
pub fn repository_identity(cwd: &Path) -> io::Result<RepositoryIdentity> {
    let mut current = cwd;
    loop {
        match fs::symlink_metadata(current.join(".git")) {
            Ok(_) => {
                let working_root = current.to_path_buf();
                let root =
                    linked_worktree_root(&working_root).unwrap_or_else(|| working_root.clone());
                return Ok(RepositoryIdentity {
                    root,
                    working_root,
                    kind: MemoryRepositoryKindV1::Git,
                });
            }
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                match current.parent() {
                    Some(parent) if parent != current => current = parent,
                    _ => break,
                }
            }
            Err(err) => return Err(err),
        }
    }

    Ok(RepositoryIdentity {
        root: cwd.to_path_buf(),
        working_root: cwd.to_path_buf(),
        kind: MemoryRepositoryKindV1::ProjectRoot,
    })
}

/// The main working copy of a linked worktree, or `None` for a normal checkout
/// (or anything the upstream checks reject).
fn linked_worktree_root(working_root: &Path) -> Option<PathBuf> {
    let git_entry = working_root.join(".git");
    let metadata = fs::symlink_metadata(&git_entry).ok()?;
    if !metadata.is_file() {
        return None;
    }

    let pointer = fs::read_to_string(&git_entry).ok()?;
    let git_dir = pointer.trim().strip_prefix("gitdir:")?.trim();
    let git_dir = lexical_absolute(git_dir)?;

    let common = fs::read_to_string(git_dir.join("commondir")).ok()?;
    let common = common.trim();
    let common_dir = lexical_absolute_path(&git_dir.join(common))?;

    // Only a real linked worktree passes the remaining checks. Anything else —
    // a submodule, a relocated git dir — keeps the working root as its identity,
    // exactly as Claude Code does.
    if !same_path(git_dir.parent()?, &common_dir.join("worktrees")) {
        return None;
    }
    let back_pointer = fs::read_to_string(git_dir.join("gitdir")).ok()?;
    if !same_path(
        &lexical_absolute(back_pointer.trim())?,
        &working_root.join(".git"),
    ) {
        return None;
    }

    if common_dir.file_name().is_some_and(|name| name == ".git") {
        return common_dir.parent().map(Path::to_path_buf);
    }
    if common_dir.join(".git").exists() {
        return None;
    }
    Some(common_dir)
}

/// Whether two paths name the same place, resolving symlinks when the
/// filesystem allows it and falling back to the lexical spelling otherwise.
fn same_path(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    left == right
}

/// The project-directory key Claude Code derives from a repository root.
pub fn sanitized_project_key(root: &Path) -> String {
    let raw = nfc(&root.to_string_lossy());
    let mut sanitized = String::with_capacity(raw.len());
    for unit in raw.encode_utf16() {
        let character = char::from_u32(u32::from(unit)).unwrap_or('-');
        if character.is_ascii_alphanumeric() {
            sanitized.push(character);
        } else {
            sanitized.push('-');
        }
    }

    if sanitized.len() <= PROJECT_KEY_MAX {
        return sanitized;
    }

    let truncated: String = sanitized.chars().take(PROJECT_KEY_MAX).collect();
    format!("{truncated}-{}", base36_abs(hash_utf16(&raw)))
}

/// Upstream's `(e << 5) - e + charCodeAt(i) | 0` JavaScript string hash.
fn hash_utf16(value: &str) -> i32 {
    let mut hash: i32 = 0;
    for unit in value.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit));
    }
    hash
}

fn base36_abs(value: i32) -> String {
    let mut value = i64::from(value).unsigned_abs();
    if value == 0 {
        return "0".to_string();
    }
    let mut reversed = Vec::new();
    while value > 0 {
        let digit = u8::try_from(value % 36).unwrap_or(0);
        reversed.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        value /= 36;
    }
    reversed.reverse();
    // Every byte was produced from the base-36 alphabet, so this is ASCII by
    // construction; building the String avoids an unreachable `expect`.
    reversed.into_iter().map(char::from).collect()
}

/// Whether `name` is a valid `CLAUDE_CODE_PROJECT_DIR_NAME`.
fn valid_project_dir_name(name: &str) -> bool {
    if name.is_empty() || name.len() > PROJECT_DIR_NAME_MAX {
        return false;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return false;
    }
    const RESERVED: [&str; 4] = ["con", "prn", "aux", "nul"];
    let lower = name.to_ascii_lowercase();
    if RESERVED.contains(&lower.as_str()) {
        return false;
    }
    if let Some(number) = lower
        .strip_prefix("com")
        .or_else(|| lower.strip_prefix("lpt"))
    {
        if number.len() == 1 && number.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    true
}

fn session_home(config: &SessionClaudeConfig) -> Option<PathBuf> {
    non_empty(&config.home)
        .and_then(lexical_absolute)
        .or_else(dirs::home_dir)
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Claude Code accepts an absolute directory or one starting with `~/`.
fn expand_directory(raw: &str, home: Option<&Path>) -> Option<PathBuf> {
    if raw == "~" {
        return home.map(Path::to_path_buf);
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return home.map(|home| home.join(rest));
    }
    lexical_absolute(raw)
}

fn lexical_absolute(raw: &str) -> Option<PathBuf> {
    lexical_absolute_path(Path::new(raw))
}

fn lexical_absolute_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    std::path::absolute(path)
        .ok()
        .map(|path| normalize_lexical(&path))
}

/// Resolve `.` and `..` without touching the filesystem.
///
/// `std::path::absolute` makes a path absolute but leaves `..` components in
/// place on this platform. Claude's `path.resolve` collapses them, and a key
/// that still contains `..` names a different directory.
fn normalize_lexical(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // At the root there is nowhere to go up to; the root is the
                // answer, exactly as `path.resolve` treats it.
                if normalized.parent().is_some() {
                    normalized.pop();
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn nfc(value: &str) -> String {
    value.nfc().collect()
}

/// Whether a readable settings file changes where memory lives, or turns it
/// off. `autoMemoryDirectory` is never honoured — see the module docs.
fn settings_verdict(
    config_dir: &Path,
    cwd: &Path,
    repository: &RepositoryIdentity,
) -> Result<SettingsVerdict, Resolution> {
    let mut files = Vec::new();
    files.extend(managed_settings_paths());
    files.push(config_dir.join("settings.json"));
    for directory in settings_directories(cwd, &repository.working_root) {
        files.push(directory.join(".claude/settings.json"));
        files.push(directory.join(".claude/settings.local.json"));
    }

    let mut enabled: Option<bool> = None;
    for path in files {
        let Some(settings) = read_settings(&path)? else {
            continue;
        };
        if settings.get("autoMemoryDirectory").is_some() {
            return Ok(SettingsVerdict::Unsupported(format!(
                "autoMemoryDirectory is set in {}; its effective value depends on settings precedence and workspace trust, which this host cannot verify",
                path.display()
            )));
        }
        if let Some(value) = settings
            .get("autoMemoryEnabled")
            .and_then(serde_json::Value::as_bool)
        {
            enabled = match enabled {
                None => Some(value),
                Some(previous) if previous == value => Some(previous),
                Some(_) => {
                    return Ok(SettingsVerdict::Unsupported(format!(
                        "autoMemoryEnabled disagrees between settings files, including {}",
                        path.display()
                    )))
                }
            };
        }
    }

    Ok(match enabled {
        Some(false) => SettingsVerdict::Disabled,
        _ => SettingsVerdict::Clear,
    })
}

/// A settings file that cannot be read or parsed makes the effective
/// configuration unverifiable; it must not silently fall back to the default.
fn read_settings(path: &Path) -> Result<Option<serde_json::Value>, Resolution> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(Resolution::Error(format!(
                "settings file {} could not be read: {err}",
                path.display()
            )))
        }
    };
    serde_json::from_str(&text).map(Some).map_err(|err| {
        Resolution::UnsupportedOverride(format!(
            "settings file {} could not be parsed, so the effective memory location is unverifiable: {err}",
            path.display()
        ))
    })
}

/// The Session's own settings directories, nearest first, up to the working
/// root. Claude Code merges project settings from the directories enclosing the
/// working directory, so checking only the root would miss a nearer override.
fn settings_directories(cwd: &Path, working_root: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut current = Some(cwd);
    while let Some(directory) = current {
        directories.push(directory.to_path_buf());
        if directory == working_root {
            break;
        }
        current = directory.parent();
    }
    if !directories
        .iter()
        .any(|directory| directory == working_root)
    {
        directories.push(working_root.to_path_buf());
    }
    directories
}

/// Claude Code's machine-managed settings locations, plus their drop-in
/// directories. A policy file that sets `autoMemoryDirectory` overrides every
/// user/project scope, so it is part of "can this be verified?".
///
/// Tests default to **no** policy source rather than the machine's real one, so
/// a developer's `/etc/claude-code` cannot change a test result. The test that
/// exercises policy detection sets its own root through
/// [`ManagedSettingsRootForTest`].
fn managed_settings_paths() -> Vec<PathBuf> {
    #[cfg(test)]
    let root = match MANAGED_SETTINGS_ROOT.with(|cell| cell.borrow().clone()) {
        Some(root) => root,
        None => return Vec::new(),
    };
    #[cfg(not(test))]
    let root = if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode")
    } else if cfg!(windows) {
        PathBuf::from(r"C:\Program Files\ClaudeCode")
    } else {
        PathBuf::from("/etc/claude-code")
    };

    let mut paths = vec![root.join("managed-settings.json")];
    if let Ok(entries) = fs::read_dir(root.join("managed-settings.d")) {
        let mut drop_ins: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        drop_ins.sort();
        paths.extend(drop_ins);
    }
    paths
}

#[cfg(test)]
thread_local! {
    /// Where the test build looks for policy settings. Unset means "none", so a
    /// machine-wide policy file cannot reach a test.
    static MANAGED_SETTINGS_ROOT: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// Points policy detection at a temporary tree for as long as it is alive.
#[cfg(test)]
pub(crate) struct ManagedSettingsRootForTest(Option<PathBuf>);

#[cfg(test)]
impl ManagedSettingsRootForTest {
    pub(crate) fn set(root: PathBuf) -> Self {
        MANAGED_SETTINGS_ROOT.with(|cell| Self(cell.replace(Some(root))))
    }
}

#[cfg(test)]
impl Drop for ManagedSettingsRootForTest {
    fn drop(&mut self) {
        let previous = self.0.take();
        MANAGED_SETTINGS_ROOT.with(|cell| {
            cell.replace(previous);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(home: &Path, config_dir: &Path) -> SessionClaudeConfig {
        SessionClaudeConfig {
            home: Some(home.to_string_lossy().into_owned()),
            config_dir: Some(config_dir.to_string_lossy().into_owned()),
            ..SessionClaudeConfig::default()
        }
    }

    fn ready(resolution: Resolution) -> (RepositoryIdentity, PathBuf) {
        match resolution {
            Resolution::Ready {
                repository,
                memory_directory,
            } => (repository, memory_directory),
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    fn git_dir(root: &Path) {
        fs::create_dir_all(root.join(".git")).unwrap();
    }

    #[test]
    fn a_nested_directory_resolves_to_the_repository_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        git_dir(root);
        let nested = root.join("crates/thing/src");
        fs::create_dir_all(&nested).unwrap();

        let (repository, _) = ready(resolve(
            &nested.to_string_lossy(),
            Some(&config(temp.path(), &root.join(".claude"))),
        ));
        assert_eq!(repository.root, root);
        assert_eq!(repository.kind, MemoryRepositoryKindV1::Git);
    }

    #[test]
    fn linked_worktrees_share_the_main_working_copy_identity() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let worktree = temp.path().join("wt");
        fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        fs::create_dir_all(&worktree).unwrap();

        let git_dir = main.join(".git/worktrees/wt");
        fs::write(git_dir.join("commondir"), "../..\n").unwrap();
        let back_pointer = worktree.join(".git").to_string_lossy().into_owned();
        fs::write(git_dir.join("gitdir"), back_pointer).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", git_dir.display()),
        )
        .unwrap();

        let (repository, _) = ready(resolve(
            &worktree.to_string_lossy(),
            Some(&config(temp.path(), &main.join(".claude"))),
        ));
        assert_eq!(repository.root, main);
        assert_eq!(repository.working_root, worktree);
    }

    #[test]
    fn a_submodule_keeps_its_own_working_root_as_identity() {
        let temp = tempfile::tempdir().unwrap();
        let superproject = temp.path().join("super");
        let module = superproject.join("vendor/module");
        let module_git_dir = superproject.join(".git/modules/module");
        fs::create_dir_all(&module_git_dir).unwrap();
        fs::create_dir_all(&module).unwrap();
        fs::write(
            module.join(".git"),
            format!("gitdir: {}\n", module_git_dir.display()),
        )
        .unwrap();

        let (repository, _) = ready(resolve(
            &module.to_string_lossy(),
            Some(&config(temp.path(), &temp.path().join("cfg"))),
        ));
        assert_eq!(repository.root, module);
    }

    #[test]
    fn a_non_git_directory_falls_back_to_its_own_root() {
        let temp = tempfile::tempdir().unwrap();
        let scratch = temp.path().join("scratch");
        fs::create_dir_all(&scratch).unwrap();

        let (repository, _) = ready(resolve(
            &scratch.to_string_lossy(),
            Some(&config(temp.path(), &temp.path().join("cfg"))),
        ));
        assert_eq!(repository.root, scratch);
        assert_eq!(repository.kind, MemoryRepositoryKindV1::ProjectRoot);
    }

    #[test]
    fn the_project_key_matches_claudes_sanitization() {
        assert_eq!(
            sanitized_project_key(Path::new("/Users/admin/workspace/learn/nession")),
            "-Users-admin-workspace-learn-nession"
        );
        assert_eq!(
            sanitized_project_key(Path::new(
                "/Users/admin/workspace/learn/nession/.claude/worktrees/x"
            )),
            "-Users-admin-workspace-learn-nession--claude-worktrees-x"
        );
    }

    #[test]
    fn a_long_project_key_is_truncated_with_upstreams_hash() {
        // Computed from Claude Code 2.1.318's own sanitizer: 200 dashes/letters
        // followed by a dash and `Math.abs(hash).toString(36)`. The exact value
        // is pinned so a "cleaner" hash in Rust cannot silently diverge.
        let long = format!("/{}", "a".repeat(260));
        let key = sanitized_project_key(Path::new(&long));
        assert_eq!(key.len(), 200 + 1 + key.rsplit('-').next().unwrap().len());
        assert_eq!(
            key,
            // node -e 'const s="/"+"a".repeat(260); console.log(...)'
            include_str!("../tests/fixtures/long_project_key.txt").trim()
        );
    }

    #[test]
    fn two_repositories_do_not_share_a_key() {
        let left = sanitized_project_key(Path::new("/work/left"));
        let right = sanitized_project_key(Path::new("/work/right"));
        assert_ne!(left, right);
    }

    #[test]
    fn an_absent_memory_directory_is_missing_not_empty_memory() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(scan(&temp.path().join("nope")), Scan::Missing);
    }

    #[test]
    fn the_index_is_listed_first_and_only_markdown_is_listed() {
        let temp = tempfile::tempdir().unwrap();
        let memory = temp.path();
        fs::write(memory.join("MEMORY.md"), "# index").unwrap();
        fs::write(memory.join("feedback.md"), "# feedback").unwrap();
        fs::write(memory.join("notes.json"), "{}").unwrap();
        fs::create_dir_all(memory.join("topics")).unwrap();
        fs::write(memory.join("topics/nested.md"), "# nested").unwrap();

        let Scan::Files { files, .. } = scan(memory) else {
            panic!("expected files");
        };
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, ["MEMORY.md", "feedback.md", "topics/nested.md"]);
        assert!(files.iter().all(|file| file.content_type == "markdown"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_never_listed() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let memory = temp.path().join("memory");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&memory).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "secret").unwrap();
        symlink(outside.join("secret.md"), memory.join("link.md")).unwrap();

        let Scan::Files { files, .. } = scan(&memory) else {
            panic!("expected files");
        };
        assert!(files.is_empty(), "{files:?}");
    }

    #[test]
    fn auto_memory_directory_is_reported_as_unverifiable() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join(".claude")).unwrap();
        fs::write(
            repo.join(".claude/settings.json"),
            r#"{"autoMemoryDirectory":"~/elsewhere"}"#,
        )
        .unwrap();

        let resolution = resolve(
            &repo.to_string_lossy(),
            Some(&config(temp.path(), &temp.path().join("cfg"))),
        );
        assert!(
            matches!(resolution, Resolution::UnsupportedOverride(ref reason) if reason.contains("autoMemoryDirectory")),
            "{resolution:?}"
        );
    }

    #[test]
    fn a_policy_override_also_makes_the_location_unverifiable() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let managed = temp.path().join("managed");
        fs::create_dir_all(&managed).unwrap();
        fs::write(
            managed.join("managed-settings.json"),
            r#"{"autoMemoryDirectory":"/opt/memory"}"#,
        )
        .unwrap();
        let _guard = ManagedSettingsRootForTest::set(managed);

        assert!(matches!(
            resolve(
                &repo.to_string_lossy(),
                Some(&config(temp.path(), &temp.path().join("cfg")))
            ),
            Resolution::UnsupportedOverride(ref reason) if reason.contains("autoMemoryDirectory")
        ));
    }

    #[test]
    fn auto_memory_disabled_is_a_distinct_state() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join(".claude")).unwrap();
        fs::write(
            repo.join(".claude/settings.json"),
            r#"{"autoMemoryEnabled":false}"#,
        )
        .unwrap();

        assert_eq!(
            resolve(
                &repo.to_string_lossy(),
                Some(&config(temp.path(), &temp.path().join("cfg")))
            ),
            Resolution::Disabled
        );
    }

    #[test]
    fn conflicting_auto_memory_settings_are_unverifiable() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join(".claude")).unwrap();
        fs::write(
            repo.join(".claude/settings.json"),
            r#"{"autoMemoryEnabled":false}"#,
        )
        .unwrap();
        fs::write(
            repo.join(".claude/settings.local.json"),
            r#"{"autoMemoryEnabled":true}"#,
        )
        .unwrap();

        assert!(matches!(
            resolve(
                &repo.to_string_lossy(),
                Some(&config(temp.path(), &temp.path().join("cfg")))
            ),
            Resolution::UnsupportedOverride(_)
        ));
    }

    #[test]
    fn an_unobservable_configuration_is_never_treated_as_the_default() {
        assert!(matches!(
            resolve("/work/repo", None),
            Resolution::UnsupportedOverride(_)
        ));
    }

    #[test]
    fn a_valid_project_dir_name_replaces_the_key_only_with_a_custom_config_dir() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let custom = temp.path().join("cfg");

        let mut observed = config(temp.path(), &custom);
        observed.project_dir_name = Some("shared-name".to_string());
        let (_, memory) = ready(resolve(&repo.to_string_lossy(), Some(&observed)));
        assert_eq!(memory, custom.join("projects/shared-name/memory"));

        let mut observed = config(temp.path(), &temp.path().join(".claude"));
        observed.config_dir = None;
        observed.project_dir_name = Some("shared-name".to_string());
        let (_, memory) = ready(resolve(&repo.to_string_lossy(), Some(&observed)));
        assert_eq!(
            memory,
            temp.path()
                .join(".claude/projects")
                .join(sanitized_project_key(&repo))
                .join("memory")
        );
    }

    #[test]
    fn an_invalid_project_dir_name_is_ignored_like_claude_does() {
        assert!(valid_project_dir_name("fine_name-1"));
        assert!(!valid_project_dir_name(""));
        assert!(!valid_project_dir_name("has/slash"));
        assert!(!valid_project_dir_name("con"));
        assert!(!valid_project_dir_name("COM1"));
        assert!(!valid_project_dir_name(&"a".repeat(65)));
    }

    #[test]
    fn the_memory_path_override_wins_over_everything_else() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let custom = temp.path().join("custom-memory");

        let mut observed = config(temp.path(), &temp.path().join("cfg"));
        observed.memory_path_override = Some(custom.to_string_lossy().into_owned());
        let (_, memory) = ready(resolve(&repo.to_string_lossy(), Some(&observed)));
        assert_eq!(memory, custom);
    }

    #[test]
    fn the_remote_memory_dir_replaces_the_projects_root() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let remote = temp.path().join("remote");

        let mut observed = config(temp.path(), &temp.path().join("cfg"));
        observed.remote_memory_dir = Some(remote.to_string_lossy().into_owned());
        let (_, memory) = ready(resolve(&repo.to_string_lossy(), Some(&observed)));
        assert_eq!(
            memory,
            remote.join(sanitized_project_key(&repo)).join("memory")
        );
    }
}
