//! Catalog repository names.

use anyhow::Result;
use sea_orm::ConnectionTrait;

use super::sqlite;

/// Maximum repository name length.
pub const MAX_REPOSITORY_NAME: usize = 255;
/// Maximum one repository path segment length.
pub const MAX_SEGMENT: usize = 63;

/// Validate a repository name such as `nession/base-runtime`.
///
/// A name is lowercase alphanumeric segments joined by `/`. `_`, `.` and `-`
/// may separate inner alphanumerics; leading/trailing separators, empty
/// segments and `..` are refused. The name is also the repository's stable
/// identity, so it cannot be renamed into a second row.
pub fn validate_repository_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > MAX_REPOSITORY_NAME {
        anyhow::bail!("repository name must be 1..={MAX_REPOSITORY_NAME} bytes");
    }
    for segment in name.split('/') {
        if segment.is_empty() {
            anyhow::bail!("repository name {name:?} contains an empty segment");
        }
        if segment.len() > MAX_SEGMENT {
            anyhow::bail!("repository segment {segment:?} exceeds {MAX_SEGMENT} bytes");
        }
        if segment == ".." || segment == "." {
            anyhow::bail!("repository name {name:?} must not contain a dot segment");
        }
        let mut characters = segment.chars();
        let Some(first) = characters.next() else {
            anyhow::bail!("repository name {name:?} contains an empty segment");
        };
        if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
            anyhow::bail!(
                "repository segment {segment:?} must start with a lowercase letter or digit"
            );
        }
        let last = segment.chars().last().unwrap_or(first);
        if !last.is_ascii_lowercase() && !last.is_ascii_digit() {
            anyhow::bail!(
                "repository segment {segment:?} must end with a lowercase letter or digit"
            );
        }
        for character in segment.chars() {
            if !(character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '_'
                || character == '.'
                || character == '-')
            {
                anyhow::bail!("repository segment {segment:?} contains an unsupported character");
            }
        }
    }
    Ok(())
}

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
