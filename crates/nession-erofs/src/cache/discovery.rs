//! Peer OCI image source discovery and resilient pinned fetch (#4091).
//!
//! This is the Nession-specific **control plane** over the accepted shared
//! mechanics: it decides *which* authorized source serves one immutable image,
//! never *how* bytes are transferred or verified. The verified fetch stays with
//! the #3499 distribution engine ([`super::fetch::fetch_manifest_image_v2`]) and
//! the #4087 CAS (verify-before-Ready, atomic dedupe); the read-only peer endpoint
//! stays the #4088 [`RegistryService`] mounted by the #4090 Agent adapter.
//!
//! Contract:
//!
//! - A requester resolves and authorizes its immutable Manifest digest **first**
//!   ([`PinnedClosure::validate`] + [`FetchAuthorizer::authorize_fetch`]) before
//!   any source is contacted, so a denied principal/Session never reaches the
//!   network and a tag can never substitute a different revision.
//! - Discovery is a **bounded explicit candidate list** ([`ImageSource`]), not an
//!   availability inventory database or a speculative P2P CDN. Each candidate
//!   carries its own repository-scoped credential provider; there is no global
//!   Server bearer shared across peers, and possessing a digest confers no access.
//! - Sources are tried in order; the first that serves the complete verified
//!   closure for the *same pinned digest* wins. An unavailable, unauthorized,
//!   evicted or mid-transfer-disconnected peer falls back only to another
//!   authorized source for that digest. The distribution engine publishes nothing
//!   Ready until exact bytes hash to the requested digest, so a partial transfer
//!   is never consumed.
//! - Per-digest single-flight serializes concurrent fetches of one digest; a
//!   warm cache adopts the verified Ready bytes without a second transfer.
//!   Provenance diagnostics name the source kind/authority only — never a token.
//!
//! The module is host-independent (no Server/Agent dependency) and compiles in
//! the Agent's `cache` feature set without the external registry client: peer
//! pulls present a scoped static bearer grant through the same distribution
//! engine the normal local-cache/Sandbox preparation path already uses.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};

use super::fetch::{fetch_manifest_image_v2, FetchedImage, ImageObjectGrant};
use super::ErofsCache;
use crate::contracts::validate_repository_name;
use crate::digest::is_valid_digest;
use crate::oci::annotation::{MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST};

/// The provenance class of one image source. Diagnostics only; it carries no
/// credential and never decides authorization (the scoped grant and the source's
/// repository reachability fence do that).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// Another authorized Agent's read-only OCI Registry.
    Peer,
    /// The Server's authoritative OCI Registry.
    Server,
    /// An approved external upstream (for example GHCR).
    Upstream,
}

impl SourceKind {
    /// A short stable label for provenance diagnostics.
    pub fn label(self) -> &'static str {
        match self {
            SourceKind::Peer => "peer",
            SourceKind::Server => "server",
            SourceKind::Upstream => "upstream",
        }
    }
}

/// Supplies the repository-scoped bearer grant for exactly one source authority
/// and repository. The host owns the implementation and its secret source.
///
/// Returning `None` is fail-closed: the source is skipped without a network
/// request. A provider must never return a global Server credential for a peer
/// authority, and the returned token must never be formatted, logged or stored
/// in a diagnostic, grant object or error.
pub trait SourceCredentialProvider: Send + Sync {
    /// The scoped bearer token for `origin`/`repository`, or `None` when this
    /// principal holds no grant for that source.
    fn grant_token(&self, origin: &str, repository: &str) -> Option<String>;
}

/// A provider that holds no grant for any source (fail-closed default).
#[derive(Debug, Default, Clone, Copy)]
pub struct NoGrant;

impl SourceCredentialProvider for NoGrant {
    fn grant_token(&self, _origin: &str, _repository: &str) -> Option<String> {
        None
    }
}

/// One explicitly approved candidate source: an authorized Registry endpoint and
/// its own repository-scoped credential provider. The endpoint is a base URL
/// (`http://127.0.0.1:5000` or `https://registry.example`); it never carries a
/// credential. `Debug` is redacted so the credential provider is never exposed.
#[derive(Clone)]
pub struct ImageSource {
    /// The registry base URL (scheme + authority, no path, no credential).
    pub origin: String,
    /// The remote repository path this source exposes.
    pub repository: String,
    /// The provenance class of this source.
    pub kind: SourceKind,
    credentials: Arc<dyn SourceCredentialProvider>,
}

