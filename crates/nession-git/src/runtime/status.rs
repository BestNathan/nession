//! Parse `git status --porcelain=v2 --branch -z`.
//!
//! Porcelain v2 is the stable, machine-readable form: v1's two-column format
//! changes meaning depending on whether the branch is unborn, and it cannot
//! express rename scores or unmerged stages at all. `-z` is not optional here —
//! paths are NUL-terminated rather than newline-terminated precisely because a
//! filename may contain a newline, and a parser that split on `\n` would
//! silently read such a file as two entries.
//!
//! Measured on git 2.4x: with `-z` the `# ` header lines are NUL-terminated as
//! well, so the whole output splits on one delimiter and the `2` (rename)
//! entries carry their original path as the *next* field.
//!
//! ## What this deliberately reports
//!
//! An in-progress rebase or merge leaves unmerged entries (`u`). They are
//! surfaced as their own list rather than folded into "modified", because
//! #750's edge-case table requires the state be shown as it is — a repository
//! paused mid-conflict must not read as a clean tree with a few edits.

use crate::protocol::status::v1::{ChangeKind, ChangedFile, RepoStatus};

impl ChangeKind {
    fn from_code(code: char) -> Self {
        match code {
            'M' => Self::Modified,
            'A' => Self::Added,
            'D' => Self::Deleted,
            'R' => Self::Renamed,
            'C' => Self::Copied,
            'T' => Self::TypeChanged,
            'U' => Self::Unmerged,
            _ => Self::Unknown,
        }
    }
}

impl RepoStatus {
    /// A clean tree with no untracked or unmerged paths.
    ///
    /// The view stays quiet on this (#750 C5): a clean repository is a healthy
    /// state, not an achievement, so nothing is coloured or badged for it.
    pub fn is_clean(&self) -> bool {
        self.modified.is_empty() && self.untracked.is_empty() && self.unmerged.is_empty()
    }

    /// Total changed paths, for the Signal projection's "N changed".
    pub fn changed_count(&self) -> usize {
        self.modified.len() + self.untracked.len() + self.unmerged.len()
    }
}

/// Parse porcelain v2 `--branch -z` output.
///
/// Returns `Err` only on framing that cannot be a status stream; individual
/// records with an unrecognised type are skipped rather than failing the whole
/// call, so a future git adding a record type degrades to "one path missing"
/// instead of "the Git panel is broken".
pub fn parse(bytes: &[u8]) -> anyhow::Result<RepoStatus> {
    let text = String::from_utf8_lossy(bytes);
    let fields: Vec<&str> = text.split('\0').filter(|f| !f.is_empty()).collect();

    let mut status = RepoStatus {
        branch: None,
        detached: false,
        upstream: None,
        ahead: 0,
        behind: 0,
        modified: Vec::new(),
        untracked: Vec::new(),
        unmerged: Vec::new(),
    };

    let mut i = 0;
    while i < fields.len() {
        // `get` rather than `fields[i]`: the loop condition already proves the
        // index is in range, but stating it as a lookup keeps the parser free
        // of a panic path that only a future edit could reach.
        let Some(record) = fields.get(i).copied() else {
            break;
        };
        i += 1;

        if let Some(header) = record.strip_prefix("# ") {
            apply_header(&mut status, header);
            continue;
        }

        match record.as_bytes().first() {
            Some(b'1') => {
                if let Some(file) = parse_ordinary(record) {
                    status.modified.push(file);
                }
            }
            Some(b'2') => {
                // With -z the original path is the *next* field.
                let original = fields.get(i).map(|s| (*s).to_string());
                if record.contains(' ') && original.is_some() {
                    i += 1;
                }
                if let Some(mut file) = parse_ordinary(record) {
                    file.original_path = original;
                    status.modified.push(file);
                }
            }
            Some(b'u') => {
                if let Some(file) = parse_unmerged(record) {
                    status.modified.push(file.clone());
                    status.unmerged.push(file.path);
                }
            }
            Some(b'?') => {
                if let Some(path) = record.strip_prefix("? ") {
                    status.untracked.push(path.to_string());
                }
            }
            // `!` is ignored-only output, which we never ask for, and anything
            // else is a record type this version does not know.
            _ => {}
        }
    }

    Ok(status)
}

