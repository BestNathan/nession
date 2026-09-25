//! The core contracts — the Protocol Units Nession itself owns (`#678`).
//!
//! One module per family, one file per contract version:
//!
//! ```text
//! contracts/
//! ├── agent/v1.rs      agent.register, agent.heartbeat, agent.address.update
//! ├── session/v1.rs    session.create, session.attach, session.env.apply
//! ├── env/v1.rs        env.{list,get,write,delete} at both ends
//! ├── client/v1.rs     server.auth — the peer-to-peer door
//! ├── commands/v1.rs   commands.{list,add,remove,update}
//! ├── server/v1.rs     server.info
//! ├── terminal/v1.rs   terminal.{input,resize,output} — the P2P stream
//! └── file/v1.rs       file.{list,read,write,delete,create_dir,rename,cwd}
//! ```
//!
//! A family becomes a version directory when it holds a second version; a
//! `v1/` directory holding the only version is structure without content. So
//! each family is a directory (it will grow one day) and each version is
//! currently a single file — which is the rule the provider layout uses too
//! (`protocol/<unit>/v1.rs`), applied to the units Nession owns.
//!
//! The family is the segment the protocol id names: `server.session.attach`
//! belongs to `session`, `server.env.list` to `env`. Placement is then a
//! lookup, not a judgement, which is what keeps this directory from decaying
//! into a `misc/`.
//!
//! Tests live beside the contract they exercise, in `tests.rs`. An
//! `agent/v1.rs` whose tests sit in a shared file two directories up is a
//! contract that can be changed without its tests being read.

pub mod agent;

pub mod client;
pub mod commands;
pub mod env;
pub mod file;
#[cfg(test)]
mod fixtures;
pub mod p2p;
pub mod server;
pub mod session;
pub mod terminal;

/// The build tag of whichever binary is answering.
///
/// `AgentMetadata` and `ServerInfoResponse` both report one, and both mean the
/// same thing by it — so it is owned here rather than copied into either
/// family, where the two copies would be free to drift apart.
pub(crate) fn default_image_tag() -> String {
    "unknown".to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_build_tag_defaults_to_unknown_rather_than_empty() {
        // An empty tag would read as "this binary reported no tag", which is a
        // different claim from "this binary predates tags". The UI renders the
        // two differently, so the default has to be a word, not an absence.
        assert_eq!(super::default_image_tag(), "unknown");
    }
}
