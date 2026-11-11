//! `github.issue-detail` — one Issue, fetched lazily by number.

pub mod v1;

pub use v1::{descriptor, GithubIssueDetailV1, IssueDetailOkV1, IssueDetailRequestV1};

pub const ID: &str = "github.issue-detail";
