//! `github.pull-requests` — bounded PR summaries and the exact current-branch
//! relation.

pub mod v1;

pub use v1::{
    descriptor, BranchRelationV1, GithubBaseRefV1, GithubHeadRefV1, GithubPullRequestSummaryV1,
    PullRequestStateFilterV1, PullRequestsOkV1, PullRequestsRequestV1,
};

pub const ID: &str = "github.pull-requests";
