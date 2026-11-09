//! `project` contracts — first-class Project declaration (#3021).
//!
//! A Project is a long-lived logical declaration of work resources and Session
//! presets. It is **not** an Agent, a Sandbox, an EROFS image or a persistent
//! `ProjectEnvironment`: it names an optional Git source, zero or more
//! Existing Locations (`{agent_id, path}` pairs that point at user-owned
//! directories), optional Session defaults and an optional immutable reference
//! to an EROFS image digest owned by the global Image Manager.
//!
//! The validation in this module is the canonical one: the Server persists only
//! what these functions accept, and Web/App/CLI consumers can reuse them instead
//! of inventing weaker checks. Error messages are deterministic because cases
//! assert them.

use serde::{Deserialize, Serialize};

// ── Bounds ──────────────────────────────────────────────────────────────

/// Maximum Project name length, in Unicode scalar values.
pub const PROJECT_NAME_MAX_CHARS: usize = 120;
/// Maximum Project description length, in Unicode scalar values.
pub const PROJECT_DESCRIPTION_MAX_CHARS: usize = 2000;
/// Maximum number of Existing Locations one Project may declare.
pub const PROJECT_LOCATION_LIMIT: usize = 64;
/// Maximum Agent id length, in Unicode scalar values.
pub const PROJECT_AGENT_ID_MAX_CHARS: usize = 128;
/// Maximum Existing Location path length, in Unicode scalar values.
pub const PROJECT_PATH_MAX_CHARS: usize = 4096;
/// Maximum Git source repository URL length, in Unicode scalar values.
pub const PROJECT_REPOSITORY_URL_MAX_CHARS: usize = 2048;
/// Maximum Git source ref length (branch name or full commit SHA).
pub const PROJECT_REF_MAX_CHARS: usize = 255;
/// Maximum number of env profile ids in Session defaults.
pub const PROJECT_ENV_PROFILE_LIMIT: usize = 32;
/// Maximum env profile id length, in Unicode scalar values.
pub const PROJECT_ENV_PROFILE_ID_MAX_CHARS: usize = 128;
/// Maximum shell / sandbox policy reference length, in Unicode scalar values.
pub const PROJECT_DEFAULT_REF_MAX_CHARS: usize = 256;

/// The prefix the Server gives every Project identity.
pub const PROJECT_ID_PREFIX: &str = "project-";

// ── Types ───────────────────────────────────────────────────────────────

/// Optional Git source for a Project.
///
/// `ref` is either a branch name or a full commit SHA. The Project only
/// declares the source; checking it out or cloning it is a separate capability.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSource {
    pub repository_url: String,
    #[serde(rename = "ref")]
    pub reference: String,
}

/// One Existing Location: a user-owned directory on an Agent.
///
/// The Project references it; it never clones, mutates or deletes the directory
/// because the Project is edited or deleted.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectLocation {
    pub agent_id: String,
    pub path: String,
}

/// Optional defaults a new Session created in this Project should start from.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSessionDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// Server env file names applied at create time when the request selects
    /// no env files. An explicit request selection takes precedence, and the
    /// resulting binding belongs to the Session, not the Project.
    #[serde(default)]
    pub env_profile_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_policy_ref: Option<String>,
}

/// A persisted Project as list/detail reads return it.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub project_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ProjectSource>,
    #[serde(default)]
    pub locations: Vec<ProjectLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_defaults: Option<ProjectSessionDefaults>,
    /// Immutable digest reference to an EROFS image artifact.
    ///
    /// The artifact belongs to the global Image Manager. A Project never owns
    /// the blob bytes, and deleting the Project never deletes shared content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_digest: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// `server.project.list`'s request — empty.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectListPayload {}

/// `server.project.list`'s reply.
///
/// `projects` is empty when the read failed, so `error` distinguishes a failed
/// read from a genuinely empty collection.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectListResponsePayload {
    pub projects: Vec<Project>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `server.project.get`'s request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectGetPayload {
    pub project_id: String,
}

