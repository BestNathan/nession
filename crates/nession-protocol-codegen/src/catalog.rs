//! Which Rust types make up which contract.
//!
//! The one list this generator keeps by hand, and it is compile-checked: a
//! renamed type fails to build here by name. What it cannot catch on its own is
//! a contract *added* to a provider and not added here — so the catalog is
//! checked against the providers' own descriptors in
//! [`tests::every_advertised_contract_is_in_the_catalog`], which is the set a
//! runtime actually composes.

use ts_rs::TS;

/// One type a contract file carries.
pub struct Decl {
    /// The name the generated TypeScript uses — ts-rs's own identifier for the
    /// type, so a rename cannot leave this string behind.
    pub name: String,
    /// The declaration, including its `type X = ` wrapper.
    pub render: fn(&ts_rs::Config) -> String,
    /// Everything this type refers to, transitively. Used to prove the file is
    /// self-contained: a name that is referenced and not declared would be a
    /// TypeScript error at the consumer, and this says so at the source.
    pub deps: fn(&ts_rs::Config) -> Vec<ts_rs::Dependency>,
}

/// One Protocol Unit at one contract version.
pub struct Unit {
    /// The provider's directory name — `git`, `claude-code`.
    pub owner: &'static str,
    /// The canonical protocol id, `git.status`.
    pub id: &'static str,
    pub version: u32,
    /// The wire message type, `extension.git.status`.
    pub wire: &'static str,
    /// The declarations this unit's file carries, in emit order.
    pub decls: Vec<Decl>,
    /// The name the request alias takes, and the shape it aliases.
    pub request: (&'static str, fn(&ts_rs::Config) -> String),
    /// The same for the response.
    pub response: (&'static str, fn(&ts_rs::Config) -> String),
}

/// Describe one type for the catalog.
///
/// `name` comes from ts-rs rather than being written out here, so a type that
/// is renamed is reported by the compiler *and* the generated file follows
/// without an edit.
fn decl_of<T: TS + 'static>(cfg: &ts_rs::Config) -> Decl {
    Decl {
        name: T::ident(cfg),
        render: T::decl,
        deps: T::dependencies,
    }
}

/// Every contract this workspace serves, and the types each one carries.
pub fn units(cfg: &ts_rs::Config) -> Vec<Unit> {
    vec![
        Unit {
            owner: "git",
            id: "git.status",
            version: 1,
            wire: "extension.git.status",
            decls: vec![
                decl_of::<nession_git::protocol::status::v1::StatusRequestV1>(cfg),
                decl_of::<nession_git::protocol::status::v1::StatusOkV1>(cfg),
                decl_of::<nession_git::protocol::status::v1::RepoStatus>(cfg),
                decl_of::<nession_git::protocol::status::v1::ChangedFile>(cfg),
                decl_of::<nession_git::protocol::status::v1::ChangeKind>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: (
                "StatusRequest",
                nession_git::protocol::status::v1::StatusRequestV1::inline,
            ),
            response: (
                "StatusResponse",
                nession_git::protocol::status::v1::StatusResponseV1::inline,
            ),
        },
        Unit {
            owner: "git",
            id: "git.diff",
            version: 1,
            wire: "extension.git.diff",
            decls: vec![
                decl_of::<nession_git::protocol::diff::v1::DiffRequestV1>(cfg),
                decl_of::<nession_git::protocol::diff::v1::DiffOkV1>(cfg),
                decl_of::<nession_git::protocol::diff::v1::FileDiff>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: (
                "DiffRequest",
                nession_git::protocol::diff::v1::DiffRequestV1::inline,
            ),
            response: (
                "DiffResponse",
                nession_git::protocol::diff::v1::DiffResponseV1::inline,
            ),
        },
        Unit {
            owner: "git",
            id: "git.root",
            version: 1,
            wire: "extension.git.root",
            decls: vec![
                decl_of::<nession_git::protocol::root::v1::RootRequestV1>(cfg),
                decl_of::<nession_git::protocol::root::v1::RootOkV1>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: (
                "RootRequest",
                nession_git::protocol::root::v1::RootRequestV1::inline,
            ),
            response: (
                "RootResponse",
                nession_git::protocol::root::v1::RootResponseV1::inline,
            ),
        },
        Unit {
            owner: "git",
            id: "git.log",
            version: 1,
            wire: "extension.git.log",
            decls: vec![
                decl_of::<nession_git::protocol::log::v1::LogRequestV1>(cfg),
                decl_of::<nession_git::protocol::log::v1::LogOkV1>(cfg),
                decl_of::<nession_git::protocol::log::v1::History>(cfg),
                decl_of::<nession_git::protocol::log::v1::Commit>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: (
                "LogRequest",
                nession_git::protocol::log::v1::LogRequestV1::inline,
            ),
            response: (
                "LogResponse",
                nession_git::protocol::log::v1::LogResponseV1::inline,
            ),
        },
        Unit {
            owner: "git",
            id: "git.branches",
            version: 1,
            wire: "extension.git.branches",
            decls: vec![
                decl_of::<nession_git::protocol::branches::v1::BranchesRequestV1>(cfg),
                decl_of::<nession_git::protocol::branches::v1::BranchesOkV1>(cfg),
                decl_of::<nession_git::protocol::branches::v1::Branches>(cfg),
                decl_of::<nession_git::protocol::branches::v1::Branch>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: (
                "BranchesRequest",
                nession_git::protocol::branches::v1::BranchesRequestV1::inline,
            ),
            response: (
                "BranchesResponse",
                nession_git::protocol::branches::v1::BranchesResponseV1::inline,
            ),
        },
        Unit {
            owner: "git",
            id: "git.worktrees",
            version: 1,
            wire: "extension.git.worktrees",
            decls: vec![
                decl_of::<nession_git::protocol::worktrees::v1::WorktreesRequestV1>(cfg),
                decl_of::<nession_git::protocol::worktrees::v1::WorktreesOkV1>(cfg),
                decl_of::<nession_git::protocol::worktrees::v1::Worktrees>(cfg),
                decl_of::<nession_git::protocol::worktrees::v1::Worktree>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: (
                "WorktreesRequest",
                nession_git::protocol::worktrees::v1::WorktreesRequestV1::inline,
            ),
            response: (
                "WorktreesResponse",
                nession_git::protocol::worktrees::v1::WorktreesResponseV1::inline,
            ),
        },
        Unit {
            owner: "claude-code",
            id: "claude-code.list",
            version: 1,
            wire: "extension.claude_code.list",
            decls: vec![
                decl_of::<nession_claude_code::protocol::list::v1::ListRequestV1>(cfg),
                decl_of::<nession_claude_code::protocol::list::v1::ListResponseV1>(cfg),
                decl_of::<nession_claude_code::protocol::list::v1::ConfigCategory>(cfg),
                decl_of::<nession_claude_code::protocol::list::v1::ConfigFile>(cfg),
                // Declared by `claude-code.read` and used by both units, so it
                // appears in both files. Generated files duplicate rather than
                // import: a file that can be read on its own is worth more than
                // one saved declaration, and the copies cannot drift because
                // neither is written by hand.
                decl_of::<nession_claude_code::protocol::read::v1::Scope>(cfg),
            ],
            request: (
                "ListRequest",
                nession_claude_code::protocol::list::v1::ListRequestV1::inline,
            ),
            response: (
                "ListResponse",
                nession_claude_code::protocol::list::v1::ListResponseV1::inline,
            ),
        },
        Unit {
            owner: "claude-code",
            id: "claude-code.read",
            version: 1,
            wire: "extension.claude_code.read",
            decls: vec![
                decl_of::<nession_claude_code::protocol::read::v1::ReadRequestV1>(cfg),
                decl_of::<nession_claude_code::protocol::read::v1::ReadResponseV1>(cfg),
                decl_of::<nession_claude_code::protocol::read::v1::ReadOkV1>(cfg),
                decl_of::<nession_claude_code::protocol::read::v1::ReadFailureV1>(cfg),
                decl_of::<nession_claude_code::protocol::read::v1::Scope>(cfg),
            ],
            request: (
                "ReadRequest",
                nession_claude_code::protocol::read::v1::ReadRequestV1::inline,
            ),
            response: (
                "ReadResponse",
                nession_claude_code::protocol::read::v1::ReadResponseV1::inline,
            ),
        },
    ]
}
