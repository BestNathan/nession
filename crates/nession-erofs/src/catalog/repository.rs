//! Catalog repository names.

use anyhow::Result;
use sea_orm::ConnectionTrait;

use super::sqlite;

/// The shared repository grammar is owned by the #4087 contracts so the
/// Server catalog and the Agent local projection validate identical names.
pub use crate::contracts::{validate_repository_name, MAX_REPOSITORY_NAME, MAX_SEGMENT};

/// Insert the repository row if this is its first use.
pub async fn ensure_repository(conn: &impl ConnectionTrait, name: &str, now: i64) -> Result<()> {
    validate_repository_name(name)?;
    sqlite::execute(
        conn,
        "INSERT INTO catalog_repositories (name, created_at) VALUES (?, ?) \
         ON CONFLICT (name) DO NOTHING",
        vec![name.into(), now.into()],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_names_are_strict_and_documented() {
        for valid in ["nession/base-runtime", "legacy", "team42/tools/go_1.22"] {
            validate_repository_name(valid).unwrap();
        }
        for invalid in [
            "",
            "Nession/base",
            "/leading",
            "trailing/",
            "double//slash",
            "../escape",
            "a/../b",
            "a b",
            &"x".repeat(MAX_SEGMENT + 1),
        ] {
            assert!(validate_repository_name(invalid).is_err(), "{invalid:?}");
        }
    }
}