fn apply_header(status: &mut RepoStatus, header: &str) {
    if let Some(rest) = header.strip_prefix("branch.head ") {
        // `(detached)` is what porcelain reports instead of a branch name.
        if rest == "(detached)" {
            status.detached = true;
        } else {
            status.branch = Some(rest.to_string());
        }
    } else if let Some(rest) = header.strip_prefix("branch.upstream ") {
        status.upstream = Some(rest.to_string());
    } else if let Some(rest) = header.strip_prefix("branch.ab ") {
        // `+<ahead> -<behind>`
        let mut parts = rest.split_whitespace();
        if let Some(ahead) = parts.next().and_then(|p| p.strip_prefix('+')) {
            status.ahead = ahead.parse().unwrap_or(0);
        }
        if let Some(behind) = parts.next().and_then(|p| p.strip_prefix('-')) {
            status.behind = behind.parse().unwrap_or(0);
        }
    }
}

/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`, and `2 … <X><score> <path>`
/// for renames — the same shape with one extra field before the path.
fn parse_ordinary(record: &str) -> Option<ChangedFile> {
    let fields: Vec<&str> = record.splitn(10, ' ').collect();
    let xy = fields.get(1)?;
    let path = fields.last()?;
    if *path == record {
        return None;
    }
    Some(file_from_xy(xy, path))
}

/// `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
fn parse_unmerged(record: &str) -> Option<ChangedFile> {
    let fields: Vec<&str> = record.splitn(11, ' ').collect();
    let path = fields.last()?;
    if *path == record {
        return None;
    }
    Some(ChangedFile {
        path: path.to_string(),
        original_path: None,
        kind: ChangeKind::Unmerged,
        // An unmerged path is neither simply staged nor simply unstaged; the
        // view shows it in its own group, so both flags stay clear.
        staged: false,
        unstaged: false,
    })
}