/// `server.project.get`'s reply.
///
/// `error_kind` is `invalid`, `not_found`, `unavailable` or `unauthorized`, the
/// same vocabulary the Session metadata units use.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectGetResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<Project>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `server.project.create`'s request.
///
/// A name is the only required field: a Project may exist with no Agent, no Git
/// source, no location and no Session defaults.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectCreatePayload {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ProjectSource>,
    #[serde(default)]
    pub locations: Vec<ProjectLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_defaults: Option<ProjectSessionDefaults>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_digest: Option<String>,
}

/// `server.project.create`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectCreateResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<Project>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `server.project.update`'s request — a whole replacement of the mutable
/// fields, like the Session Environment Binding's set operation (#170).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectUpdatePayload {
    pub project_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ProjectSource>,
    #[serde(default)]
    pub locations: Vec<ProjectLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_defaults: Option<ProjectSessionDefaults>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_digest: Option<String>,
}

/// `server.project.update`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectUpdateResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<Project>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `server.project.delete`'s request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectDeletePayload {
    pub project_id: String,
}

/// `server.project.delete`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectDeleteResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

// ── Validation ──────────────────────────────────────────────────────────

/// A deterministic validation failure naming the offending value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectValidationError {
    EmptyName,
    NameTooLong { max: usize },
    NameHasControlCharacters,
    DescriptionTooLong { max: usize },
    DescriptionHasControlCharacters,
    EmptyRepositoryUrl,
    RepositoryUrlTooLong { max: usize },
    RepositoryUrlInvalid,
    EmptySourceRef,
    SourceRefTooLong { max: usize },
    SourceRefInvalid,
    EmptyAgentId { index: usize },
    AgentIdTooLong { index: usize, max: usize },
    AgentIdHasControlCharacters { index: usize },
    EmptyLocationPath { index: usize },
    LocationPathTooLong { index: usize, max: usize },
    LocationPathMustBeAbsolute { index: usize },
    LocationPathHasParentSegment { index: usize },
    LocationPathHasControlCharacters { index: usize },
    TooManyLocations { max: usize },
    DuplicateLocation { index: usize },
    TooManyEnvProfiles { max: usize },
    EmptyEnvProfileId { index: usize },
    EnvProfileIdTooLong { index: usize, max: usize },
    EnvProfileIdHasControlCharacters { index: usize },
    DuplicateEnvProfileId { index: usize },
    EmptyDefaultRef { field: &'static str },
    DefaultRefTooLong { field: &'static str, max: usize },
    DefaultRefHasControlCharacters { field: &'static str },
    InvalidImageDigest,
    InvalidProjectId,
}

impl ProjectValidationError {
    /// One deterministic sentence naming the offending value and its bound.
    pub fn message(&self) -> String {
        match self {
            Self::EmptyName => "project name must not be empty".to_string(),
            Self::NameTooLong { max } => {
                format!("project name must be at most {max} characters")
            }
            Self::NameHasControlCharacters => {
                "project name contains forbidden control characters".to_string()
            }
            Self::DescriptionTooLong { max } => {
                format!("project description must be at most {max} characters")
            }
            Self::DescriptionHasControlCharacters => {
                "project description contains forbidden control characters".to_string()
            }
            Self::EmptyRepositoryUrl => "repository_url must not be empty".to_string(),
            Self::RepositoryUrlTooLong { max } => {
                format!("repository_url must be at most {max} characters")
            }
            Self::RepositoryUrlInvalid => {
                "repository_url must be an https, ssh or git URL, or a user@host:path form"
                    .to_string()
            }
            Self::EmptySourceRef => "source ref must not be empty".to_string(),
            Self::SourceRefTooLong { max } => {
                format!("source ref must be at most {max} characters")
            }
            Self::SourceRefInvalid => "source ref is not a valid branch or commit".to_string(),
            Self::EmptyAgentId { index } => {
                format!("location {} agent_id must not be empty", index + 1)
            }
            Self::AgentIdTooLong { index, max } => {
                format!(
                    "location {} agent_id must be at most {max} characters",
                    index + 1
                )
            }
            Self::AgentIdHasControlCharacters { index } => {
                format!(
                    "location {} agent_id contains forbidden control characters",
                    index + 1
                )
            }
            Self::EmptyLocationPath { index } => {
                format!("location {} path must not be empty", index + 1)
            }
            Self::LocationPathTooLong { index, max } => {
                format!(
                    "location {} path must be at most {max} characters",
                    index + 1
                )
            }
            Self::LocationPathMustBeAbsolute { index } => {
                format!("location {} path must be absolute", index + 1)
            }
            Self::LocationPathHasParentSegment { index } => {
                format!("location {} path must not contain '..'", index + 1)
            }
            Self::LocationPathHasControlCharacters { index } => {
                format!(
                    "location {} path contains forbidden control characters",
                    index + 1
                )
            }
            Self::TooManyLocations { max } => {
                format!("at most {max} locations are allowed")
            }
            Self::DuplicateLocation { index } => {
                format!("location {} duplicates an earlier location", index + 1)
            }
            Self::TooManyEnvProfiles { max } => {
                format!("at most {max} env profile ids are allowed")
            }
            Self::EmptyEnvProfileId { index } => {
                format!("env profile id {} must not be empty", index + 1)
            }
            Self::EnvProfileIdTooLong { index, max } => {
                format!(
                    "env profile id {} must be at most {max} characters",
                    index + 1
                )
            }
            Self::EnvProfileIdHasControlCharacters { index } => {
                format!(
                    "env profile id {} contains forbidden control characters",
                    index + 1
                )
            }
            Self::DuplicateEnvProfileId { index } => {
                format!("env profile id {} duplicates an earlier id", index + 1)
            }
            Self::EmptyDefaultRef { field } => format!("{field} must not be empty"),
            Self::DefaultRefTooLong { field, max } => {
                format!("{field} must be at most {max} characters")
            }
            Self::DefaultRefHasControlCharacters { field } => {
                format!("{field} contains forbidden control characters")
            }
            Self::InvalidImageDigest => {
                "image_digest must be a sha256:<64 lowercase hex> digest".to_string()
            }
            Self::InvalidProjectId => "project_id is not a valid Project identity".to_string(),
        }
    }
}

impl std::fmt::Display for ProjectValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for ProjectValidationError {}

/// The normalized mutable fields a successful create/update persists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedProject {
    pub name: String,
    pub description: Option<String>,
    pub source: Option<ProjectSource>,
    pub locations: Vec<ProjectLocation>,
    pub session_defaults: Option<ProjectSessionDefaults>,
    pub image_digest: Option<String>,
}

fn trimmed_nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn has_control_characters(value: &str) -> bool {
    value.chars().any(|c| c.is_ascii_control())
}

/// Description is plain text: newlines and tabs are content, other C0 controls
/// are not. NUL in particular must never reach the database or a terminal.
fn has_forbidden_description_character(value: &str) -> bool {
    value
        .chars()
        .any(|c| c.is_ascii_control() && !matches!(c, '\n' | '\r' | '\t'))
}

fn is_absolute_portable_path(path: &str) -> bool {
    if path.starts_with('/') {
        return true;
    }
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(drive), Some(':'), Some('/' | '\\')) if drive.is_ascii_alphabetic()
    )
}

