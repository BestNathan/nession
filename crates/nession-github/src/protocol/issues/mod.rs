//! `github.issues` — bounded Issue summaries and their filters.

pub mod v1;

pub use v1::{descriptor, GithubIssueSummaryV1, IssueStateFilterV1, IssuesOkV1, IssuesRequestV1};

pub const ID: &str = "github.issues";
