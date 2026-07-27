//! SeaORM entity for the `quick_commands` table (issue #95, part 3).
//!
//! Stores user-defined quick commands that were previously kept only in
//! browser localStorage. The 5 hardcoded presets are NOT stored here —
//! they remain frontend-only.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "quick_commands")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub label: String,
    pub command: String,
    #[sea_orm(default_value = false)]
    pub raw: bool,
    #[sea_orm(default_value = 0)]
    pub sort_order: i32,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
