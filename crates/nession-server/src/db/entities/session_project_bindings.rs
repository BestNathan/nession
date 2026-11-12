//! SeaORM entity for the `session_project_bindings` table (#3082).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "session_project_bindings")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub session_id: String,
    pub agent_id: String,
    pub project_id: String,
    /// Durable tmux instance identity; empty until reconciled.
    pub incarnation_id: String,
    /// Agent-reported tmux creation time fallback; `0` until reconciled.
    pub agent_created_at: i64,
    pub revision: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
