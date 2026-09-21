//! Protocol identity and contract version — the two names everything else
//! refers to a protocol by.
//!
//! ## Why identity and the message type are modelled separately
//!
//! A contract's wire is its **transport projection**, not its identity. Keeping
//! the two separately nameable is what lets a transport rename be told apart
//! from a semantic change: otherwise both are just "the string changed", and
//! only one of them is a breaking contract event.
//!
//! Today that is a capability rather than a difference. Every unit answers on
//! exactly one wire, and that wire is its id — the rule is in
//! `docs/architecture/protocol-identity.md`. It has not always held: the wire
//! used to be `extension.git.status` for the unit identified as `git.status`,
//! with the namespace carried across each hop only to be stripped at the far
//! end.
//!
//! So `ProtocolId` is canonical and transport-free (`git.status`), and the
//! projection lives on the contract as data ([`super::descriptor`]) — the
//! field that would carry a second projection if one were ever needed.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Ceiling on a canonical id. Long enough for `claude-code.read`, short enough
/// that an id arriving from a peer cannot be used to make a map key expensive.
pub const MAX_ID_LEN: usize = 128;

/// Separator between a Protocol Unit and its operation, and between any
/// further nesting.
const SEGMENT_SEP: char = '.';

/// The characters a segment may contain, besides [`SEGMENT_SEP`].
///
/// Lowercase only, and no `_`: the wire already carries both spellings
/// (`extension.claude_code.read` against the model's `claude-code.read`), and
/// allowing both here would let two ids name the same protocol. The mapping
/// from a wire string to an id is a decision each contract states explicitly,
/// not a normalisation this type performs silently.
fn is_segment_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'
}

/// Why a string is not a canonical [`ProtocolId`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdentityError {
    #[error("protocol id is empty")]
    Empty,
    #[error("protocol id is {0} bytes, over the {MAX_ID_LEN}-byte ceiling")]
    TooLong(usize),
    #[error("protocol id `{0}` needs at least two segments (`unit.operation`)")]
    TooFewSegments(String),
    #[error("segment `{0}` of `{1}` is empty")]
    EmptySegment(String, String),
    #[error("segment `{0}` of `{1}` starts or ends with `-`")]
    EdgeHyphen(String, String),
    #[error("segment `{0}` of `{1}` contains `{2}`, which is not allowed")]
    BadChar(String, String, char),
    #[error("contract version must be at least 1, got 0")]
    ZeroVersion,
}

/// A Protocol Unit's stable identity, independent of every transport.
///
/// Canonical form is lowercase segments joined by `.`, e.g. `git.status`,
/// `session.attach`, `claude-code.read`. The `protocol://` prefix the design
/// documents use is a *display* convention and is deliberately not accepted
/// here: two spellings of one identity is the thing this type exists to
/// prevent.
///
/// Constructed only through [`ProtocolId::new`], so an invalid id cannot reach
/// a registry key or a manifest.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(try_from = "String", into = "String")]
#[cfg_attr(feature = "codegen", schemars(with = "String"))]
pub struct ProtocolId(String);

impl ProtocolId {
    /// Validate and canonicalise `candidate`.
    pub fn new(candidate: &str) -> Result<Self, IdentityError> {
        if candidate.is_empty() {
            return Err(IdentityError::Empty);
        }
        if candidate.len() > MAX_ID_LEN {
            return Err(IdentityError::TooLong(candidate.len()));
        }

        let mut segments = 0usize;
        for segment in candidate.split(SEGMENT_SEP) {
            segments += 1;
            if segment.is_empty() {
                return Err(IdentityError::EmptySegment(
                    segment.to_string(),
                    candidate.to_string(),
                ));
            }
            if segment.starts_with('-') || segment.ends_with('-') {
                return Err(IdentityError::EdgeHyphen(
                    segment.to_string(),
                    candidate.to_string(),
                ));
            }
            for c in segment.chars() {
                if !is_segment_char(c) {
                    return Err(IdentityError::BadChar(
                        segment.to_string(),
                        candidate.to_string(),
                        c,
                    ));
                }
            }
        }

        // A single segment names a family, not an operation, and a family is
        // not something a consumer can call or a provider can implement. The
        // two-segment floor is what keeps `git` from being registered as a
        // protocol distinct from `git.status`.
        if segments < 2 {
            return Err(IdentityError::TooFewSegments(candidate.to_string()));
        }

        Ok(Self(candidate.to_string()))
    }

    /// The canonical string, without any display prefix.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProtocolId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Debug is the canonical string, not the derived `ProtocolId("git.status")`.
///
/// These ids appear inside `{:?}`-formatted error values, which are the
/// messages a person reads when a resolution fails. A newtype wrapper's derived
/// Debug is an implementation detail leaking into a diagnosis.
impl fmt::Debug for ProtocolId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl AsRef<str> for ProtocolId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ProtocolId {
    type Error = IdentityError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl From<ProtocolId> for String {
    fn from(value: ProtocolId) -> Self {
        value.0
    }
}

/// A Contract Version: the half of the protocol's evolution a Consumer can
/// observe.
///
/// Distinct from a Provider's *implementation generation*, which advances
/// without the contract moving (a race fix is not a v2). Keeping them as two
/// types is the point — one `u32` covering both is how a bug fix starts
/// looking like a breaking change.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(try_from = "u32", into = "u32")]
#[cfg_attr(feature = "codegen", schemars(with = "u32"))]
pub struct ContractVersion(u32);

impl ContractVersion {
    /// The first version every contract starts at.
    pub const V1: Self = Self(1);

