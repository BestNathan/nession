//! Migration m002 — `env_files` table (issue #95, part 2).
//!
//! Stores server-managed `.env` files that were previously kept only on the
//! filesystem under `~/.nession/server/envs`.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let builder = Table::create()
            .table(EnvFiles::Table)
            .if_not_exists()
            .col(
                ColumnDef::new(EnvFiles::Name)
                    .string()
                    .not_null()
                    .primary_key(),
            )
            .col(ColumnDef::new(EnvFiles::Content).text().not_null())
            .col(ColumnDef::new(EnvFiles::CreatedAt).big_integer().not_null())
            .col(ColumnDef::new(EnvFiles::UpdatedAt).big_integer().not_null())
            .to_owned();
        manager.create_table(builder).await?;
        Ok(())
    }
}

#[derive(Iden)]
pub enum EnvFiles {
    Table,
    Name,
    Content,
    CreatedAt,
    UpdatedAt,
}
