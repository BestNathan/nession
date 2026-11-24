//! `image` contracts — the global EROFS Image Manager (#3022).
//!
//! The Server owns immutable image metadata and blob bytes. A Project only
//! references a digest; a runtime consumer asks the Server for a scoped access
//! grant and streams the exact bytes over HTTP.
//!
//! Validation here is canonical. The Server persists only what these functions
//! accept, and build/store code reuses them instead of inventing weaker checks.
//! Error messages are deterministic because acceptance cases assert them.

use serde::{Deserialize, Serialize};

// ── Bounds and names ────────────────────────────────────────────────────

/// Prefix of a Server-minted image build identity.
pub const IMAGE_ID_PREFIX: &str = "image-";
/// Every content digest this contract accepts is a sha256 digest.
pub const IMAGE_DIGEST_PREFIX: &str = "sha256:";
/// Maximum alias length, in Unicode scalar values.
pub const IMAGE_ALIAS_MAX_CHARS: usize = 128;
/// Maximum public repository URL length, in Unicode scalar values.
pub const IMAGE_REPOSITORY_URL_MAX_CHARS: usize = 2048;
/// Maximum Git ref length, in Unicode scalar values.
pub const IMAGE_REF_MAX_CHARS: usize = 255;
/// Maximum validated local directory path length, in Unicode scalar values.
pub const IMAGE_LOCAL_PATH_MAX_CHARS: usize = 4096;
/// Maximum build/packaging error text stored with a failed image.
pub const IMAGE_ERROR_MAX_CHARS: usize = 1024;
/// The only packaging block size V1 accepts.
pub const IMAGE_BLOCK_SIZE: u32 = 4096;
/// The fixed timestamp V1 passes to `mkfs.erofs`.
pub const IMAGE_FIXED_TIMESTAMP: i64 = 0;
/// The fixed filesystem UUID V1 passes to `mkfs.erofs`.
pub const IMAGE_FIXED_UUID: &str = "11111111-1111-4111-8111-111111111111";
/// The only compression mode V1 accepts. Uncompressed bytes make the digest a
/// function of the source tree and packaging parameters, not of a compressor's
/// implementation.
pub const IMAGE_COMPRESSION: &str = "none";

/// The proprietary compatibility HTTP path prefix a scoped blob grant addresses.
///
/// Since the #4250 cutover a Tag-reachable catalog image is granted through the
/// standard OCI Distribution `/v2/<repo>/…` routes instead; this prefix remains
/// only for the bounded compatibility window (untagged builds and digest-only
/// legacy rows) and is retired once those consumers are migrated or gated.
pub const IMAGE_BLOB_PATH_PREFIX: &str = "/images/blobs/";

/// Maximum number of source Images one Compose build accepts.
pub const IMAGE_COMPOSE_MAX_SOURCES: usize = 16;
/// Maximum repository name length accepted for a Compose source.
pub const IMAGE_COMPOSE_REPOSITORY_MAX_CHARS: usize = 255;
/// Maximum one repository path segment in a Compose source.
pub const IMAGE_COMPOSE_REPOSITORY_SEGMENT_MAX_CHARS: usize = 63;
/// Maximum Compose destination prefix length.
pub const IMAGE_COMPOSE_DESTINATION_MAX_CHARS: usize = 1024;

// ── Source ──────────────────────────────────────────────────────────────

/// How a Compose build represents its result (#3696, #3697).
///
/// `Flattened` copies the merged tree into one self-contained raw EROFS layer.
/// `Referenced` builds one immutable metadata EROFS that references the pinned
/// source EROFS blobs as external devices, so unchanged backing bytes are not
/// repackaged. The referenced form requires every source at the composed root
/// and fails closed on any path conflict.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageComposeRepresentation {
    /// One self-contained raw EROFS result layer (default).
    #[default]
    Flattened,
    /// One metadata EROFS plus explicit verified backing EROFS blobs.
    Referenced,
}

/// One immutable source Image in an EROFS Compose build (#3696).
///
/// The source is named by its catalog Repository plus a Tag or immutable
/// digest. A bare digest is deliberately not a source declaration: the Server
/// resolves and authorizes the Repository reference once at submission and
/// pins the immutable Manifest/layer identities for the whole build.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageComposeSource {
    /// The catalog Repository that owns the source Image.
    pub repository: String,
    /// A mutable Tag or an immutable `sha256:<64 hex>` digest.
    #[serde(rename = "ref")]
    pub reference: String,
    /// Absolute destination prefix inside the composed root. Empty places the
    /// source at `/`; otherwise the source tree appears below this prefix.
    #[serde(default)]
    pub destination: String,
}

/// Where an image is built from.
///
/// V1 supports one public GitHub HTTPS repository (branch or full commit SHA),
/// one validated local directory/bundle, and — since #3696 — a validated
/// composition of catalog Images. Private GitHub authentication is deliberately
/// out of scope and is refused rather than silently attempted.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ImageSource {
    /// A public GitHub HTTPS repository and a branch or full commit SHA.
    #[serde(rename = "github")]
    GitHub {
        repository_url: String,
        #[serde(rename = "ref")]
        reference: String,
    },
    /// A validated local directory or bundle on the build host.
    #[serde(rename = "local_directory")]
    LocalDirectory { path: String },
    /// Compose immutable catalog Images into one EROFS image.
    #[serde(rename = "compose")]
    Compose {
        sources: Vec<ImageComposeSource>,
        /// How the result is represented; defaults to a flattened image.
        #[serde(default)]
        representation: ImageComposeRepresentation,
    },
}

/// One canonical Compose source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedComposeSource {
    pub repository: String,
    pub reference: String,
    /// The immutable digest when the reference already is one.
    pub requested_digest: Option<String>,
    /// Empty for the composed root.
    pub destination: String,
}

