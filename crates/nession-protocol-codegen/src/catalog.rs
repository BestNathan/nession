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
    /// The wire message types this contract travels as.
    ///
    /// A list rather than one string because a unit can be served on more than
    /// one transport, and `#678` is explicit that the unit is the semantic
    /// boundary while the wire is a projection of it. `session.create` is the
    /// case that forced this: the server answers it for a browser on
    /// `server.session.create` and the agent answers it for the server on
    /// `session.create`, and those are one unit seen from two sides. A single
    /// field would have had to pick one and quietly drop the other.
    pub wires: &'static [&'static str],
    /// The declarations this unit's file carries, in emit order.
    pub decls: Vec<Decl>,
    /// The name the request alias takes, and the shape it aliases.
    ///
    /// Optional, because not every unit has both halves. `agent.heartbeat` is
    /// sent and acknowledged but the acknowledgement is a different unit's
    /// shape; `agent.terminal-resize` and `session.relay.begin` are events with
    /// no request at all. Requiring both would have meant inventing a type for
    /// the missing half to satisfy the catalog, which is the opposite of what a
    /// catalog is for — and excluding those units would have put the "two lists
    /// that drift" problem back, which is the thing this file exists to avoid.
    pub request: Option<Alias>,
    /// The same for the response.
    pub response: Option<Alias>,
}

