//! One commit's metadata and changed-file summary.

use anyhow::Context;

use crate::protocol::commit::v1::{ChangedFileEntry, CommitDetail};
use crate::runtime::cmd::GitCmd;
use crate::runtime::security::{
    validate_object_name, MAX_COMMIT_FILES, MAX_COMMIT_FILES_BYTES, MAX_COMMIT_MESSAGE_BYTES,
    MAX_LINE_BYTES,
};

const MERGE_DIFF_PARENT: &str = "first_parent";

const SHOW_FORMAT: &str = "--format=%H\x1f%h\x1f%P\x1f%an\x1f%aI\x1f%cn\x1f%ci\x1f%s\x1f%D\x1e";

/// Load commit detail for a validated revision.
pub async fn commit_detail(cmd: &GitCmd, oid: &str) -> anyhow::Result<CommitDetail> {
    let oid = validate_object_name(oid)?;
    let full = resolve_commit(cmd, &oid).await?;
    let show = cmd
        .run(
            &["show", "--no-color", "-s", SHOW_FORMAT, &full],
            MAX_LINE_BYTES,
        )
        .await?;
    let body_out = cmd
        .run(
            &["show", "--no-color", "-s", "--format=%B", &full],
            MAX_COMMIT_MESSAGE_BYTES,
        )
        .await?;
    let parsed = parse_show(
        &show.stdout_string(),
        &body_out.stdout_string(),
        body_out.truncated_bytes,
        body_out.truncated(),
    )?;

    let tree_out = cmd
        .run(
            &[
                "diff-tree",
                "--no-color",
                "-M",
                "--name-status",
                "-r",
                &full,
            ],
            MAX_COMMIT_FILES_BYTES,
        )
        .await?;
    let (files, files_truncated, files_truncated_bytes) = parse_name_status(
        &tree_out.stdout_string(),
        tree_out.truncated_bytes,
        tree_out.truncated(),
    );

    Ok(CommitDetail {
        oid: parsed.oid,
        short_oid: parsed.short_oid,
        parents: parsed.parents,
        author: parsed.author,
        author_date: parsed.author_date,
        committer: parsed.committer,
        commit_date: parsed.commit_date,
        subject: parsed.subject,
        body: parsed.body,
        decorations: parsed.decorations,
        files,
        files_truncated,
        files_truncated_bytes,
        message_truncated: parsed.message_truncated,
        message_truncated_bytes: parsed.message_truncated_bytes,
        merge_diff_parent: MERGE_DIFF_PARENT.to_string(),
    })
}

async fn resolve_commit(cmd: &GitCmd, oid: &str) -> anyhow::Result<String> {
    let out = cmd
        .run(
            &["rev-parse", "--verify", &format!("{oid}^{{commit}}")],
            MAX_LINE_BYTES,
        )
        .await?;
    let hash = out.stdout_string().trim().to_string();
    if hash.is_empty() {
        anyhow::bail!("revision not found");
    }
    Ok(hash)
}

struct ParsedShow {
    oid: String,
    short_oid: String,
    parents: Vec<String>,
    author: String,
    author_date: String,
    committer: String,
    commit_date: String,
    subject: String,
    body: String,
    decorations: String,
    message_truncated: bool,
    message_truncated_bytes: usize,
}

fn parse_show(
    raw: &str,
    body_raw: &str,
    truncated_bytes: usize,
    truncated: bool,
) -> anyhow::Result<ParsedShow> {
    const FIELD_SEP: char = '\u{1f}';
    const RECORD_SEP: char = '\u{1e}';
    let record = raw.split(RECORD_SEP).next().unwrap_or("").trim();
    let mut fields = record.split(FIELD_SEP);
    let oid = fields.next().context("missing oid")?.to_string();
    let short_oid = fields.next().context("missing short oid")?.to_string();
    let parents_raw = fields.next().unwrap_or("");
    let parents: Vec<String> = parents_raw
        .split_whitespace()
        .filter(|p| !p.is_empty())
        .map(std::string::ToString::to_string)
        .collect();
    let author = fields.next().context("missing author")?.to_string();
    let author_date = fields.next().context("missing author date")?.to_string();
    let committer = fields.next().context("missing committer")?.to_string();
    let commit_date = fields.next().context("missing commit date")?.to_string();
    let subject = fields.next().context("missing subject")?.to_string();
    let decorations = fields.next().unwrap_or("").trim().to_string();
    let body = body_raw.trim_end().to_string();

    Ok(ParsedShow {
        oid,
        short_oid,
        parents,
        author,
        author_date,
        committer,
        commit_date,
        subject,
        body,
        decorations,
        message_truncated: truncated,
        message_truncated_bytes: truncated_bytes,
    })
}

fn parse_name_status(
    raw: &str,
    truncated_bytes: usize,
    truncated: bool,
) -> (Vec<ChangedFileEntry>, bool, usize) {
    let mut files = Vec::new();
    for line in raw.lines() {
        if files.len() >= MAX_COMMIT_FILES {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let status = parts.next().unwrap_or("").to_string();
        if status.is_empty() {
            continue;
        }
        let code = status.chars().next().unwrap_or('M').to_string();
        let path = parts.next().unwrap_or("").to_string();
        let new_path = parts.next().map(std::string::ToString::to_string);
        if path.is_empty() {
            continue;
        }
        let binary = status.contains('B');
        files.push(ChangedFileEntry {
            path,
            new_path,
            status: code,
            binary,
        });
    }
    (files, truncated, truncated_bytes)
}

/// Resolve a revision for diff/history; maps missing objects to a clear error.
pub async fn resolve_revision(cmd: &GitCmd, oid: &str) -> anyhow::Result<String> {
    let oid = validate_object_name(oid)?;
    resolve_commit(cmd, &oid).await
}

/// Parent to diff against for a commit patch (first parent, or empty tree for root).
pub async fn diff_parent(cmd: &GitCmd, full_commit: &str) -> anyhow::Result<String> {
    let out = cmd
        .run(
            &["rev-parse", "--verify", &format!("{full_commit}^@")],
            MAX_LINE_BYTES,
        )
        .await;
    if let Ok(parents_out) = out {
        let parents = parents_out.stdout_string().into_owned();
        let first = parents.lines().next().unwrap_or("").trim();
        if !first.is_empty() {
            return Ok(first.to_string());
        }
    }
    // Root commit: diff against the empty tree.
    Ok("4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_status_rows() {
        let raw = "M\tsrc/a.rs\nA\tnew.txt\nR100\told\tnew\n";
        let (files, truncated, _) = parse_name_status(raw, 0, false);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "M");
        assert_eq!(files[2].new_path.as_deref(), Some("new"));
        assert!(!truncated);
    }
}