/// The canonical, trimmed source persisted and hashed into packaging identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizedImageSource {
    GitHub {
        repository_url: String,
        reference: String,
        requested_sha: Option<String>,
    },
    LocalDirectory {
        path: String,
    },
    Compose {
        representation: ImageComposeRepresentation,
        sources: Vec<NormalizedComposeSource>,
    },
}

impl NormalizedImageSource {
    /// The source kind written to the descriptor and database.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::GitHub { .. } => "github",
            Self::LocalDirectory { .. } => "local_directory",
            Self::Compose { .. } => "compose",
        }
    }

    /// The public source as a contract value.
    pub fn source(&self) -> ImageSource {
        match self {
            Self::GitHub {
                repository_url,
                reference,
                ..
            } => ImageSource::GitHub {
                repository_url: repository_url.clone(),
                reference: reference.clone(),
            },
            Self::LocalDirectory { path } => ImageSource::LocalDirectory { path: path.clone() },
            Self::Compose {
                representation,
                sources,
            } => ImageSource::Compose {
                representation: *representation,
                sources: sources
                    .iter()
                    .map(|source| ImageComposeSource {
                        repository: source.repository.clone(),
                        reference: source.reference.clone(),
                        destination: source.destination.clone(),
                    })
                    .collect(),
            },
        }
    }
}

// ── Packaging ───────────────────────────────────────────────────────────

/// Deterministic `mkfs.erofs` inputs recorded with every image.
///
/// The digest covers both the source tree and these parameters, so two builds
/// that differ only in packaging never share a digest.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImagePackaging {
    pub compression: String,
    pub block_size: u32,
    pub fixed_timestamp: i64,
    pub fixed_uuid: String,
}

impl Default for ImagePackaging {
    fn default() -> Self {
        Self {
            compression: IMAGE_COMPRESSION.to_string(),
            block_size: IMAGE_BLOCK_SIZE,
            fixed_timestamp: IMAGE_FIXED_TIMESTAMP,
            fixed_uuid: IMAGE_FIXED_UUID.to_string(),
        }
    }
}

impl ImagePackaging {
    /// The field order is stable; consumers serialize this value directly into
    /// the persisted packaging identity.
    pub fn is_v1_deterministic(&self) -> bool {
        validate_packaging(self).is_ok()
    }
}

// ── Descriptor ──────────────────────────────────────────────────────────

/// The lifecycle state of one build.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageStatus {
    /// The build worker is running; no bytes are offered as ready.
    Building,
    /// A verified immutable blob exists at `digest`.
    Ready,
    /// The build failed; `error` explains the recoverable state.
    Failed,
}

impl ImageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Building => "building",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "building" => Some(Self::Building),
            "ready" => Some(Self::Ready),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// The default page size for an older client that sends no limit. This keeps
/// the pre-pagination bound and remains truthful: the reply always reports
/// `total` and a `next_offset` when more images exist.
pub const IMAGE_LIST_DEFAULT_LIMIT: u32 = 200;
/// The largest page a caller may request.
pub const IMAGE_LIST_MAX_LIMIT: u32 = 200;

/// An immutable image record as list/get/build replies return it.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageDescriptor {
    pub image_id: String,
    /// `sha256:<64 lowercase hex>` once ready; absent for a failed build.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    pub size_bytes: u64,
    pub source: ImageSource,
    /// The exact resolved Git commit; absent for a local-directory source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_sha: Option<String>,
    pub packaging: ImagePackaging,
    pub status: ImageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The alias that was set by the build request, when one was supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// Every mutable tag currently resolving to this digest, sorted.
    #[serde(default)]
    pub aliases: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

// ── Payloads ────────────────────────────────────────────────────────────

/// `server.image.build`'s request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildPayload {
    pub source: ImageSource,
    /// Optional mutable tag. It resolves to this build's digest only after the
    /// bytes are ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

/// `server.image.build`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `server.image.list`'s request.
///
/// A page is addressed by an absolute offset, not an opaque cursor: the
/// registry is ordered by immutable creation time plus image id, so a caller
/// can request the next page without holding hidden state. The default keeps
/// the pre-pagination bound for older clients; a caller that wants the complete
/// inventory follows `next_offset` until it is absent.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageListPayload {
    #[serde(default)]
    pub offset: u32,
    #[serde(default = "default_image_list_limit")]
    pub limit: u32,
    /// Case-sensitive substring filter over alias, digest, image id and
    /// persisted source. Empty returns the unfiltered registry page.
    #[serde(default)]
    pub query: String,
}

fn default_image_list_limit() -> u32 {
    IMAGE_LIST_DEFAULT_LIMIT
}

/// `server.image.list`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageListResponsePayload {
    pub images: Vec<ImageDescriptor>,
    /// The number of images visible to this authenticated client.
    #[serde(default)]
    pub total: u64,
    /// The offset of the next page, or absent when this page reaches `total`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `server.image.get`'s request. Exactly one of `digest` or `alias` addresses
/// the artifact; supplying both or neither is invalid.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageGetPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

/// `server.image.get`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageGetResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

// ── Library, Tags and reference impact (#3799) ──────────────────────────

/// The default Library page size.
pub const IMAGE_LIBRARY_DEFAULT_LIMIT: u32 = 50;
/// The largest Library page a caller may request.
pub const IMAGE_LIBRARY_MAX_LIMIT: u32 = 200;

fn default_image_library_limit() -> u32 {
    IMAGE_LIBRARY_DEFAULT_LIMIT
}

/// How one Server Catalog revision represents its EROFS bytes (#3697, #3799).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageLibraryRepresentation {
    /// One self-contained EROFS layer under a standard Manifest.
    SingleLayer,
    /// A Compose result flattened into one self-contained EROFS layer.
    Flattened,
    /// A metadata EROFS that references verified external EROFS blobs.
    Referenced,
    /// The catalog identity is absent or not readable; never inferred.
    #[default]
    Unknown,
}