fn has_parent_directory_segment(path: &str) -> bool {
    path.split(['/', '\\']).any(|segment| segment == "..")
}

fn is_valid_repository_url(url: &str) -> bool {
    if url.chars().any(char::is_whitespace) {
        return false;
    }
    for scheme in ["https://", "ssh://", "git://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            let host = rest.split(['/', ':']).next().unwrap_or_default();
            return !host.is_empty();
        }
    }
    // scp-like form, `git@host:owner/repo.git`. Requiring the '@' keeps a
    // bare `host:path` (or a Windows drive path) from being read as a URL.
    let Some((user_host, repo_path)) = url.split_once(':') else {
        return false;
    };
    let Some((user, host)) = user_host.split_once('@') else {
        return false;
    };
    !user.is_empty() && !host.is_empty() && !host.contains(['/', '\\']) && !repo_path.is_empty()
}

fn is_valid_source_ref(reference: &str) -> bool {
    if reference.is_empty()
        || reference.chars().any(char::is_whitespace)
        || reference.contains("..")
        || reference.contains("@{")
        || reference.contains("//")
        || reference == "@"
        || reference.starts_with('/')
        || reference.starts_with('.')
        || reference.ends_with('/')
        || reference.ends_with('.')
        || reference.ends_with(".lock")
    {
        return false;
    }
    !reference
        .chars()
        .any(|c| matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
}

/// Whether `value` is a `project-<uuid>` identity the Server could have minted.
pub fn is_valid_project_id(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix(PROJECT_ID_PREFIX) else {
        return false;
    };
    let bytes = uuid.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
        }
    })
}

