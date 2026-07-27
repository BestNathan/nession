//! SeaORM entity for the `sessions` table.
//!
//! Schema matches the original rusqlite definition. Sessions are not the
//! server's source of truth (the agent is) — this table is a cache for
//! restart recovery and UI listing.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "sessions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub created_at: i64,
    pub last_activity: i64,
    pub status: String,
    pub window_count: i32,
    pub attached_clients: i32,
    pub metadata: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