/// One descriptor edge of a Library revision.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageLibraryLayer {
    pub digest: String,
    pub media_type: String,
    pub size_bytes: u64,
    /// The catalog reference role, for example `layer`, `config` or `device`.
    pub role: String,
}

/// Known reference impact for one immutable revision (#3799).
///
/// Counts are authoritative Server observations. A count is never invented:
/// when a reference class cannot be observed, `unknown` is true and removal
/// must fail closed rather than claim the revision is unreferenced.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageReferenceImpact {
    pub manifest_digest: String,
    /// Active durable Project pins.
    #[serde(default)]
    pub project_pins: u64,
    /// Active durable Session pins.
    #[serde(default)]
    pub session_pins: u64,
    /// Other mutable Tags resolving to the same revision.
    #[serde(default)]
    pub other_tags: Vec<String>,
    /// Expiring transfer/build/mount leases.
    #[serde(default)]
    pub leases: u64,
    /// Referenced Composite or Catalog parents that consume this revision.
    #[serde(default)]
    pub compose_references: u64,
    /// At least one reference class could not be observed.
    #[serde(default)]
    pub unknown: bool,
}

impl ImageReferenceImpact {
    /// Whether any known or unknown reference forbids a silent unlink.
    pub fn requires_confirmation(&self) -> bool {
        self.unknown
            || self.project_pins > 0
            || self.session_pins > 0
            || self.leases > 0
            || self.compose_references > 0
    }
}

/// One Library revision with its Server-owned catalog identity (#3799).
///
/// `image` is the legacy digest/alias registry projection. `manifest_digest`
/// and its metadata come from the Manifest-addressed catalog; they are absent
/// (never synthesized) when the legacy row has no readable catalog identity.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageLibraryEntry {
    pub image: ImageDescriptor,
    /// The Server Catalog repository, or empty when no catalog identity exists.
    #[serde(default)]
    pub repository: String,
    /// Mutable repository-scoped Tags resolving to `manifest_digest`, sorted.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The immutable OCI Manifest/Index/Composite digest, when readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// `manifest`, `index` or `composite`, when readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The advisory `io.nession.kind` role, when the Manifest annotations are
    /// readable: `base_runtime`, `tool` or `directory` (#3793).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_kind: Option<String>,
    /// The advisory `io.nession.mount.default` target, when readable and
    /// valid. It is a default suggestion, never an authorization (#3793).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_default: Option<String>,
    /// `os/arch`, when the catalog records or verifies a platform.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default)]
    pub representation: ImageLibraryRepresentation,
    /// Descriptor edges of this revision.
    #[serde(default)]
    pub layers: Vec<ImageLibraryLayer>,
    /// Every CAS object reachable from this revision, sorted.
    #[serde(default)]
    pub closure: Vec<String>,
    /// Known reference impact; absent when the caller may not observe it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impact: Option<ImageReferenceImpact>,
}

/// `server.image.library.list`'s request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageLibraryListPayload {
    #[serde(default)]
    pub offset: u32,
    #[serde(default = "default_image_library_limit")]
    pub limit: u32,
    /// Case-sensitive substring filter over alias, tag, digest, image id and
    /// persisted source. Empty returns the unfiltered page.
    #[serde(default)]
    pub query: String,
    /// Exact Server Catalog repository filter; empty returns all repositories.
    #[serde(default)]
    pub repository: String,
}

/// `server.image.library.list`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageLibraryListResponsePayload {
    pub success: bool,
    #[serde(default)]
    pub entries: Vec<ImageLibraryEntry>,
    #[serde(default)]
    pub total: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `server.image.tag.set`'s request.
///
/// `expected_digest` absent means create-only: the Tag must not exist.
/// A present value is the exact prior digest the move must observe.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageTagSetPayload {
    pub repository: String,
    pub tag: String,
    /// The immutable target digest.
    pub digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_digest: Option<String>,
}

/// The committed result of one Tag CAS mutation.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageTagUpdate {
    pub repository: String,
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
    pub digest: String,
}

/// `server.image.tag.set`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageTagSetResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<ImageTagUpdate>,
    /// The digest the Tag actually resolves to after a CAS conflict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `server.image.tag.remove`'s request.
///
/// Removal is a logical unlink. It never deletes CAS bytes, moves a running
/// Session or Project pin, or evicts Agent cache. `accept_reference_impact`
/// must be true when the Server reports a confirmation-requiring impact.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageTagRemovePayload {
    pub repository: String,
    pub tag: String,
    /// The exact prior digest the removal must observe.
    pub expected_digest: String,
    #[serde(default)]
    pub accept_reference_impact: bool,
}

/// `server.image.tag.remove`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageTagRemoveResponsePayload {
    pub success: bool,
    #[serde(default)]
    pub removed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impact: Option<ImageReferenceImpact>,
    /// The digest the Tag actually resolves to after a CAS conflict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `server.image.impact.get`'s request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageImpactPayload {
    pub repository: String,
    pub tag: String,
}

/// `server.image.impact.get`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageImpactResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impact: Option<ImageReferenceImpact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// One Agent cache state for a selected image (#3181).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageCacheState {
    /// A verified blob exists in this Agent's identity-namespaced cache.
    Verified,
    /// A partial download exists; it is not mount-ready.
    Preparing,
    /// No verified bytes and no partial download.
    Absent,
    /// The cache contains a blob that failed verification or a recorded
    /// preparation failure.
    Failed,
    /// This Agent has no EROFS cache configured, so it cannot prepare images.
    Unavailable,
}

/// One digest's cache state as the owning Agent observed it.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageCacheStatus {
    pub digest: String,
    pub state: ImageCacheState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

// ── Per-digest cache progress (#3412) ───────────────────────────────────

/// The only per-digest cache observation version this build understands.
pub const IMAGE_CACHE_OBSERVATION_VERSION: u32 = 1;

