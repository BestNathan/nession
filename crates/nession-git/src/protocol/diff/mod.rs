//! `git.diff` — one file's change, from a typed source.
//!
//! One module per Protocol Unit, one file per contract version. A v2 goes
//! beside `v1.rs`; `v1.rs` is never edited to express it.

pub mod v1;
pub mod v2;

pub use v1::{DiffOkV1, DiffRequestV1};
pub use v2::{DiffOkV2, DiffRequestV2, DiffSourceV2};

use nession_protocol::{IdentityError, ProtocolDescriptor};

pub const ID: &str = "git.diff";

/// The one wire both generations travel as.
pub const WIRE: &str = v1::WIRE;

/// v1 answers `HEAD -> WORKTREE`; v2 can also answer `HEAD -> INDEX` and
/// `INDEX -> WORKTREE`, which staging must never infer from one combined patch.
pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    super::versioned_descriptor(ID, WIRE, &[1, 2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_generations_are_declared_on_the_one_wire() {
        let descriptor = descriptor().unwrap();
        assert_eq!(descriptor.id.as_str(), "git.diff");
        assert_eq!(descriptor.owner, "nession-git");
        for contract in &descriptor.contracts {
            assert_eq!(contract.wire, vec![WIRE.to_string()]);
        }
        assert_eq!(
            descriptor.versions(),
            vec![
                nession_protocol::ContractVersion::new(1).unwrap(),
                nession_protocol::ContractVersion::new(2).unwrap()
            ]
        );
        assert!(descriptor.validate().is_ok());
    }
}