    /// Validate and wrap a version number.
    ///
    /// Zero is refused rather than treated as "unversioned": a contract with no
    /// version is not a thing this model can express, and allowing 0 would give
    /// every such contract a value that compares below a real one and sorts
    /// first in a manifest.
    pub fn new(value: u32) -> Result<Self, IdentityError> {
        if value == 0 {
            return Err(IdentityError::ZeroVersion);
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

impl fmt::Display for ContractVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "v{}", self.0)
    }
}

/// Debug is `v1`, not `ContractVersion(1)`, for the same reason as
/// [`ProtocolId`]: it is rendered inside failure messages, and
/// `offers [ContractVersion(1)]` is a worse sentence than `offers [v1]`.
impl fmt::Debug for ContractVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl TryFrom<u32> for ContractVersion {
    type Error = IdentityError;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<ContractVersion> for u32 {
    fn from(value: ContractVersion) -> Self {
        value.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_ids_the_design_names() {
        for id in ["git.status", "session.attach", "claude-code.read", "a.b.c"] {
            assert!(
                ProtocolId::new(id).is_ok(),
                "expected {id:?} to be canonical"
            );
        }
    }

    #[test]
    fn refuses_a_lone_segment() {
        // `git` is a family, not something a consumer can call.
        let err = ProtocolId::new("git").unwrap_err();
        assert_eq!(err, IdentityError::TooFewSegments("git".to_string()));
    }

    #[test]
    fn refuses_the_underscore_spelling_rather_than_aliasing_it() {
        // The wire says `claude_code`, the model says `claude-code`. Accepting
        // both here would make them two identities for one protocol, and the
        // mapping between them belongs to the contract that states it.
        let err = ProtocolId::new("claude_code.read").unwrap_err();
        assert!(
            matches!(err, IdentityError::BadChar(_, _, '_')),
            "got {err:?}"
        );
    }

    #[test]
    fn refuses_the_display_prefix() {
        // `protocol://git.status` is how the documents write it. Storing the
        // prefix would give one protocol two string forms.
        assert!(ProtocolId::new("protocol://git.status").is_err());
    }

    #[test]
    fn refuses_empty_segments_and_edge_hyphens() {
        for bad in [
            "git..status",
            ".git.status",
            "git.status.",
            "-git.status",
            "git-.status",
        ] {
            assert!(
                ProtocolId::new(bad).is_err(),
                "expected {bad:?} to be refused"
            );
        }
    }

    #[test]
    fn refuses_uppercase_and_over_long_ids() {
        assert!(ProtocolId::new("Git.Status").is_err());
        let long = format!("{}.{}", "a".repeat(70), "b".repeat(70));
        assert!(matches!(
            ProtocolId::new(&long).unwrap_err(),
            IdentityError::TooLong(_)
        ));
    }

    #[test]
    fn an_id_round_trips_through_serde_as_a_plain_string() {
        // The wire form is the canonical string, not a struct — a manifest read
        // by another language must not have to know this type exists.
        let id = ProtocolId::new("git.status").unwrap();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"git.status\"");
        assert_eq!(serde_json::from_str::<ProtocolId>(&json).unwrap(), id);
    }

    #[test]
    fn a_non_canonical_id_is_refused_on_deserialisation_too() {
        // Validation that only runs on the constructing path is not validation:
        // a manifest arriving from a peer is deserialised, never `new`ed.
        assert!(serde_json::from_str::<ProtocolId>("\"Not An Id\"").is_err());
    }

    #[test]
    fn versions_start_at_one_and_zero_is_refused() {
        assert_eq!(ContractVersion::V1.get(), 1);
        assert_eq!(
            ContractVersion::new(0).unwrap_err(),
            IdentityError::ZeroVersion
        );
        assert_eq!(ContractVersion::new(3).unwrap().to_string(), "v3");
    }

    #[test]
    fn versions_round_trip_as_plain_integers() {
        let v = ContractVersion::new(2).unwrap();
        assert_eq!(serde_json::to_string(&v).unwrap(), "2");
        assert_eq!(serde_json::from_str::<ContractVersion>("2").unwrap(), v);
        assert!(serde_json::from_str::<ContractVersion>("0").is_err());
    }

    #[test]
    fn debug_renders_the_canonical_form_because_it_appears_in_error_messages() {
        // The derived Debug put `ProtocolId("git.status")` and
        // `ContractVersion(1)` inside `{:?}`-formatted failures — a resolution
        // error is read by a person deciding which side has to move, and the
        // newtype wrapper is not part of that answer.
        let id = ProtocolId::new("git.status").unwrap();
        let v = ContractVersion::new(1).unwrap();
        assert_eq!(format!("{id:?}"), "git.status");
        assert_eq!(format!("{v:?}"), "v1");
        assert_eq!(
            format!("{:?}", vec![v, ContractVersion::new(2).unwrap()]),
            "[v1, v2]"
        );
    }
}