/// The truthful phase of one digest in the current Agent's cache.
///
/// A durable `.part` is `resumable`, not an active download. Byte transfer
/// completing is `verifying`; only a full SHA-256 match plus atomic
/// publication is `verified`.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageCachePhase {
    /// No verified blob and no partial download.
    Absent,
    /// A durable partial exists; a later fetch can resume it. Not active.
    Resumable,
    /// A transfer is receiving bytes now.
    Downloading,
    /// Byte transfer finished but full-digest verification/publication has not.
    /// Not mount-ready.
    Verifying,
    /// A verified blob exists in this Agent's identity-namespaced cache.
    Verified,
    /// The cached bytes failed verification or a preparation attempt failed.
    Failed,
    /// This Agent has no EROFS cache configured.
    Unavailable,
}

/// One digest's authoritative cache observation from the current Agent.
///
/// The observation is read-only: asking for it never starts a transfer, mints
/// a grant or exposes a local path. `downloaded_bytes` and `total_bytes` are
/// measured values, never estimates; `total_bytes` is absent when the
/// authoritative total is unknown, and consumers must not synthesize a
/// percentage in that case. `updated_at` is Unix epoch seconds.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageCacheObservation {
    /// [`IMAGE_CACHE_OBSERVATION_VERSION`]. Other versions are refused.
    pub contract_version: u32,
    pub digest: String,
    pub phase: ImageCachePhase,
    /// Durable partial bytes plus bytes written by the current transfer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    /// Authoritative total from the Server descriptor or validated HTTP
    /// `Content-Range`/`Content-Length`; absent when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    /// True only for `downloading` and `verifying`; a surviving `.part` is
    /// not active.
    #[serde(default)]
    pub active: bool,
    /// Unix epoch seconds of the last measured state change.
    pub updated_at: u64,
    /// Bounded diagnostic. Never a local path or bearer grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ImageCacheObservation {
    /// Validate the version, digest and measured-byte/activity invariants.
    pub fn validate(&self) -> Result<(), ImageValidationError> {
        if self.contract_version != IMAGE_CACHE_OBSERVATION_VERSION {
            return Err(ImageValidationError::UnsupportedCacheObservationVersion {
                version: self.contract_version,
            });
        }
        if !is_valid_image_digest(&self.digest) {
            return Err(ImageValidationError::CacheObservationInvalidDigest);
        }
        if let (Some(downloaded), Some(total)) = (self.downloaded_bytes, self.total_bytes) {
            if downloaded > total {
                return Err(ImageValidationError::CacheObservationBytesInconsistent);
            }
        }
        if self.total_bytes.is_some() && self.downloaded_bytes.is_none() {
            return Err(ImageValidationError::CacheObservationBytesInconsistent);
        }
        let must_be_active = matches!(
            self.phase,
            ImageCachePhase::Downloading | ImageCachePhase::Verifying
        );
        if self.active != must_be_active {
            return Err(ImageValidationError::CacheObservationActivityInconsistent);
        }
        Ok(())
    }
}

impl ImageCacheStatus {
    /// Project an observation into the older readiness vocabulary.
    ///
    /// A resumable/downloading/verifying digest is `preparing`; it is never
    /// mount-ready until the observation itself says `verified`.
    pub fn from_observation(observation: &ImageCacheObservation) -> Self {
        let state = match observation.phase {
            ImageCachePhase::Verified => ImageCacheState::Verified,
            ImageCachePhase::Resumable
            | ImageCachePhase::Downloading
            | ImageCachePhase::Verifying => ImageCacheState::Preparing,
            ImageCachePhase::Absent => ImageCacheState::Absent,
            ImageCachePhase::Failed => ImageCacheState::Failed,
            ImageCachePhase::Unavailable => ImageCacheState::Unavailable,
        };
        Self {
            digest: observation.digest.clone(),
            state,
            detail: observation.detail.clone(),
        }
    }
}

// ── Validation ──────────────────────────────────────────────────────────

/// A deterministic validation failure naming the offending value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageValidationError {
    EmptyRepositoryUrl,
    RepositoryUrlTooLong { max: usize },
    RepositoryUrlNotPublicGitHubHttps,
    RepositoryUrlHasCredentials,
    EmptySourceRef,
    SourceRefTooLong { max: usize },
    SourceRefInvalid,
    EmptyLocalPath,
    LocalPathTooLong { max: usize },
    LocalPathMustBeAbsolute,
    LocalPathHasParentSegment,
    LocalPathHasControlCharacters,
    EmptyAlias,
    AliasTooLong { max: usize },
    AliasInvalid,
    EmptyComposeSources,
    TooManyComposeSources { max: usize },
    ComposeRepositoryInvalid,
    ComposeReferenceInvalid,
    ComposeDestinationInvalid,
    ComposeDestinationOverlap,
    EmptyDigest,
    InvalidDigest,
    InvalidImageId,
    InvalidCompression,
    InvalidBlockSize,
    InvalidFixedTimestamp,
    InvalidFixedUuid,
    GetRequiresExactlyOneLocator,
    ErrorTooLong { max: usize },
    InvalidBuildId,
    EmptyClientRequestId,
    ClientRequestIdTooLong { max: usize },
    ClientRequestIdInvalid,
    UnsupportedCacheObservationVersion { version: u32 },
    CacheObservationInvalidDigest,
    CacheObservationBytesInconsistent,
    CacheObservationActivityInconsistent,
}

