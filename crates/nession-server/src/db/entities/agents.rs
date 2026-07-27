//! SeaORM entity for the `agents` table.
//!
//! Columns mirror the original hand-written rusqlite schema exactly so a
//! pre-existing `server.db` validates without a data migration. Integer
//! widths use `i32`/`i64` (SQLite's native affinity); the DAO layer converts
//! to/from the `u16`/`u32` shapes callers expect.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "agents")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: i32,
    pub registered_at: i64,
    pub last_heartbeat: i64,
    pub status: String,
    pub auth_token_hash: String,
    /// Nullable in the schema; empty string ("{}") is written by the DAO.
    pub metadata: Option<String>,
    /// Human-readable display name; `None` falls back to hostname in the UI.
    pub display_name: Option<String>,
    /// Public WebSocket URL, persisted so it survives restarts.
    pub connect_url: Option<String>,
    /// JSON-encoded `Vec<AgentAddress>`; `None`/empty when none advertised.
    pub addresses: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
