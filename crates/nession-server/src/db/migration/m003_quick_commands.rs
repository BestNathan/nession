//! Migration m003 — `quick_commands` table (issue #95, part 3).
//!
//! Stores user-defined quick commands that were previously kept only in
//! browser localStorage.  The 5 hardcoded presets are NOT stored here.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let builder = Table::create()
            .table(QuickCommands::Table)
            .if_not_exists()
            .col(
                ColumnDef::new(QuickCommands::Id)
                    .string()
                    .not_null()
                    .primary_key(),
            )
            .col(ColumnDef::new(QuickCommands::Label).string().not_null())
            .col(ColumnDef::new(QuickCommands::Command).string().not_null())
            .col(ColumnDef::new(QuickCommands::Raw).boolean().default(false))
            .col(
                ColumnDef::new(QuickCommands::SortOrder)
                    .integer()
                    .default(0),
            )
            .col(
                ColumnDef::new(QuickCommands::CreatedAt)
                    .big_integer()
                    .not_null(),
            )
            .to_owned();
        manager.create_table(builder).await?;
        Ok(())
    }
}

#[derive(Iden)]
pub enum QuickCommands {
    Table,
    Id,
    Label,
    Command,
    Raw,
    SortOrder,
    CreatedAt,
}