impl ImageValidationError {
    /// One deterministic sentence naming the offending value and its bound.
    pub fn message(&self) -> String {
        match self {
            Self::EmptyRepositoryUrl => "repository_url must not be empty".to_string(),
            Self::RepositoryUrlTooLong { max } => {
                format!("repository_url must be at most {max} characters")
            }
            Self::RepositoryUrlNotPublicGitHubHttps => {
                "repository_url must be https://github.com/<owner>/<repo>; private, ssh and git protocols are not supported"
                    .to_string()
            }
            Self::RepositoryUrlHasCredentials => {
                "repository_url must not contain credentials or userinfo".to_string()
            }
            Self::EmptySourceRef => "source ref must not be empty".to_string(),
            Self::SourceRefTooLong { max } => {
                format!("source ref must be at most {max} characters")
            }
            Self::SourceRefInvalid => {
                "source ref must be a branch name or a full 40-character commit SHA".to_string()
            }
            Self::EmptyLocalPath => "local directory path must not be empty".to_string(),
            Self::LocalPathTooLong { max } => {
                format!("local directory path must be at most {max} characters")
            }
            Self::LocalPathMustBeAbsolute => {
                "local directory path must be absolute".to_string()
            }
            Self::LocalPathHasParentSegment => {
                "local directory path must not contain '..'".to_string()
            }
            Self::LocalPathHasControlCharacters => {
                "local directory path contains forbidden control characters".to_string()
            }
            Self::EmptyAlias => "image alias must not be empty".to_string(),
            Self::AliasTooLong { max } => {
                format!("image alias must be at most {max} characters")
            }
            Self::AliasInvalid => {
                "image alias must start with a lowercase letter or digit and contain only [a-z0-9._-]"
                    .to_string()
            }
            Self::EmptyComposeSources => {
                "a compose build requires at least one source Image".to_string()
            }
            Self::TooManyComposeSources { max } => {
                format!("a compose build accepts at most {max} source Images")
            }
            Self::ComposeRepositoryInvalid => {
                "a compose source repository must be a lowercase catalog repository name"
                    .to_string()
            }
            Self::ComposeReferenceInvalid => {
                "a compose source ref must be a Tag or an immutable sha256 digest".to_string()
            }
            Self::ComposeDestinationInvalid => {
                "a compose destination must be `/`-free normalized absolute prefix or empty"
                    .to_string()
            }
            Self::ComposeDestinationOverlap => {
                "compose destinations must not overlap or both name the composed root".to_string()
            }
            Self::EmptyDigest => "image digest must not be empty".to_string(),
            Self::InvalidDigest => {
                "image digest must be a sha256:<64 lowercase hex> digest".to_string()
            }
            Self::InvalidImageId => "image_id is not a valid image build identity".to_string(),
            Self::InvalidCompression => {
                format!("image compression must be `{IMAGE_COMPRESSION}`")
            }
            Self::InvalidBlockSize => {
                format!("image block_size must be {IMAGE_BLOCK_SIZE}")
            }
            Self::InvalidFixedTimestamp => {
                format!("image fixed_timestamp must be {IMAGE_FIXED_TIMESTAMP}")
            }
            Self::InvalidFixedUuid => {
                format!("image fixed_uuid must be {IMAGE_FIXED_UUID}")
            }
            Self::GetRequiresExactlyOneLocator => {
                "server.image.get requires exactly one of digest or alias".to_string()
            }
            Self::ErrorTooLong { max } => {
                format!("image error must be at most {max} characters")
            }
            Self::InvalidBuildId => "build_id is not a valid image build identity".to_string(),
            Self::EmptyClientRequestId => "client_request_id must not be empty".to_string(),
            Self::ClientRequestIdTooLong { max } => {
                format!("client_request_id must be at most {max} characters")
            }
            Self::ClientRequestIdInvalid => {
                "client_request_id must contain only ASCII letters, digits, '.', '_', '-' or ':'"
                    .to_string()
            }
            Self::UnsupportedCacheObservationVersion { version } => {
                format!(
                    "image cache observation version {version} is not supported; expected {IMAGE_CACHE_OBSERVATION_VERSION}"
                )
            }
            Self::CacheObservationInvalidDigest => {
                "image cache observation digest must be a sha256:<64 lowercase hex> digest"
                    .to_string()
            }
            Self::CacheObservationBytesInconsistent => {
                "image cache observation byte counts are inconsistent".to_string()
            }
            Self::CacheObservationActivityInconsistent => {
                "image cache observation activity does not match its phase".to_string()
            }
        }
    }
}

impl std::fmt::Display for ImageValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for ImageValidationError {}

fn has_control_characters(value: &str) -> bool {
    value.chars().any(|c| c.is_ascii_control())
}

/// `sha256:` followed by exactly 64 lowercase hexadecimal digits.
pub fn is_valid_image_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix(IMAGE_DIGEST_PREFIX) else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `image-` followed by a non-empty UUID-shaped identity.
pub fn is_valid_image_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix(IMAGE_ID_PREFIX) else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 64
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Validate and normalize a public GitHub repository URL.
///
/// The only accepted shape is `https://github.com/<owner>/<repo>`, optionally
/// with one trailing `.git`. Any scheme, host, userinfo, query, fragment or
/// extra path segment is refused; private authentication is a separate,
/// deliberately absent feature.
pub fn normalize_github_repository_url(raw: &str) -> Result<String, ImageValidationError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(ImageValidationError::EmptyRepositoryUrl);
    }
    if value.chars().count() > IMAGE_REPOSITORY_URL_MAX_CHARS {
        return Err(ImageValidationError::RepositoryUrlTooLong {
            max: IMAGE_REPOSITORY_URL_MAX_CHARS,
        });
    }
    if value.contains('@') {
        return Err(ImageValidationError::RepositoryUrlHasCredentials);
    }
    if has_control_characters(value) || value.contains('?') || value.contains('#') {
        return Err(ImageValidationError::RepositoryUrlNotPublicGitHubHttps);
    }
    let Some(path) = value.strip_prefix("https://github.com/") else {
        return Err(ImageValidationError::RepositoryUrlNotPublicGitHubHttps);
    };
    let path = path.strip_suffix('/').unwrap_or(path);
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(ImageValidationError::RepositoryUrlNotPublicGitHubHttps);
    };
    let valid_component = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    if !valid_component(owner) || !valid_component(repo) {
        return Err(ImageValidationError::RepositoryUrlNotPublicGitHubHttps);
    }
    Ok(format!("https://github.com/{owner}/{repo}"))
}