fn is_valid_image_digest(digest: &str) -> bool {
    let Some(hex) = digest.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn normalize_default_ref(
    field: &'static str,
    value: Option<&str>,
) -> Result<Option<String>, ProjectValidationError> {
    let Some(value) = trimmed_nonempty(value) else {
        return Ok(None);
    };
    if has_control_characters(&value) {
        return Err(ProjectValidationError::DefaultRefHasControlCharacters { field });
    }
    if value.chars().count() > PROJECT_DEFAULT_REF_MAX_CHARS {
        return Err(ProjectValidationError::DefaultRefTooLong {
            field,
            max: PROJECT_DEFAULT_REF_MAX_CHARS,
        });
    }
    Ok(Some(value))
}

/// Validate and normalize the mutable fields of a Project create/update.
///
/// Every bound and rejection is deterministic. The Server persists only the
/// returned [`NormalizedProject`]; consumers validating locally can compare
/// against the same type and messages.
pub fn validate_project_draft(
    name: &str,
    description: Option<&str>,
    source: Option<&ProjectSource>,
    locations: &[ProjectLocation],
    session_defaults: Option<&ProjectSessionDefaults>,
    image_digest: Option<&str>,
) -> Result<NormalizedProject, ProjectValidationError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ProjectValidationError::EmptyName);
    }
    if has_control_characters(name) {
        return Err(ProjectValidationError::NameHasControlCharacters);
    }
    if name.chars().count() > PROJECT_NAME_MAX_CHARS {
        return Err(ProjectValidationError::NameTooLong {
            max: PROJECT_NAME_MAX_CHARS,
        });
    }

    let description = trimmed_nonempty(description);
    if let Some(description) = &description {
        if has_forbidden_description_character(description) {
            return Err(ProjectValidationError::DescriptionHasControlCharacters);
        }
        if description.chars().count() > PROJECT_DESCRIPTION_MAX_CHARS {
            return Err(ProjectValidationError::DescriptionTooLong {
                max: PROJECT_DESCRIPTION_MAX_CHARS,
            });
        }
    }

    let source = match source {
        None => None,
        Some(source) => {
            let repository_url = source.repository_url.trim();
            if repository_url.is_empty() {
                return Err(ProjectValidationError::EmptyRepositoryUrl);
            }
            if repository_url.chars().count() > PROJECT_REPOSITORY_URL_MAX_CHARS {
                return Err(ProjectValidationError::RepositoryUrlTooLong {
                    max: PROJECT_REPOSITORY_URL_MAX_CHARS,
                });
            }
            if !is_valid_repository_url(repository_url) {
                return Err(ProjectValidationError::RepositoryUrlInvalid);
            }

            let reference = source.reference.trim();
            if reference.is_empty() {
                return Err(ProjectValidationError::EmptySourceRef);
            }
            if reference.chars().count() > PROJECT_REF_MAX_CHARS {
                return Err(ProjectValidationError::SourceRefTooLong {
                    max: PROJECT_REF_MAX_CHARS,
                });
            }
            if !is_valid_source_ref(reference) {
                return Err(ProjectValidationError::SourceRefInvalid);
            }

            Some(ProjectSource {
                repository_url: repository_url.to_string(),
                reference: reference.to_string(),
            })
        }
    };

    if locations.len() > PROJECT_LOCATION_LIMIT {
        return Err(ProjectValidationError::TooManyLocations {
            max: PROJECT_LOCATION_LIMIT,
        });
    }
    let mut normalized_locations: Vec<ProjectLocation> = Vec::with_capacity(locations.len());
    for (index, location) in locations.iter().enumerate() {
        let agent_id = location.agent_id.trim();
        if agent_id.is_empty() {
            return Err(ProjectValidationError::EmptyAgentId { index });
        }
        if has_control_characters(agent_id) || agent_id.chars().any(char::is_whitespace) {
            return Err(ProjectValidationError::AgentIdHasControlCharacters { index });
        }
        if agent_id.chars().count() > PROJECT_AGENT_ID_MAX_CHARS {
            return Err(ProjectValidationError::AgentIdTooLong {
                index,
                max: PROJECT_AGENT_ID_MAX_CHARS,
            });
        }

        let path = location.path.as_str();
        if path.is_empty() {
            return Err(ProjectValidationError::EmptyLocationPath { index });
        }
        if has_control_characters(path) {
            return Err(ProjectValidationError::LocationPathHasControlCharacters { index });
        }
        if path.chars().count() > PROJECT_PATH_MAX_CHARS {
            return Err(ProjectValidationError::LocationPathTooLong {
                index,
                max: PROJECT_PATH_MAX_CHARS,
            });
        }
        if !is_absolute_portable_path(path) {
            return Err(ProjectValidationError::LocationPathMustBeAbsolute { index });
        }
        if has_parent_directory_segment(path) {
            return Err(ProjectValidationError::LocationPathHasParentSegment { index });
        }
        if normalized_locations
            .iter()
            .any(|existing| existing.agent_id == agent_id && existing.path.as_str() == path)
        {
            return Err(ProjectValidationError::DuplicateLocation { index });
        }
        normalized_locations.push(ProjectLocation {
            agent_id: agent_id.to_string(),
            path: path.to_string(),
        });
    }

    let session_defaults = match session_defaults {
        None => None,
        Some(defaults) => {
            let shell = normalize_default_ref("shell", defaults.shell.as_deref())?;
            let sandbox_policy_ref = normalize_default_ref(
                "sandbox_policy_ref",
                defaults.sandbox_policy_ref.as_deref(),
            )?;

            if defaults.env_profile_ids.len() > PROJECT_ENV_PROFILE_LIMIT {
                return Err(ProjectValidationError::TooManyEnvProfiles {
                    max: PROJECT_ENV_PROFILE_LIMIT,
                });
            }
            let mut profile_ids: Vec<String> = Vec::with_capacity(defaults.env_profile_ids.len());
            for (index, profile_id) in defaults.env_profile_ids.iter().enumerate() {
                let profile_id = profile_id.trim();
                if profile_id.is_empty() {
                    return Err(ProjectValidationError::EmptyEnvProfileId { index });
                }
                if has_control_characters(profile_id) || profile_id.chars().any(char::is_whitespace)
                {
                    return Err(ProjectValidationError::EnvProfileIdHasControlCharacters { index });
                }
                if profile_id.chars().count() > PROJECT_ENV_PROFILE_ID_MAX_CHARS {
                    return Err(ProjectValidationError::EnvProfileIdTooLong {
                        index,
                        max: PROJECT_ENV_PROFILE_ID_MAX_CHARS,
                    });
                }
                if profile_ids.iter().any(|existing| existing == profile_id) {
                    return Err(ProjectValidationError::DuplicateEnvProfileId { index });
                }
                profile_ids.push(profile_id.to_string());
            }

            Some(ProjectSessionDefaults {
                shell,
                env_profile_ids: profile_ids,
                sandbox_policy_ref,
            })
        }
    };

    let image_digest = trimmed_nonempty(image_digest);
    if let Some(digest) = &image_digest {
        if !is_valid_image_digest(digest) {
            return Err(ProjectValidationError::InvalidImageDigest);
        }
    }

    Ok(NormalizedProject {
        name: name.to_string(),
        description,
        source,
        locations: normalized_locations,
        session_defaults,
        image_digest,
    })
}
