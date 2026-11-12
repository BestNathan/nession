//! Migration m008 — `session_managed_context` (#3062).
//!
//! The durable record of one Managed EROFS-backed Session creation: the
//! Project, the pinned Base Runtime/workspace/toolchain digests, the resolved
//! source commit and the truthful preparation status. It is Server-owned
//! metadata; the Agent owns the image bytes and the sandbox execution record.
//!
//! `attempt_id` fences concurrent attempts for one Session name: a losing
//! attempt may write `failed` only while its own attempt still owns the row,
//! so a late failure cannot overwrite the winner's `ready` disposition.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let builder = Table::create()
            .table(SessionManagedContext::Table)
            .if_not_exists()
            .col(
                ColumnDef::new(SessionManagedContext::SessionId)
                    .string()
                    .not_null()
                    .primary_key(),
            )
            .col(
                ColumnDef::new(SessionManagedContext::AgentId)
                    .string()
                    .not_null(),
            )
            .col(
                ColumnDef::new(SessionManagedContext::ProjectId)
                    .string()
                    .not_null(),
            )
            .col(
                ColumnDef::new(SessionManagedContext::AttemptId)
                    .string()
                    .not_null(),
            )
            .col(
                ColumnDef::new(SessionManagedContext::BaseDigest)
                    .string()
                    .not_null(),
            )
            .col(
                ColumnDef::new(SessionManagedContext::WorkspaceDigest)
                    .string()
                    .not_null(),
            )
            .col(
                ColumnDef::new(SessionManagedContext::ToolchainsJson)
                    .text()
                    .not_null()
                    .default("[]"),
            )
            .col(
                ColumnDef::new(SessionManagedContext::SourceSha)
                    .string()
                    .null(),
            )
            .col(
                ColumnDef::new(SessionManagedContext::Workspace)
                    .string()
                    .null(),
            )
            .col(
                ColumnDef::new(SessionManagedContext::Status)
                    .string()
                    .not_null(),
            )
            .col(ColumnDef::new(SessionManagedContext::Error).text().null())
            .col(
                ColumnDef::new(SessionManagedContext::UpdatedAt)
                    .big_integer()
                    .not_null(),
            )
            .to_owned();
        manager.create_table(builder).await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_session_managed_context_agent")
                    .table(SessionManagedContext::Table)
                    .col(SessionManagedContext::AgentId)
                    .to_owned(),
            )
            .await
            .unwrap_or(());
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SessionManagedContext::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
pub enum SessionManagedContext {
    Table,
    SessionId,
    AgentId,
    ProjectId,
    AttemptId,
    BaseDigest,
    WorkspaceDigest,
    ToolchainsJson,
    SourceSha,
    Workspace,
    Status,
    Error,
    UpdatedAt,
}