/// Validate a branch name or a full commit SHA.
///
/// A 40-character lowercase hex string is a fixed commit. Anything else must be
/// a conservative Git branch name; `git check-ref-format`'s ambiguity rules are
/// mirrored here so the same value is safe to pass as an argv element.
pub fn normalize_source_ref(raw: &str) -> Result<(String, Option<String>), ImageValidationError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(ImageValidationError::EmptySourceRef);
    }
    if value.chars().count() > IMAGE_REF_MAX_CHARS {
        return Err(ImageValidationError::SourceRefTooLong {
            max: IMAGE_REF_MAX_CHARS,
        });
    }
    if value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Ok((value.to_string(), Some(value.to_string())));
    }
    let invalid = has_control_characters(value)
        || value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with('/')
        || value.ends_with('.')
        || value.contains("..")
        || value.contains("//")
        || value.contains("@{")
        || value.contains('\\')
        || value.contains('~')
        || value.contains('^')
        || value.contains(':')
        || value.contains('?')
        || value.contains('*')
        || value.contains('[')
        || value.eq_ignore_ascii_case("HEAD")
        || value
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(".lock"));
    if invalid {
        return Err(ImageValidationError::SourceRefInvalid);
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
    {
        return Err(ImageValidationError::SourceRefInvalid);
    }
    Ok((value.to_string(), None))
}

/// Validate and normalize a local directory/bundle path.
///
/// Existence is a build-time fact, not a contract fact: a declaration may name
/// an input that is mounted later. The path must be absolute and must not carry
/// `..`, control characters or a URL scheme.
pub fn normalize_local_path(raw: &str) -> Result<String, ImageValidationError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(ImageValidationError::EmptyLocalPath);
    }
    if value.chars().count() > IMAGE_LOCAL_PATH_MAX_CHARS {
        return Err(ImageValidationError::LocalPathTooLong {
            max: IMAGE_LOCAL_PATH_MAX_CHARS,
        });
    }
    if has_control_characters(value) {
        return Err(ImageValidationError::LocalPathHasControlCharacters);
    }
    let path = std::path::Path::new(value);
    if !path.is_absolute() {
        return Err(ImageValidationError::LocalPathMustBeAbsolute);
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ImageValidationError::LocalPathHasParentSegment);
    }
    Ok(value.to_string())
}

/// Validate one image source and return its canonical form.
pub fn normalize_image_source(
    source: &ImageSource,
) -> Result<NormalizedImageSource, ImageValidationError> {
    match source {
        ImageSource::GitHub {
            repository_url,
            reference,
        } => {
            let repository_url = normalize_github_repository_url(repository_url)?;
            let (reference, requested_sha) = normalize_source_ref(reference)?;
            Ok(NormalizedImageSource::GitHub {
                repository_url,
                reference,
                requested_sha,
            })
        }
        ImageSource::LocalDirectory { path } => Ok(NormalizedImageSource::LocalDirectory {
            path: normalize_local_path(path)?,
        }),
        ImageSource::Compose {
            sources,
            representation,
        } => {
            if sources.is_empty() {
                return Err(ImageValidationError::EmptyComposeSources);
            }
            if sources.len() > IMAGE_COMPOSE_MAX_SOURCES {
                return Err(ImageValidationError::TooManyComposeSources {
                    max: IMAGE_COMPOSE_MAX_SOURCES,
                });
            }
            let mut normalized = sources
                .iter()
                .map(normalize_compose_source)
                .collect::<Result<Vec<_>, _>>()?;
            match representation {
                ImageComposeRepresentation::Flattened => {
                    normalized.sort_by(|left, right| {
                        left.destination
                            .cmp(&right.destination)
                            .then_with(|| left.repository.cmp(&right.repository))
                            .then_with(|| left.reference.cmp(&right.reference))
                    });
                    for pair in normalized.windows(2) {
                        let (Some(left), Some(right)) = (pair.first(), pair.get(1)) else {
                            continue;
                        };
                        if left.destination.is_empty() && right.destination.is_empty() {
                            return Err(ImageValidationError::ComposeDestinationOverlap);
                        }
                        if !left.destination.is_empty()
                            && compose_destination_is_prefix(&left.destination, &right.destination)
                        {
                            return Err(ImageValidationError::ComposeDestinationOverlap);
                        }
                    }
                }
                ImageComposeRepresentation::Referenced => {
                    // Referenced composition layers complete trees at the
                    // composed root. A destination prefix would require an
                    // unproven remap, so it is refused instead.
                    if normalized
                        .iter()
                        .any(|source| !source.destination.is_empty())
                    {
                        return Err(ImageValidationError::ComposeDestinationInvalid);
                    }
                    for pair in normalized.windows(2) {
                        let (Some(left), Some(right)) = (pair.first(), pair.get(1)) else {
                            continue;
                        };
                        if left.repository == right.repository && left.reference == right.reference
                        {
                            return Err(ImageValidationError::ComposeDestinationOverlap);
                        }
                    }
                }
            }
            Ok(NormalizedImageSource::Compose {
                representation: *representation,
                sources: normalized,
            })
        }
    }
}