impl ImageSource {
    /// Build a candidate, validating the endpoint scheme and repository grammar.
    pub fn new(
        origin: impl Into<String>,
        repository: impl Into<String>,
        kind: SourceKind,
        credentials: Arc<dyn SourceCredentialProvider>,
    ) -> Result<Self> {
        let origin = origin.into();
        let repository = repository.into();
        if !(origin.starts_with("http://") || origin.starts_with("https://")) {
            anyhow::bail!("image source origin must be an http(s) base URL");
        }
        if origin.ends_with('/') {
            anyhow::bail!("image source origin must not carry a trailing path");
        }
        validate_repository_name(&repository)?;
        Ok(Self {
            origin,
            repository,
            kind,
            credentials,
        })
    }

    /// The scoped grant for this source, or `None` (fail closed). The token is
    /// handed straight to the distribution engine; it is never returned to a
    /// caller that would log or store it.
    fn scoped_token(&self) -> Option<String> {
        self.credentials.grant_token(&self.origin, &self.repository)
    }
}

impl fmt::Debug for ImageSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageSource")
            .field("origin", &self.origin)
            .field("repository", &self.repository)
            .field("kind", &self.kind)
            .field("credentials", &"<redacted>")
            .finish()
    }
}

/// The advertised verified pinned closure of one image: an immutable Manifest
/// digest plus its complete authorized descriptor set (Manifest/Config/EROFS by
/// digest). This is the availability the control plane advertises; it is resolved
/// and authorized before any source is contacted, and every source must deliver
/// exactly these digests.
#[derive(Debug, Clone)]
pub struct PinnedClosure {
    /// The immutable Manifest digest the requester resolved and authorized.
    pub manifest_digest: String,
    /// The complete descriptor closure (exactly one Manifest, Config and EROFS
    /// layer), each named by its immutable digest and size.
    pub objects: Vec<ImageObjectGrant>,
}

impl PinnedClosure {
    /// Validate the pinned closure **before any network access**: the digest is
    /// well-formed, the closure holds exactly one Manifest/Config/EROFS object,
    /// and the Manifest object's digest equals the pinned digest. A malformed or
    /// substituted closure is refused, so a tag result can never replace the
    /// pinned revision.
    pub fn validate(&self) -> Result<()> {
        if !is_valid_digest(&self.manifest_digest) {
            anyhow::bail!("pinned closure has an invalid Manifest digest");
        }
        let mut manifests = 0;
        let mut configs = 0;
        let mut layers = 0;
        for object in &self.objects {
            if !is_valid_digest(&object.digest) {
                anyhow::bail!("pinned closure object has an invalid digest");
            }
            match object.media_type.as_str() {
                MEDIA_TYPE_MANIFEST => {
                    manifests += 1;
                    if object.digest != self.manifest_digest {
                        anyhow::bail!(
                            "pinned closure Manifest {} disagrees with the pinned digest {}",
                            object.digest,
                            self.manifest_digest
                        );
                    }
                }
                MEDIA_TYPE_CONFIG => configs += 1,
                MEDIA_TYPE_EROFS => layers += 1,
                other => {
                    anyhow::bail!("pinned closure has unsupported object media type {other:?}")
                }
            }
        }
        if manifests != 1 || configs != 1 || layers != 1 {
            anyhow::bail!(
                "pinned closure must name exactly one Manifest/Config/EROFS object \
                 (got {manifests}/{configs}/{layers})"
            );
        }
        Ok(())
    }
}

/// The requester's fetch policy, consulted once before any source is contacted.
///
/// The host implements this over its principal/Session/tenant rules. A denied
/// fetch never reaches the network, so it cannot reveal whether a remote object
/// exists. It carries no credential and no image bytes.
pub trait FetchAuthorizer: Send + Sync {
    /// Authorize fetching `manifest_digest` into `local_repository`.
    fn authorize_fetch(&self, manifest_digest: &str, local_repository: &str) -> Result<()>;
}

/// A policy that approves nothing (fail-closed default of a new adapter).
#[derive(Debug, Default, Clone, Copy)]
pub struct DenyAllFetch;

impl FetchAuthorizer for DenyAllFetch {
    fn authorize_fetch(&self, _manifest_digest: &str, local_repository: &str) -> Result<()> {
        anyhow::bail!("fetch denied for {local_repository}");
    }
}

/// The source that served one verified pinned closure (provenance diagnostics).
/// It names the source kind and authority only — never a credential or token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceProvenance {
    /// The provenance class of the winning source.
    pub kind: SourceKind,
    /// The winning source authority (base URL, no credential).
    pub origin: String,
    /// The repository the closure was served from.
    pub repository: String,
}

