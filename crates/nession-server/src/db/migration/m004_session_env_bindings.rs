//! Migration m004 — `session_env_bindings` table (#170 Phase A).
//!
//! Desired Session Environment Binding state is user intent; it must outlive a
//! Server restart even though the Agent owns the observed materialization. One
//! row per Session, replaced whole on every binding revision.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let builder = Table::create()
            .table(SessionEnvBindings::Table)
            .if_not_exists()
            .col(
                ColumnDef::new(SessionEnvBindings::SessionId)
                    .string()
                    .not_null()
                    .primary_key(),
            )
            .col(
                ColumnDef::new(SessionEnvBindings::AgentId)
                    .string()
                    .not_null(),
            )
            .col(
                ColumnDef::new(SessionEnvBindings::DesiredRevision)
                    .big_integer()
                    .not_null(),
            )
            .col(
                ColumnDef::new(SessionEnvBindings::ProfilesJson)
                    .text()
                    .not_null(),
            )
            .col(
                ColumnDef::new(SessionEnvBindings::UpdatedAt)
                    .big_integer()
                    .not_null(),
            )
            .to_owned();
        manager.create_table(builder).await?;
        Ok(())
    }
}

#[derive(Iden)]
pub enum SessionEnvBindings {
    Table,
    SessionId,
    AgentId,
    DesiredRevision,
    ProfilesJson,
    UpdatedAt,
}
