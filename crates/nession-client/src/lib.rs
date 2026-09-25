//! A Nession Server consumer's boundary.
//!
//! Transport, the `server.auth` handshake, request/reply correlation, and one
//! typed method per Protocol Unit this consumer speaks. `nession-cli` and the
//! MCP host #565 plans both consume the Server; neither owns this, so it lives
//! in neither of them (see `Cargo.toml` for the dependency rule that makes that
//! mechanical rather than a convention).
//!
//! ## What it owns, and what it must never grow
//!
//! It owns transport, correlation and errors. **It owns no DTO.** Every request
//! and reply type named here is a `nession_protocol::contracts::…` type.
//!
//! That is not tidiness. The boundary this replaces —
//! `nession-cli`'s `client/connection.rs` — grew a local `AgentInfo` that had
//! silently lost eleven of `WebAgentInfo`'s fields, and a local `SessionInfo`
//! beside it, and because both were decoded from `serde_json::Value` by hand,
//! neither could ever notice. A contract field rename against a local copy is a
//! runtime surprise or, when the copy is narrower, nothing at all; against the
//! contract type it is a compile error at every call site that reads the field.
//!
//! ## Reading a call
//!
//! ```no_run
//! # async fn example() -> Result<(), nession_client::ClientError> {
//! use nession_client::{ClientConfig, ClientConnection};
//!
//! let mut client = ClientConnection::connect(ClientConfig::new("ws://localhost:19090", "token")).await?;
//! match client.list_agents().await? {
//!     nession_protocol::contracts::agent::v1::AgentListReply::Listed(list) => {
//!         for agent in &list.agents {
//!             println!("{}", agent.agent_id);
//!         }
//!     }
//!     nession_protocol::contracts::agent::v1::AgentListReply::Refused(refusal) => {
//!         eprintln!("the server refused: {}", refusal.message);
//!     }
//! }
//! # Ok(())
//! # }
//! ```

pub mod connection;
pub mod error;
pub mod unit;
pub mod units;
pub mod wire;

pub use connection::{open_ws, ClientConfig, ClientConnection, WsStream, DEFAULT_REQUEST_TIMEOUT};
pub use error::ClientError;
pub use unit::{proto_msg, UnitRequest};
pub use units::AttachMode;