fn file_from_xy(xy: &str, path: &str) -> ChangedFile {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');

    // In the index/worktree columns, `.` means unmodified. `?` appears only in
    // the untracked records, which do not come through here.
    let staged = x != '.' && x != '?';
    let unstaged = y != '.' && y != '?';

    let kind = if x != '.' && x != '?' {
        ChangeKind::from_code(x)
    } else {
        ChangeKind::from_code(y)
    };

    ChangedFile {
        path: path.to_string(),
        original_path: None,
        kind,
        staged,
        unstaged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// NUL-joined, matching what `--porcelain=v2 --branch -z` actually emits.
    fn stream(parts: &[&str]) -> Vec<u8> {
        let mut s = parts.join("\0");
        s.push('\0');
        s.into_bytes()
    }

    #[test]
    fn reads_branch_upstream_and_tracking() {
        let out = parse(&stream(&[
            "# branch.oid 8c02b755c8fe7774411321833c56043e40e062ff",
            "# branch.head feature/x",
            "# branch.upstream origin/main",
            "# branch.ab +2 -3",
        ]))
        .unwrap();

        assert_eq!(out.branch.as_deref(), Some("feature/x"));
        assert_eq!(out.upstream.as_deref(), Some("origin/main"));
        assert_eq!(out.ahead, 2);
        assert_eq!(out.behind, 3);
        assert!(!out.detached);
        assert!(out.is_clean());
    }

    #[test]
    fn detached_head_has_no_branch_name() {
        let out = parse(&stream(&["# branch.head (detached)"])).unwrap();
        assert!(out.detached);
        assert_eq!(out.branch, None);
    }

    #[test]
    fn groups_modified_and_untracked_separately() {
        let out = parse(&stream(&[
            "# branch.head main",
            "1 M. N... 100644 100644 100644 aaa bbb src/tracked.rs",
            "? src/new-file.rs",
            "? notes.md",
        ]))
        .unwrap();

        assert_eq!(out.modified.len(), 1);
        assert_eq!(out.modified[0].path, "src/tracked.rs");
        assert_eq!(out.modified[0].kind, ChangeKind::Modified);
        assert!(out.modified[0].staged);
        assert!(!out.modified[0].unstaged);

        assert_eq!(out.untracked, vec!["src/new-file.rs", "notes.md"]);
        assert_eq!(out.changed_count(), 3);
        assert!(!out.is_clean());
    }

    #[test]
    fn worktree_only_change_is_unstaged() {
        let out = parse(&stream(&[
            "# branch.head main",
            "1 .M N... 100644 100644 100644 aaa bbb src/a.rs",
        ]))
        .unwrap();
        assert!(!out.modified[0].staged);
        assert!(out.modified[0].unstaged);
    }

    #[test]
    fn rename_consumes_the_following_original_path_field() {
        // The `2` record's original path is a separate NUL-terminated field;
        // failing to consume it would read it as a bogus next record.
        let out = parse(&stream(&[
            "# branch.head main",
            "2 R. N... 100644 100644 100644 aaa bbb R100 src/new-name.rs",
            "src/old-name.rs",
            "? after.rs",
        ]))
        .unwrap();

        assert_eq!(out.modified.len(), 1);
        assert_eq!(out.modified[0].path, "src/new-name.rs");
        assert_eq!(
            out.modified[0].original_path.as_deref(),
            Some("src/old-name.rs")
        );
        assert_eq!(out.modified[0].kind, ChangeKind::Renamed);
        // The original path must NOT have been read as another entry.
        assert_eq!(out.untracked, vec!["after.rs"]);
    }

    #[test]
    fn unmerged_paths_are_surfaced_not_folded_into_modified() {
        let out = parse(&stream(&[
            "# branch.head main",
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.rs",
        ]))
        .unwrap();

        assert_eq!(out.unmerged, vec!["src/conflict.rs"]);
        assert_eq!(out.modified[0].kind, ChangeKind::Unmerged);
        assert!(!out.is_clean(), "a conflicted tree is not clean");
    }

    #[test]
    fn a_path_containing_a_newline_stays_one_entry() {
        // The reason -z exists. A newline-splitting parser reads this as two.
        let out = parse(&stream(&["# branch.head main", "? odd\nname.rs"])).unwrap();
        assert_eq!(out.untracked, vec!["odd\nname.rs"]);
    }

    #[test]
    fn unknown_record_types_are_skipped_not_fatal() {
        let out = parse(&stream(&[
            "# branch.head main",
            "X something this-version-does-not-know",
            "? real.rs",
        ]))
        .unwrap();
        assert_eq!(out.untracked, vec!["real.rs"]);
    }

    #[test]
    fn empty_output_is_a_clean_repo_with_no_branch() {
        let out = parse(b"").unwrap();
        assert!(out.is_clean());
        assert_eq!(out.branch, None);
        assert_eq!(out.ahead, 0);
    }

    #[test]
    fn a_renamed_file_serialises_in_the_spelling_the_client_reads() {
        // The wire is camelCase — hand-written `truncatedBytes` beside it says
        // so — and `original_path` was the one field that was not, because it is
        // the one multi-word field on this struct. A rename's tooltip read
        // `undefined -> new-name` and nothing failed: no fixture carried a
        // rename across the wire, and the client's own tests use its own
        // spelling, so both sides agreed with themselves.
        let file = ChangedFile {
            path: "src/new.rs".to_string(),
            original_path: Some("src/old.rs".to_string()),
            kind: ChangeKind::Renamed,
            staged: true,
            unstaged: false,
        };

        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(json["originalPath"], "src/old.rs");
        assert!(
            json.get("original_path").is_none(),
            "the snake_case key must not be on the wire at all, got: {json}"
        );
    }

    #[test]
    fn an_absent_original_path_is_omitted_rather_than_null() {
        // `skip_serializing_if` and the case rule have to agree; a `null` here
        // would read as "renamed from nothing".
        let file = ChangedFile {
            path: "src/a.rs".to_string(),
            original_path: None,
            kind: ChangeKind::Modified,
            staged: false,
            unstaged: true,
        };

        let json = serde_json::to_value(&file).unwrap();
        assert!(json.get("originalPath").is_none());
        assert!(json.get("original_path").is_none());
    }
}
