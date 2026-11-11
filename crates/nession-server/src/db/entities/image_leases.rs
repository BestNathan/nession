//! SeaORM entity for the `image_leases` table (#3022).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "image_leases")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub lease_id: String,
    pub image_digest: String,
    pub project_id: String,
    pub expires_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