fn compose_destination_is_prefix(left: &str, right: &str) -> bool {
    right == left
        || right
            .strip_prefix(left)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Validate one Compose source and return its canonical form.
pub fn normalize_compose_source(
    source: &ImageComposeSource,
) -> Result<NormalizedComposeSource, ImageValidationError> {
    let repository = source.repository.trim();
    validate_compose_repository(repository)
        .map_err(|_| ImageValidationError::ComposeRepositoryInvalid)?;
    let reference = source.reference.trim();
    let requested_digest = if is_valid_image_digest(reference) {
        Some(reference.to_string())
    } else if is_valid_compose_tag(reference) {
        None
    } else {
        return Err(ImageValidationError::ComposeReferenceInvalid);
    };
    let destination = normalize_compose_destination(&source.destination)?;
    Ok(NormalizedComposeSource {
        repository: repository.to_string(),
        reference: reference.to_string(),
        requested_digest,
        destination,
    })
}

fn validate_compose_repository(name: &str) -> Result<(), ()> {
    if name.is_empty() || name.chars().count() > IMAGE_COMPOSE_REPOSITORY_MAX_CHARS {
        return Err(());
    }
    for segment in name.split('/') {
        if segment.is_empty()
            || segment.chars().count() > IMAGE_COMPOSE_REPOSITORY_SEGMENT_MAX_CHARS
            || segment == "."
            || segment == ".."
        {
            return Err(());
        }
        let mut characters = segment.chars();
        let first = characters.next().ok_or(())?;
        let last = segment.chars().last().ok_or(())?;
        if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
            return Err(());
        }
        if !last.is_ascii_lowercase() && !last.is_ascii_digit() {
            return Err(());
        }
        if !segment.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '.' | '-')
        }) {
            return Err(());
        }
    }
    Ok(())
}

/// The catalog Tag rule (`[a-z0-9][a-z0-9._-]{0,127}`).
fn is_valid_compose_tag(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    value.len() <= 128
        && characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

/// `/` and the empty string both name the composed root.
fn normalize_compose_destination(raw: &str) -> Result<String, ImageValidationError> {
    let value = raw.trim();
    if value.chars().count() > IMAGE_COMPOSE_DESTINATION_MAX_CHARS {
        return Err(ImageValidationError::ComposeDestinationInvalid);
    }
    if value.is_empty() || value == "/" {
        return Ok(String::new());
    }
    if !value.starts_with('/') || value.ends_with('/') {
        return Err(ImageValidationError::ComposeDestinationInvalid);
    }
    if value.contains('\\')
        || has_control_characters(value)
        || value[1..]
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(ImageValidationError::ComposeDestinationInvalid);
    }
    Ok(value.to_string())
}

/// Validate an alias: a mutable tag that must never look like a digest.
pub fn normalize_alias(raw: &str) -> Result<String, ImageValidationError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(ImageValidationError::EmptyAlias);
    }
    if value.chars().count() > IMAGE_ALIAS_MAX_CHARS {
        return Err(ImageValidationError::AliasTooLong {
            max: IMAGE_ALIAS_MAX_CHARS,
        });
    }
    let Some(first) = value.bytes().next() else {
        return Err(ImageValidationError::EmptyAlias);
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(ImageValidationError::AliasInvalid);
    }
    if value.starts_with(IMAGE_DIGEST_PREFIX)
        || !value.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
    {
        return Err(ImageValidationError::AliasInvalid);
    }
    Ok(value.to_string())
}

/// Validate a digest supplied by a caller.
pub fn normalize_image_digest(raw: &str) -> Result<String, ImageValidationError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(ImageValidationError::EmptyDigest);
    }
    if !is_valid_image_digest(value) {
        return Err(ImageValidationError::InvalidDigest);
    }
    Ok(value.to_string())
}

/// Validate V1 packaging parameters. Deterministic output is a contract, so the
/// accepted parameter set is deliberately exact rather than open-ended.
pub fn validate_packaging(packaging: &ImagePackaging) -> Result<(), ImageValidationError> {
    if packaging.compression != IMAGE_COMPRESSION {
        return Err(ImageValidationError::InvalidCompression);
    }
    if packaging.block_size != IMAGE_BLOCK_SIZE {
        return Err(ImageValidationError::InvalidBlockSize);
    }
    if packaging.fixed_timestamp != IMAGE_FIXED_TIMESTAMP {
        return Err(ImageValidationError::InvalidFixedTimestamp);
    }
    if packaging.fixed_uuid != IMAGE_FIXED_UUID {
        return Err(ImageValidationError::InvalidFixedUuid);
    }
    Ok(())
}

/// Validate a stored build error string before it reaches the database.
pub fn validate_error_text(raw: &str) -> Result<(), ImageValidationError> {
    if raw.chars().count() > IMAGE_ERROR_MAX_CHARS || has_control_characters(raw) {
        return Err(ImageValidationError::ErrorTooLong {
            max: IMAGE_ERROR_MAX_CHARS,
        });
    }
    Ok(())
}

// ── Asynchronous build lifecycle (#3334) ────────────────────────────────
//
// `server.image.build` v1 remains the documented synchronous compatibility
// path: it submits the same durable background build and waits for the terminal
// state. These contracts are the asynchronous family a client uses to submit,
// observe, cancel and retry without holding a request open. A build record is
// execution state; only a succeeded build publishes an immutable Image.

/// Prefix of a durable build identity.
pub const IMAGE_BUILD_ID_PREFIX: &str = "build-";
/// Maximum length of a client-supplied idempotency key.
pub const IMAGE_BUILD_REQUEST_ID_MAX_CHARS: usize = 128;
/// Default page size for `server.image.build.list`.
pub const IMAGE_BUILD_LIST_DEFAULT_LIMIT: u32 = 64;
/// The largest page `server.image.build.list` accepts.
pub const IMAGE_BUILD_LIST_MAX_LIMIT: u32 = 200;
/// Maximum length of the last bounded build diagnostic.
pub const IMAGE_DIAGNOSTIC_MAX_CHARS: usize = 1024;

/// The lifecycle of one durable build record.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageBuildStatus {
    /// Recorded and waiting for a build worker slot.
    Queued,
    /// A worker owns this build and is executing a stage.
    Running,
    /// An immutable verified blob exists at `digest`.
    Succeeded,
    /// The build failed; `error` is the bounded recoverable reason.
    Failed,
    /// The client canceled the build; no bytes were published.
    Canceled,
}

impl ImageBuildStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "canceled" => Some(Self::Canceled),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Canceled)
    }
}

