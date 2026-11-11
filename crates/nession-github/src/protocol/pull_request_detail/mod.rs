//! `github.pull-request-detail` — one PR, fetched lazily by number.

pub mod v1;

pub use v1::{
    descriptor, GithubPullRequestDetailV1, PullRequestDetailOkV1, PullRequestDetailRequestV1,
};

pub const ID: &str = "github.pull-request-detail";