/// One half of a unit's operation surface: the name its alias takes, and the
/// shape the alias stands for.
///
/// A named type rather than the pair written out twice. `Option<(&str, fn(…))>`
/// is over clippy's `type_complexity` threshold, and the way out of that is to
/// name the thing rather than to silence the lint — the two halves are one
/// concept, and both fields were already saying so in their doc comments.
pub type Alias = (&'static str, fn(&ts_rs::Config) -> String);

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
            wires: &["git.status"],
            decls: vec![
                decl_of::<nession_git::protocol::status::v1::StatusRequestV1>(cfg),
                decl_of::<nession_git::protocol::status::v1::StatusOkV1>(cfg),
                decl_of::<nession_git::protocol::status::v1::RepoStatus>(cfg),
                decl_of::<nession_git::protocol::status::v1::ChangedFile>(cfg),
                decl_of::<nession_git::protocol::status::v1::ChangeKind>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: Some((
                "StatusRequest",
                nession_git::protocol::status::v1::StatusRequestV1::inline,
            )),
            response: Some((
                "StatusResponse",
                nession_git::protocol::status::v1::StatusResponseV1::inline,
            )),
        },
        Unit {
            owner: "git",
            id: "git.diff",
            version: 1,
            wires: &["git.diff"],
            decls: vec![
                decl_of::<nession_git::protocol::diff::v1::DiffRequestV1>(cfg),
                decl_of::<nession_git::protocol::diff::v1::DiffOkV1>(cfg),
                decl_of::<nession_git::protocol::diff::v1::FileDiff>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: Some((
                "DiffRequest",
                nession_git::protocol::diff::v1::DiffRequestV1::inline,
            )),
            response: Some((
                "DiffResponse",
                nession_git::protocol::diff::v1::DiffResponseV1::inline,
            )),
        },
        Unit {
            owner: "git",
            id: "git.root",
            version: 1,
            wires: &["git.root"],
            decls: vec![
                decl_of::<nession_git::protocol::root::v1::RootRequestV1>(cfg),
                decl_of::<nession_git::protocol::root::v1::RootOkV1>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: Some((
                "RootRequest",
                nession_git::protocol::root::v1::RootRequestV1::inline,
            )),
            response: Some((
                "RootResponse",
                nession_git::protocol::root::v1::RootResponseV1::inline,
            )),
        },
        Unit {
            owner: "git",
            id: "git.log",
            version: 1,
            wires: &["git.log"],
            decls: vec![
                decl_of::<nession_git::protocol::log::v1::LogRequestV1>(cfg),
                decl_of::<nession_git::protocol::log::v1::LogOkV1>(cfg),
                decl_of::<nession_git::protocol::log::v1::History>(cfg),
                decl_of::<nession_git::protocol::log::v1::Commit>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: Some((
                "LogRequest",
                nession_git::protocol::log::v1::LogRequestV1::inline,
            )),
            response: Some((
                "LogResponse",
                nession_git::protocol::log::v1::LogResponseV1::inline,
            )),
        },
        Unit {
            owner: "git",
            id: "git.branches",
            version: 1,
            wires: &["git.branches"],
            decls: vec![
                decl_of::<nession_git::protocol::branches::v1::BranchesRequestV1>(cfg),
                decl_of::<nession_git::protocol::branches::v1::BranchesOkV1>(cfg),
                decl_of::<nession_git::protocol::branches::v1::Branches>(cfg),
                decl_of::<nession_git::protocol::branches::v1::Branch>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: Some((
                "BranchesRequest",
                nession_git::protocol::branches::v1::BranchesRequestV1::inline,
            )),
            response: Some((
                "BranchesResponse",
                nession_git::protocol::branches::v1::BranchesResponseV1::inline,
            )),
        },
        Unit {
            owner: "git",
            id: "git.worktrees",
            version: 1,
            wires: &["git.worktrees"],
            decls: vec![
                decl_of::<nession_git::protocol::worktrees::v1::WorktreesRequestV1>(cfg),
                decl_of::<nession_git::protocol::worktrees::v1::WorktreesOkV1>(cfg),
                decl_of::<nession_git::protocol::worktrees::v1::Worktrees>(cfg),
                decl_of::<nession_git::protocol::worktrees::v1::Worktree>(cfg),
                decl_of::<nession_git::protocol::SessionTargetV1>(cfg),
            ],
            request: Some((
                "WorktreesRequest",
                nession_git::protocol::worktrees::v1::WorktreesRequestV1::inline,
            )),
            response: Some((
                "WorktreesResponse",
                nession_git::protocol::worktrees::v1::WorktreesResponseV1::inline,
            )),
        },
        Unit {
            owner: "claude-code",
            id: "claude-code.list",
            version: 1,
            wires: &["claude-code.list"],
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
            request: Some((
                "ListRequest",
                nession_claude_code::protocol::list::v1::ListRequestV1::inline,
            )),
            response: Some((
                "ListResponse",
                nession_claude_code::protocol::list::v1::ListResponseV1::inline,
            )),
        },
        Unit {
            owner: "claude-code",
            id: "claude-code.read",
            version: 1,
            wires: &["claude-code.read"],
            decls: vec![
                decl_of::<nession_claude_code::protocol::read::v1::ReadRequestV1>(cfg),
                decl_of::<nession_claude_code::protocol::read::v1::ReadResponseV1>(cfg),
                decl_of::<nession_claude_code::protocol::read::v1::ReadOkV1>(cfg),
                decl_of::<nession_claude_code::protocol::read::v1::ReadFailureV1>(cfg),
                decl_of::<nession_claude_code::protocol::read::v1::Scope>(cfg),
            ],
            request: Some((
                "ReadRequest",
                nession_claude_code::protocol::read::v1::ReadRequestV1::inline,
            )),
            response: Some((
                "ReadResponse",
                nession_claude_code::protocol::read::v1::ReadResponseV1::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.register",
            version: 1,
            wires: &["agent.register"],
            decls: vec![
                decl_of::<nession_protocol::contracts::agent::v1::AgentRegisterPayload>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentRegisterResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentAddress>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentMetadata>(cfg),
                decl_of::<nession_protocol::ProtocolManifest>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::NetworkType>(cfg),
                decl_of::<nession_protocol::ContractSupport>(cfg),
                decl_of::<nession_protocol::ProtocolId>(cfg),
                decl_of::<nession_protocol::ContractVersion>(cfg),
            ],
            request: Some((
                "AgentRegisterCall",
                nession_protocol::contracts::agent::v1::AgentRegisterPayload::inline,
            )),
            response: Some((
                "AgentRegisterReply",
                nession_protocol::contracts::agent::v1::AgentRegisterResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.heartbeat",
            version: 1,
            wires: &["agent.heartbeat"],
            decls: vec![
                decl_of::<nession_protocol::contracts::agent::v1::AgentHeartbeatPayload>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentStatus>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::HeartbeatMetadata>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentMetadata>(cfg),
            ],
            request: Some((
                "AgentHeartbeatCall",
                nession_protocol::contracts::agent::v1::AgentHeartbeatPayload::inline,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.session-update",
            version: 1,
            wires: &["agent.session.update"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.command-response",
            version: 1,
            wires: &["agent.session.command.response"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::AgentCommandResponsePayload>(cfg),
            ],
            request: Some((
                "AgentCommandResponseCall",
                nession_protocol::contracts::session::v1::AgentCommandResponsePayload::inline,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.terminal-resize",
            version: 1,
            wires: &["agent.terminal.resize"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::AgentTerminalResizePayload>(cfg),
            ],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.address-update",
            version: 1,
            wires: &["agent.address_update"],
            decls: vec![
                decl_of::<nession_protocol::contracts::agent::v1::AgentAddressUpdatePayload>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentAddress>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::NetworkType>(cfg),
            ],
            request: Some((
                "AgentAddressUpdateCall",
                nession_protocol::contracts::agent::v1::AgentAddressUpdatePayload::inline,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.list",
            version: 1,
            wires: &["client.agents.list"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.rename",
            version: 1,
            wires: &["client.agent.rename"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.delete",
            version: 1,
            wires: &["client.agent.delete"],
            decls: vec![
                decl_of::<nession_protocol::contracts::agent::v1::ClientAgentDeletePayload>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::ClientAgentDeleteResponsePayload>(cfg),
            ],
            request: Some((
                "AgentDeleteCall",
                nession_protocol::contracts::agent::v1::ClientAgentDeletePayload::inline,
            )),
            response: Some((
                "AgentDeleteReply",
                nession_protocol::contracts::agent::v1::ClientAgentDeleteResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "client.auth",
            version: 1,
            wires: &["client.auth"],
            decls: vec![
                decl_of::<nession_protocol::contracts::client::v1::ClientAuthPayload>(cfg),
                decl_of::<nession_protocol::contracts::client::v1::AuthResponsePayload>(cfg),
            ],
            request: Some((
                "ClientAuthCall",
                nession_protocol::contracts::client::v1::ClientAuthPayload::inline,
            )),
            response: Some((
                "ClientAuthReply",
                nession_protocol::contracts::client::v1::AuthResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "client.attach",
            version: 1,
            wires: &["client.attach"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientAttachPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientAttachResponse>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSnapshot>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "ClientAttachCall",
                nession_protocol::contracts::session::v1::ClientAttachPayload::inline,
            )),
            response: Some((
                "ClientAttachReply",
                nession_protocol::contracts::session::v1::ClientAttachResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "client.detach",
            version: 1,
            wires: &["client.detach"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientDetachPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientDetachResponse>(cfg),
            ],
            request: Some((
                "ClientDetachCall",
                nession_protocol::contracts::session::v1::ClientDetachPayload::inline,
            )),
            response: Some((
                "ClientDetachReply",
                nession_protocol::contracts::session::v1::ClientDetachResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "client.agents.list",
            version: 1,
            wires: &["client.agents.list"],
            decls: vec![
                decl_of::<nession_protocol::contracts::agent::v1::WebAgentsListResponse>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::WebAgentInfo>(cfg),
            ],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "client.sessions.list",
            version: 1,
            wires: &["client.sessions.list"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::WebSessionsListResponse>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::WebSessionInfo>(cfg),
            ],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "client.session.attach",
            version: 1,
            wires: &["client.session.attach"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::WebSessionAttachPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::WebAttachInfo>(cfg),
            ],
            request: Some((
                "ClientSessionAttachCall",
                nession_protocol::contracts::session::v1::WebSessionAttachPayload::inline,
            )),
            response: Some((
                "ClientSessionAttachReply",
                nession_protocol::contracts::session::v1::WebAttachInfo::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "client.session.create",
            version: 1,
            wires: &["client.session.create"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::WebSessionCreatePayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::WebSessionCreateResponse>(cfg),
            ],
            request: Some((
                "ClientSessionCreateCall",
                nession_protocol::contracts::session::v1::WebSessionCreatePayload::inline,
            )),
            response: Some((
                "ClientSessionCreateReply",
                nession_protocol::contracts::session::v1::WebSessionCreateResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "client.session.kill",
            version: 1,
            wires: &["client.session.kill"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::WebSessionKillPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::WebSessionKillResponse>(cfg),
            ],
            request: Some((
                "ClientSessionKillCall",
                nession_protocol::contracts::session::v1::WebSessionKillPayload::inline,
            )),
            response: Some((
                "ClientSessionKillReply",
                nession_protocol::contracts::session::v1::WebSessionKillResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "session.list",
            version: 1,
            wires: &["client.sessions.list", "server.sessions.list", "session.list"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::SessionListResponse>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionInfo>(cfg),
            ],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "session.create",
            version: 1,
            wires: &["client.session.create", "server.session.create", "session.create"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::SessionCreatePayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionCreateResponse>(cfg),
            ],
            request: Some((
                "SessionCreateCall",
                nession_protocol::contracts::session::v1::SessionCreatePayload::inline,
            )),
            response: Some((
                "SessionCreateReply",
                nession_protocol::contracts::session::v1::SessionCreateResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "session.kill",
            version: 1,
            wires: &["client.session.kill", "server.session.kill", "session.kill"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::SessionKillPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionKillResponse>(cfg),
            ],
            request: Some((
                "SessionKillCall",
                nession_protocol::contracts::session::v1::SessionKillPayload::inline,
            )),
            response: Some((
                "SessionKillReply",
                nession_protocol::contracts::session::v1::SessionKillResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "session.attach",
            version: 1,
            wires: &["client.session.attach"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionAttachPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionAttachResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSnapshot>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::ProbedAddress>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AddressStatus>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::NetworkType>(cfg),
            ],
            request: Some((
                "SessionAttachCall",
                nession_protocol::contracts::session::v1::ClientSessionAttachPayload::inline,
            )),
            response: Some((
                "SessionAttachReply",
                nession_protocol::contracts::session::v1::ClientSessionAttachResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "session.capture-preview",
            version: 1,
            wires: &["client.session.capture_preview", "session.capture_preview"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::SessionCapturePreviewPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionCapturePreviewResponse>(cfg),
            ],
            request: Some((
                "SessionCapturePreviewCall",
                nession_protocol::contracts::session::v1::SessionCapturePreviewPayload::inline,
            )),
            response: Some((
                "SessionCapturePreviewReply",
                nession_protocol::contracts::session::v1::SessionCapturePreviewResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "session.relay.begin",
            version: 1,
            wires: &["client.session.relay.begin"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "session.relay.end",
            version: 1,
            wires: &["client.session.relay.end"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "session.env.apply",
            version: 1,
            wires: &["client.session.env.apply", "server.session.env.apply"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvApplyPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvFileRef>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "SessionEnvApplyCall",
                nession_protocol::contracts::session::v1::ClientSessionEnvApplyPayload::inline,
            )),
            response: Some((
                "SessionEnvApplyReply",
                nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "session.env.unset",
            version: 1,
            wires: &["client.session.env.unset", "server.session.env.unset"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvUnsetPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvFileRef>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "SessionEnvUnsetCall",
                nession_protocol::contracts::session::v1::ClientSessionEnvUnsetPayload::inline,
            )),
            response: Some((
                "SessionEnvUnsetReply",
                nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "session.env.active",
            version: 1,
            wires: &["client.session.env.active"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ActiveEnvFile>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "session.env.query",
            version: 1,
            wires: &["client.session.env.query"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "env.list",
            version: 1,
            wires: &["client.env.list", "server.env.list"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvListPayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvListResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvFileInfo>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "EnvListCall",
                nession_protocol::contracts::env::v1::ClientEnvListPayload::inline,
            )),
            response: Some((
                "EnvListReply",
                nession_protocol::contracts::env::v1::ClientEnvListResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "env.get",
            version: 1,
            wires: &["client.env.get", "server.env.get"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvGetPayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvGetResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "EnvGetCall",
                nession_protocol::contracts::env::v1::ClientEnvGetPayload::inline,
            )),
            response: Some((
                "EnvGetReply",
                nession_protocol::contracts::env::v1::ClientEnvGetResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "env.write",
            version: 1,
            wires: &["client.env.write", "server.env.write"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvWritePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvWriteResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "EnvWriteCall",
                nession_protocol::contracts::env::v1::ClientEnvWritePayload::inline,
            )),
            response: Some((
                "EnvWriteReply",
                nession_protocol::contracts::env::v1::ClientEnvWriteResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "env.delete",
            version: 1,
            wires: &["client.env.delete", "server.env.delete"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvDeletePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvDeleteResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "EnvDeleteCall",
                nession_protocol::contracts::env::v1::ClientEnvDeletePayload::inline,
            )),
            response: Some((
                "EnvDeleteReply",
                nession_protocol::contracts::env::v1::ClientEnvDeleteResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "env.query",
            version: 1,
            wires: &["server.env.query"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ServerEnvQueryPayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::AgentEnvStatePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvFileRef>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "EnvQueryCall",
                nession_protocol::contracts::env::v1::ServerEnvQueryPayload::inline,
            )),
            response: Some((
                "EnvQueryReply",
                nession_protocol::contracts::env::v1::AgentEnvStatePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "server.info",
            version: 1,
            wires: &["client.server.info"],
            decls: vec![
                decl_of::<nession_protocol::contracts::server::v1::ServerInfoRequest>(cfg),
                decl_of::<nession_protocol::contracts::server::v1::ServerInfoResponse>(cfg),
                decl_of::<nession_protocol::ProtocolManifest>(cfg),
                decl_of::<nession_protocol::ContractSupport>(cfg),
                decl_of::<nession_protocol::ProtocolId>(cfg),
                decl_of::<nession_protocol::ContractVersion>(cfg),
            ],
            request: Some((
                "ServerInfoCall",
                nession_protocol::contracts::server::v1::ServerInfoRequest::inline,
            )),
            response: Some((
                "ServerInfoReply",
                nession_protocol::contracts::server::v1::ServerInfoResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "commands.list",
            version: 1,
            wires: &["client.commands.list"],
            decls: vec![
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsListPayload>(cfg),
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsListResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::commands::v1::QuickCommandItem>(cfg),
            ],
            request: Some((
                "CommandsListCall",
                nession_protocol::contracts::commands::v1::ClientCommandsListPayload::inline,
            )),
            response: Some((
                "CommandsListReply",
                nession_protocol::contracts::commands::v1::ClientCommandsListResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "commands.add",
            version: 1,
            wires: &["client.commands.add"],
            decls: vec![
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsAddPayload>(cfg),
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsAddResponsePayload>(cfg),
            ],
            request: Some((
                "CommandsAddCall",
                nession_protocol::contracts::commands::v1::ClientCommandsAddPayload::inline,
            )),
            response: Some((
                "CommandsAddReply",
                nession_protocol::contracts::commands::v1::ClientCommandsAddResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "commands.remove",
            version: 1,
            wires: &["client.commands.remove"],
            decls: vec![
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsRemovePayload>(cfg),
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsRemoveResponsePayload>(cfg),
            ],
            request: Some((
                "CommandsRemoveCall",
                nession_protocol::contracts::commands::v1::ClientCommandsRemovePayload::inline,
            )),
            response: Some((
                "CommandsRemoveReply",
                nession_protocol::contracts::commands::v1::ClientCommandsRemoveResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "commands.update",
            version: 1,
            wires: &["client.commands.update"],
            decls: vec![
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsUpdatePayload>(cfg),
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsUpdateResponsePayload>(cfg),
            ],
            request: Some((
                "CommandsUpdateCall",
                nession_protocol::contracts::commands::v1::ClientCommandsUpdatePayload::inline,
            )),
            response: Some((
                "CommandsUpdateReply",
                nession_protocol::contracts::commands::v1::ClientCommandsUpdateResponsePayload::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "terminal.input",
            version: 1,
            wires: &["terminal.input"],
            decls: vec![
                decl_of::<nession_protocol::contracts::terminal::v1::TerminalInputPayload>(cfg),
            ],
            request: Some((
                "TerminalInputCall",
                nession_protocol::contracts::terminal::v1::TerminalInputPayload::inline,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "terminal.resize",
            version: 1,
            wires: &["terminal.resize"],
            decls: vec![
                decl_of::<nession_protocol::contracts::terminal::v1::TerminalResizePayload>(cfg),
            ],
            request: Some((
                "TerminalResizeCall",
                nession_protocol::contracts::terminal::v1::TerminalResizePayload::inline,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "file.list",
            version: 1,
            wires: &["file.list"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileListPayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileListResponse>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileEntry>(cfg),
            ],
            request: Some((
                "FileListCall",
                nession_protocol::contracts::file::v1::FileListPayload::inline,
            )),
            response: Some((
                "FileListReply",
                nession_protocol::contracts::file::v1::FileListResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "file.read",
            version: 1,
            wires: &["file.read"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileReadPayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileData>(cfg),
            ],
            request: Some((
                "FileReadCall",
                nession_protocol::contracts::file::v1::FileReadPayload::inline,
            )),
            response: Some((
                "FileReadReply",
                nession_protocol::contracts::file::v1::FileData::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "file.write",
            version: 1,
            wires: &["file.write"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileWritePayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileWriteResponse>(cfg),
            ],
            request: Some((
                "FileWriteCall",
                nession_protocol::contracts::file::v1::FileWritePayload::inline,
            )),
            response: Some((
                "FileWriteReply",
                nession_protocol::contracts::file::v1::FileWriteResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "file.delete",
            version: 1,
            wires: &["file.delete"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileDeletePayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileMutationResponse>(cfg),
            ],
            request: Some((
                "FileDeleteCall",
                nession_protocol::contracts::file::v1::FileDeletePayload::inline,
            )),
            response: Some((
                "FileDeleteReply",
                nession_protocol::contracts::file::v1::FileMutationResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "file.create-dir",
            version: 1,
            wires: &["file.create_dir"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileCreateDirPayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileMutationResponse>(cfg),
            ],
            request: Some((
                "FileCreateDirCall",
                nession_protocol::contracts::file::v1::FileCreateDirPayload::inline,
            )),
            response: Some((
                "FileCreateDirReply",
                nession_protocol::contracts::file::v1::FileMutationResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "file.rename",
            version: 1,
            wires: &["file.rename"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileRenamePayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileRenameResponse>(cfg),
            ],
            request: Some((
                "FileRenameCall",
                nession_protocol::contracts::file::v1::FileRenamePayload::inline,
            )),
            response: Some((
                "FileRenameReply",
                nession_protocol::contracts::file::v1::FileRenameResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "file.cwd",
            version: 1,
            wires: &["file.cwd"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileCwdPayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileCwdResponse>(cfg),
            ],
            request: Some((
                "FileCwdCall",
                nession_protocol::contracts::file::v1::FileCwdPayload::inline,
            )),
            response: Some((
                "FileCwdReply",
                nession_protocol::contracts::file::v1::FileCwdResponse::inline,
            )),
        },
        Unit {
            owner: "core",
            id: "keepalive.ping",
            version: 1,
            wires: &["keepalive.ping"],
            decls: vec![],
            request: None,
            response: None,
        },
    ]
}