/// The current stage of a running build.
///
/// `mkfs.erofs` has no native progress report, so a packaging build reports
/// this stage and elapsed time, never an invented percentage.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageBuildStage {
    Fetching,
    Snapshotting,
    Validating,
    Packaging,
    Publishing,
}

impl ImageBuildStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fetching => "fetching",
            Self::Snapshotting => "snapshotting",
            Self::Validating => "validating",
            Self::Packaging => "packaging",
            Self::Publishing => "publishing",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "fetching" => Some(Self::Fetching),
            "snapshotting" => Some(Self::Snapshotting),
            "validating" => Some(Self::Validating),
            "packaging" => Some(Self::Packaging),
            "publishing" => Some(Self::Publishing),
            _ => None,
        }
    }
}

/// Measured build progress. Counts are absent until the snapshot manifest has
/// measured them; no field is a guessed total.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageBuildProgress {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// Time since this attempt started, in milliseconds.
    #[serde(default)]
    pub elapsed_ms: u64,
}

/// The source adapter a durable build record was submitted from (#3798).
///
/// This is the bounded filter vocabulary for build history, not a second
/// `ImageSource` owner: it names exactly the three source variants the
/// protocol can carry.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageBuildSourceKind {
    Github,
    LocalDirectory,
    Compose,
}

impl ImageBuildSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::LocalDirectory => "local_directory",
            Self::Compose => "compose",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "github" => Some(Self::Github),
            "local_directory" => Some(Self::LocalDirectory),
            "compose" => Some(Self::Compose),
            _ => None,
        }
    }
}

/// One terminal attempt of a durable build record (#3798).
///
/// The record's current fields describe the latest/active attempt. This
/// history keeps earlier diagnostics so a retry never erases why the previous
/// attempt failed. It is bounded by the Server; older entries are dropped.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildAttempt {
    pub attempt: u32,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    /// The last bounded diagnostic observed for this attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub started_at: u64,
    pub finished_at: u64,
}

/// One durable build record as the asynchronous units return it.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildDescriptor {
    pub build_id: String,
    /// The registry row this build will publish (or reuse).
    pub image_id: String,
    /// 1 for the first attempt; each retry increments it within this record.
    pub attempt: u32,
    pub source: ImageSource,
    /// The exact resolved Git commit, once pinned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_sha: Option<String>,
    pub packaging: ImagePackaging,
    pub status: ImageBuildStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<ImageBuildStage>,
    pub progress: ImageBuildProgress,
    /// The last bounded diagnostic, such as a failed subprocess line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The immutable digest once `status = succeeded`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// Whether this build reused bytes that were already published.
    #[serde(default)]
    pub deduplicated: bool,
    /// Bounded terminal attempt history, oldest first (#3798).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attempts: Vec<ImageBuildAttempt>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// `server.image.build.submit`'s request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildSubmitPayload {
    pub source: ImageSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// Optional idempotency key: a repeated submission with the same key and
    /// the same source returns the existing build record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
}

/// `server.image.build.submit`'s reply: the durable record, returned promptly.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildSubmitResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<ImageBuildDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `server.image.build.get`'s request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildGetPayload {
    pub build_id: String,
}

/// `server.image.build.get`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildGetResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<ImageBuildDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `server.image.build.list`'s request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildListPayload {
    #[serde(default)]
    pub offset: u32,
    #[serde(default = "default_build_list_limit")]
    pub limit: u32,
    /// Exact lifecycle states to include; empty means every state.
    #[serde(default)]
    pub statuses: Vec<ImageBuildStatus>,
    /// Exact source adapters to include; empty means every adapter.
    #[serde(default)]
    pub sources: Vec<ImageBuildSourceKind>,
    /// Case-sensitive substring filter over build id, image id, alias, digest
    /// and persisted source. Empty returns the unfiltered page.
    #[serde(default)]
    pub query: String,
}

fn default_build_list_limit() -> u32 {
    IMAGE_BUILD_LIST_DEFAULT_LIMIT
}

/// `server.image.build.list`'s reply: the durable inventory, newest first.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildListResponsePayload {
    pub builds: Vec<ImageBuildDescriptor>,
    pub total: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `server.image.build.cancel`'s request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildCancelPayload {
    pub build_id: String,
    /// The attempt the caller observed. A mismatch is a conflict and the
    /// Server returns the current record rather than canceling a different
    /// attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
}

/// `server.image.build.cancel`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildCancelResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<ImageBuildDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `server.image.build.retry`'s request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildRetryPayload {
    pub build_id: String,
    /// The attempt the caller observed. A mismatch is a conflict and the
    /// Server opens no new attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
}

/// `server.image.build.retry`'s reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBuildRetryResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<ImageBuildDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

/// `build-` followed by a non-empty UUID-shaped identity.
pub fn is_valid_image_build_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix(IMAGE_BUILD_ID_PREFIX) else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 64
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Validate a build identity supplied by a caller.
pub fn normalize_image_build_id(raw: &str) -> Result<String, ImageValidationError> {
    let value = raw.trim();
    if value.is_empty() || !is_valid_image_build_id(value) {
        return Err(ImageValidationError::InvalidBuildId);
    }
    Ok(value.to_string())
}

/// Validate an optional client idempotency key.
///
/// The key is opaque to the Server except for its bounded shape; it is scoped to
/// one Server's build root. An empty key is invalid rather than "absent" so a
/// caller cannot accidentally lose idempotency to a blank field.
pub fn normalize_client_request_id(raw: &str) -> Result<String, ImageValidationError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(ImageValidationError::EmptyClientRequestId);
    }
    if value.chars().count() > IMAGE_BUILD_REQUEST_ID_MAX_CHARS {
        return Err(ImageValidationError::ClientRequestIdTooLong {
            max: IMAGE_BUILD_REQUEST_ID_MAX_CHARS,
        });
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':'))
    {
        return Err(ImageValidationError::ClientRequestIdInvalid);
    }
    Ok(value.to_string())
}
