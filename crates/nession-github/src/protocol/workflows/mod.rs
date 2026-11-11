//! `github.workflows` — bounded workflows and their latest run, scoped either
//! repository-wide or to the current branch.

pub mod v1;

pub use v1::{
    descriptor, GithubWorkflowV1, RunScopeV1, WorkflowRunStatusV1, WorkflowRunV1, WorkflowStateV1,
    WorkflowsOkV1, WorkflowsRequestV1,
};

pub const ID: &str = "github.workflows";