/// Per-digest single-flight source fetcher with resilient authorized fallback.
///
/// One fetcher coordinates concurrent fetches of the same pinned digest: a keyed
/// async lock serializes them, and the distribution engine's warm-cache adoption
/// means a coalesced caller reuses the verified Ready bytes without a second
/// transfer. The fetcher owns no durable state and no credential.
#[derive(Default)]
pub struct SourceFetcher {
    flights: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl SourceFetcher {
    /// A fetcher with no in-flight digests.
    pub fn new() -> Self {
        Self::default()
    }

    fn flight_lock(&self, digest: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut flights = self
            .flights
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Arc::clone(
            flights
                .entry(digest.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    /// Fetch one pinned closure from the first reachable authorized source.
    ///
    /// Ordering: validate the pinned closure and authorize the fetch **first**
    /// (no network on denial); take the per-digest single-flight lock; try each
    /// bounded candidate in order, skipping any source this principal holds no
    /// scoped grant for; fetch the complete closure through the normal verified
    /// local-cache path; re-verify the served Manifest equals the pinned digest.
    /// The first verified closure wins and its provenance is returned. A failed,
    /// unauthorized, evicted or disconnected source falls back to the next
    /// authorized candidate for the *same* digest; the distribution engine never
    /// publishes partial bytes Ready. If no source serves the closure, the error
    /// lists the attempted source kinds/authorities — never a token.
    pub async fn fetch_pinned(
        &self,
        cache: &ErofsCache,
        closure: &PinnedClosure,
        sources: &[ImageSource],
        authorizer: &dyn FetchAuthorizer,
        local_repository: &str,
    ) -> Result<(FetchedImage, SourceProvenance)> {
        // Resolve/authorize the immutable digest before any source is contacted.
        closure
            .validate()
            .context("pinned closure rejected before discovery")?;
        authorizer
            .authorize_fetch(&closure.manifest_digest, local_repository)
            .context("fetch authorization denied before discovery")?;
        if sources.is_empty() {
            anyhow::bail!("no authorized image source candidates were provided");
        }
        validate_repository_name(local_repository)?;

        // Per-digest single-flight: concurrent fetches of one digest serialize;
        // a coalesced caller adopts the warm verified cache without re-fetching.
        let lock = self.flight_lock(&closure.manifest_digest);
        let _guard = lock.lock().await;

        let mut attempts: Vec<String> = Vec::new();
        for source in sources {
            // Fail closed: no scoped grant for this source means no request.
            let Some(token) = source.scoped_token() else {
                attempts.push(format!(
                    "{}:{} (no grant)",
                    source.kind.label(),
                    source.origin
                ));
                continue;
            };
            // The closure is repository-independent (immutable digests); derive
            // the authorized `/v2/` route for THIS source's repository so the
            // same pinned closure can be served by any approved candidate.
            let grants = source_grants(closure, &source.repository);
            match fetch_manifest_image_v2(
                cache,
                &grants,
                &source.origin,
                &token,
                &source.repository,
            )
            .await
            {
                Ok(fetched) => {
                    // Re-verify the served revision is exactly the pinned digest,
                    // regardless of which source delivered it.
                    if fetched.manifest_digest != closure.manifest_digest {
                        attempts.push(format!(
                            "{}:{} (digest mismatch)",
                            source.kind.label(),
                            source.origin
                        ));
                        continue;
                    }
                    return Ok((
                        fetched,
                        SourceProvenance {
                            kind: source.kind,
                            origin: source.origin.clone(),
                            repository: source.repository.clone(),
                        },
                    ));
                }
                Err(error) => {
                    // The distribution error names the digest/route, never the
                    // bearer token; record only the source class and authority.
                    attempts.push(format!(
                        "{}:{} ({error:#})",
                        source.kind.label(),
                        source.origin
                    ));
                }
            }
        }
        anyhow::bail!(
            "no authorized source served pinned Manifest {}: [{}]",
            closure.manifest_digest,
            attempts.join("; ")
        )
    }
}

/// Derive the repository-scoped `/v2/` grant routes for one source. The Manifest
/// is fetched by its immutable digest; Config/EROFS objects by their blob digest.
/// The closure's own `path` field is advisory — the authorized route is always
/// recomputed from the source repository so a foreign path can never be injected.
fn source_grants(closure: &PinnedClosure, repository: &str) -> Vec<ImageObjectGrant> {
    closure
        .objects
        .iter()
        .map(|object| ImageObjectGrant {
            digest: object.digest.clone(),
            media_type: object.media_type.clone(),
            size_bytes: object.size_bytes,
            path: if object.media_type == MEDIA_TYPE_MANIFEST {
                format!("/v2/{repository}/manifests/{}", object.digest)
            } else {
                format!("/v2/{repository}/blobs/{}", object.digest)
            },
        })
        .collect()
}

#[cfg(test)]
mod tests;
