//! Migration m005 — `projects` table (#3021).
//!
//! Project is a first-class, server-owned declaration: it must survive a
//! Server restart with its identity and references unchanged. The table stores
//! only desired state — no Agent row is required, so a Project may exist while
//! every Agent it refers to is offline.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let builder = Table::create()
            .table(Projects::Table)
            .if_not_exists()
            .col(
                ColumnDef::new(Projects::ProjectId)
                    .string()
                    .not_null()
                    .primary_key(),
            )
            .col(ColumnDef::new(Projects::Name).string().not_null())
            .col(ColumnDef::new(Projects::Description).text().null())
            .col(ColumnDef::new(Projects::SourceJson).text().null())
            .col(
                ColumnDef::new(Projects::LocationsJson)
                    .text()
                    .not_null()
                    .default("[]"),
            )
            .col(ColumnDef::new(Projects::SessionDefaultsJson).text().null())
            .col(ColumnDef::new(Projects::ImageDigest).string().null())
            .col(ColumnDef::new(Projects::CreatedAt).big_integer().not_null())
            .col(ColumnDef::new(Projects::UpdatedAt).big_integer().not_null())
            .to_owned();
        manager.create_table(builder).await?;
        Ok(())
    }
}

#[derive(Iden)]
pub enum Projects {
    Table,
    ProjectId,
    Name,
    Description,
    SourceJson,
    LocationsJson,
    SessionDefaultsJson,
    ImageDigest,
    CreatedAt,
    UpdatedAt,
}
