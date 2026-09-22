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
    /// This type as a JSON Schema.
    ///
    /// A second projection of the same contract, beside TypeScript rather than
    /// instead of it: `render` is for a consumer that imports the shape,
    /// this is for one that validates a message against it. Both are derived
    /// from the one Rust type, so neither can describe a contract the other
    /// does not.
    pub schema: fn(&mut schemars::SchemaGenerator) -> schemars::Schema,
}

/// One type, as a subschema of a shared generator.
///
/// It takes the generator rather than building a root of its own so that every
/// type in the catalog contributes to **one** `$defs`: two units referring to
/// the same shape must point at one definition, and separate roots would emit
/// that shape twice under whatever names each happened to choose.
fn schema_of<T: schemars::JsonSchema>(gen: &mut schemars::SchemaGenerator) -> schemars::Schema {
    gen.subschema_for::<T>()
}

/// One Protocol Unit at one contract version.
pub struct Unit {
    /// The provider's directory name — `git`, `claude-code`.
    pub owner: &'static str,
    /// The canonical protocol id, `git.status`.
    pub id: &'static str,
    pub version: u32,
    /// The wire message types this contract travels as — **one**, since `#912`.
    ///
    /// This used to say that a unit could be served on two transports, and gave
    /// `server.session.create` and `agent.session.create` as one unit seen from
    /// two sides. That was the pre-`#912` model: the wire carried an
    /// `extension.*` namespace, id and wire were different spellings, and a
    /// lookup unioned them by id. `#912` made the wire *be* the id, and those
    /// two are now two units, not one. Every entry here holds exactly one
    /// string.
    ///
    /// Still a slice because the distinction is the model's, not this build's —
    /// `#678` has the unit as the semantic boundary and the wire as a
    /// projection of it. Collapsing it to `&'static str` is a separate change
    /// and would carry the generated `WIRES` with it.
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
/// shape the alias stands for — as TypeScript, and as JSON Schema.
///
/// A named type rather than the trio written out twice. `Option<(&str, fn(…),
/// fn(…))>` is over clippy's `type_complexity` threshold, and the way out of
/// that is to name the thing rather than to silence the lint — the three parts
/// are one concept, and both fields were already saying so in their doc
/// comments.
///
/// The shape travels as two projections of one type rather than as a name,
/// because the alias name is not the type name: `SessionCreateCall` aliases
/// `SessionCreatePayload`, and nothing derives one from the other.
pub type Alias = (
    &'static str,
    fn(&ts_rs::Config) -> String,
    fn(&mut schemars::SchemaGenerator) -> schemars::Schema,
);

/// Describe one type for the catalog.
///
/// `name` comes from ts-rs rather than being written out here, so a type that
/// is renamed is reported by the compiler *and* the generated file follows
/// without an edit.
fn decl_of<T: TS + schemars::JsonSchema + 'static>(cfg: &ts_rs::Config) -> Decl {
    Decl {
        name: T::ident(cfg),
        render: T::decl,
        deps: T::dependencies,
        schema: schema_of::<T>,
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
                schema_of::<nession_git::protocol::status::v1::StatusRequestV1>,
            )),
            response: Some((
                "StatusResponse",
                nession_git::protocol::status::v1::StatusResponseV1::inline,
                schema_of::<nession_git::protocol::status::v1::StatusResponseV1>,
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
                schema_of::<nession_git::protocol::diff::v1::DiffRequestV1>,
            )),
            response: Some((
                "DiffResponse",
                nession_git::protocol::diff::v1::DiffResponseV1::inline,
                schema_of::<nession_git::protocol::diff::v1::DiffResponseV1>,
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
                schema_of::<nession_git::protocol::root::v1::RootRequestV1>,
            )),
            response: Some((
                "RootResponse",
                nession_git::protocol::root::v1::RootResponseV1::inline,
                schema_of::<nession_git::protocol::root::v1::RootResponseV1>,
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
                schema_of::<nession_git::protocol::log::v1::LogRequestV1>,
            )),
            response: Some((
                "LogResponse",
                nession_git::protocol::log::v1::LogResponseV1::inline,
                schema_of::<nession_git::protocol::log::v1::LogResponseV1>,
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
                schema_of::<nession_git::protocol::branches::v1::BranchesRequestV1>,
            )),
            response: Some((
                "BranchesResponse",
                nession_git::protocol::branches::v1::BranchesResponseV1::inline,
                schema_of::<nession_git::protocol::branches::v1::BranchesResponseV1>,
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
                schema_of::<nession_git::protocol::worktrees::v1::WorktreesRequestV1>,
            )),
            response: Some((
                "WorktreesResponse",
                nession_git::protocol::worktrees::v1::WorktreesResponseV1::inline,
                schema_of::<nession_git::protocol::worktrees::v1::WorktreesResponseV1>,
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
                schema_of::<nession_claude_code::protocol::list::v1::ListRequestV1>,
            )),
            response: Some((
                "ListResponse",
                nession_claude_code::protocol::list::v1::ListResponseV1::inline,
                schema_of::<nession_claude_code::protocol::list::v1::ListResponseV1>,
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
                schema_of::<nession_claude_code::protocol::read::v1::ReadRequestV1>,
            )),
            response: Some((
                "ReadResponse",
                nession_claude_code::protocol::read::v1::ReadResponseV1::inline,
                schema_of::<nession_claude_code::protocol::read::v1::ReadResponseV1>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.agent.register",
            version: 1,
wires: &["server.agent.register"],
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
                schema_of::<nession_protocol::contracts::agent::v1::AgentRegisterPayload>,
            )),
            response: Some((
                "AgentRegisterReply",
                nession_protocol::contracts::agent::v1::AgentRegisterResponsePayload::inline,
                schema_of::<nession_protocol::contracts::agent::v1::AgentRegisterResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.agent.heartbeat",
            version: 1,
wires: &["server.agent.heartbeat"],
            decls: vec![
                decl_of::<nession_protocol::contracts::agent::v1::AgentHeartbeatPayload>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentStatus>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::HeartbeatMetadata>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentMetadata>(cfg),
            ],
            request: Some((
                "AgentHeartbeatCall",
                nession_protocol::contracts::agent::v1::AgentHeartbeatPayload::inline,
                schema_of::<nession_protocol::contracts::agent::v1::AgentHeartbeatPayload>,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.agent.session-update",
            version: 1,
wires: &["server.agent.session-update"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.agent.command-response",
            version: 1,
wires: &["server.agent.command-response"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::AgentCommandResponsePayload>(cfg),
            ],
            request: Some((
                "AgentCommandResponseCall",
                nession_protocol::contracts::session::v1::AgentCommandResponsePayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::AgentCommandResponsePayload>,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.agent.terminal-resize",
            version: 1,
wires: &["server.agent.terminal-resize"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::AgentTerminalResizePayload>(cfg),
            ],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.agent.address-update",
            version: 1,
wires: &["server.agent.address-update"],
            decls: vec![
                decl_of::<nession_protocol::contracts::agent::v1::AgentAddressUpdatePayload>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentAddress>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::NetworkType>(cfg),
            ],
            request: Some((
                "AgentAddressUpdateCall",
                nession_protocol::contracts::agent::v1::AgentAddressUpdatePayload::inline,
                schema_of::<nession_protocol::contracts::agent::v1::AgentAddressUpdatePayload>,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.agent.list",
            version: 1,
wires: &["server.agent.list"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.agent.rename",
            version: 1,
wires: &["server.agent.rename"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.agent.delete",
            version: 1,
wires: &["server.agent.delete"],
            decls: vec![
                decl_of::<nession_protocol::contracts::agent::v1::ClientAgentDeletePayload>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::ClientAgentDeleteResponsePayload>(cfg),
            ],
            request: Some((
                "AgentDeleteCall",
                nession_protocol::contracts::agent::v1::ClientAgentDeletePayload::inline,
                schema_of::<nession_protocol::contracts::agent::v1::ClientAgentDeletePayload>,
            )),
            response: Some((
                "AgentDeleteReply",
                nession_protocol::contracts::agent::v1::ClientAgentDeleteResponsePayload::inline,
                schema_of::<nession_protocol::contracts::agent::v1::ClientAgentDeleteResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.auth",
            version: 1,
            wires: &["server.auth"],
            // Identity only. The Server reads this request's fields out of
            // `serde_json::Value` and builds its answer with `json!`, so there
            // is no named shape to point at. Naming one from `contracts/`
            // would describe a type the handler does not use.
            decls: vec![],
            request: None,
            response: None,
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
                schema_of::<nession_protocol::contracts::client::v1::ClientAuthPayload>,
            )),
            response: Some((
                "ClientAuthReply",
                nession_protocol::contracts::client::v1::AuthResponsePayload::inline,
                schema_of::<nession_protocol::contracts::client::v1::AuthResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.attach",
            version: 1,
            wires: &["agent.attach"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientAttachPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientAttachResponse>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSnapshot>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "ClientAttachCall",
                nession_protocol::contracts::session::v1::ClientAttachPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientAttachPayload>,
            )),
            response: Some((
                "ClientAttachReply",
                nession_protocol::contracts::session::v1::ClientAttachResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientAttachResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.detach",
            version: 1,
            wires: &["agent.detach"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientDetachPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientDetachResponse>(cfg),
            ],
            request: Some((
                "ClientDetachCall",
                nession_protocol::contracts::session::v1::ClientDetachPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientDetachPayload>,
            )),
            response: Some((
                "ClientDetachReply",
                nession_protocol::contracts::session::v1::ClientDetachResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientDetachResponse>,
            )),
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
                schema_of::<nession_protocol::contracts::session::v1::WebSessionAttachPayload>,
            )),
            response: Some((
                "ClientSessionAttachReply",
                nession_protocol::contracts::session::v1::WebAttachInfo::inline,
                schema_of::<nession_protocol::contracts::session::v1::WebAttachInfo>,
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
                schema_of::<nession_protocol::contracts::session::v1::WebSessionCreatePayload>,
            )),
            response: Some((
                "ClientSessionCreateReply",
                nession_protocol::contracts::session::v1::WebSessionCreateResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::WebSessionCreateResponse>,
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
                schema_of::<nession_protocol::contracts::session::v1::WebSessionKillPayload>,
            )),
            response: Some((
                "ClientSessionKillReply",
                nession_protocol::contracts::session::v1::WebSessionKillResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::WebSessionKillResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.list",
            version: 1,
            wires: &["server.session.list"],
            // Identity only. The Server reads this request's fields out of
            // `serde_json::Value` and builds its answer with `json!`, so there
            // is no named shape to point at. Naming one from `contracts/`
            // would describe a type the handler does not use.
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.session.report",
            version: 1,
wires: &["agent.session.report"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::SessionListResponse>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionInfo>(cfg),
            ],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.session.list",
            version: 1,
            wires: &["agent.session.list"],
            // Identity only. The Server reads this request's fields out of
            // `serde_json::Value` and builds its answer with `json!`, so there
            // is no named shape to point at. Naming one from `contracts/`
            // would describe a type the handler does not use.
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.session.create",
            version: 1,
            wires: &["server.session.create"],
            // Identity only. The Server reads this request's fields out of
            // `serde_json::Value` and builds its answer with `json!`, so there
            // is no named shape to point at. Naming one from `contracts/`
            // would describe a type the handler does not use.
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.session.create",
            version: 1,
wires: &["agent.session.create"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSnapshot>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionCreatePayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionCreateResponse>(cfg),
            ],
            request: Some((
                "SessionCreateCall",
                nession_protocol::contracts::session::v1::SessionCreatePayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::SessionCreatePayload>,
            )),
            response: Some((
                "SessionCreateReply",
                nession_protocol::contracts::session::v1::SessionCreateResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::SessionCreateResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.kill",
            version: 1,
            wires: &["server.session.kill"],
            // Identity only. The Server reads this request's fields out of
            // `serde_json::Value` and builds its answer with `json!`, so there
            // is no named shape to point at. Naming one from `contracts/`
            // would describe a type the handler does not use.
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.session.kill",
            version: 1,
wires: &["agent.session.kill"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::SessionKillPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionKillResponse>(cfg),
            ],
            request: Some((
                "SessionKillCall",
                nession_protocol::contracts::session::v1::SessionKillPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::SessionKillPayload>,
            )),
            response: Some((
                "SessionKillReply",
                nession_protocol::contracts::session::v1::SessionKillResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::SessionKillResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.attach",
            version: 1,
wires: &["server.session.attach"],
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
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionAttachPayload>,
            )),
            response: Some((
                "SessionAttachReply",
                nession_protocol::contracts::session::v1::ClientSessionAttachResponsePayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionAttachResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.capture-preview",
            version: 1,
            wires: &["server.session.capture-preview"],
            // Identity only. The Server reads this request's fields out of
            // `serde_json::Value` and builds its answer with `json!`, so there
            // is no named shape to point at. Naming one from `contracts/`
            // would describe a type the handler does not use.
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.session.capture-preview",
            version: 1,
wires: &["agent.session.capture-preview"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::SessionCapturePreviewPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionCapturePreviewResponse>(cfg),
            ],
            request: Some((
                "SessionCapturePreviewCall",
                nession_protocol::contracts::session::v1::SessionCapturePreviewPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::SessionCapturePreviewPayload>,
            )),
            response: Some((
                "SessionCapturePreviewReply",
                nession_protocol::contracts::session::v1::SessionCapturePreviewResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::SessionCapturePreviewResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.relay.begin",
            version: 1,
wires: &["server.session.relay.begin"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.session.relay.end",
            version: 1,
wires: &["server.session.relay.end"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.session.env.apply",
            version: 1,
            wires: &["server.session.env.apply"],
            // Identity only. The Server reads this request's fields out of
            // `serde_json::Value` and builds its answer with `json!`, so there
            // is no named shape to point at. Naming one from `contracts/`
            // would describe a type the handler does not use.
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.session.env.apply",
            version: 1,
wires: &["agent.session.env.apply"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvApplyPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvFileRef>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "SessionEnvApplyCall",
                nession_protocol::contracts::session::v1::ClientSessionEnvApplyPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionEnvApplyPayload>,
            )),
            response: Some((
                "SessionEnvApplyReply",
                nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.env.unset",
            version: 1,
            wires: &["server.session.env.unset"],
            // Identity only. The Server reads this request's fields out of
            // `serde_json::Value` and builds its answer with `json!`, so there
            // is no named shape to point at. Naming one from `contracts/`
            // would describe a type the handler does not use.
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.session.env.unset",
            version: 1,
wires: &["agent.session.env.unset"],
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvUnsetPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvFileRef>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "SessionEnvUnsetCall",
                nession_protocol::contracts::session::v1::ClientSessionEnvUnsetPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionEnvUnsetPayload>,
            )),
            response: Some((
                "SessionEnvUnsetReply",
                nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.env.active",
            version: 1,
wires: &["server.session.env.active"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ActiveEnvFile>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.session.env.query",
            version: 1,
            wires: &["server.session.env.query"],
            decls: vec![],
            request: None,
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.env.list",
            version: 1,
            wires: &["server.env.list"],
            // Typed, and the same two types `agent.env.list` already declares a
            // few lines up — one question, asked of the Server by a browser and
            // of an agent by the Server. The handler read and wrote `Value`
            // while these sat unused, which is what "identity only" meant here.
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvListPayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvListResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvFileInfo>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "ClientEnvListCall",
                nession_protocol::contracts::env::v1::ClientEnvListPayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvListPayload>,
            )),
            response: Some((
                "ClientEnvListReply",
                nession_protocol::contracts::env::v1::ClientEnvListResponsePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvListResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.env.list",
            version: 1,
wires: &["agent.env.list"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvListPayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvListResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvFileInfo>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "EnvListCall",
                nession_protocol::contracts::env::v1::ClientEnvListPayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvListPayload>,
            )),
            response: Some((
                "EnvListReply",
                nession_protocol::contracts::env::v1::ClientEnvListResponsePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvListResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.env.get",
            version: 1,
            wires: &["server.env.get"],
            // Typed, like its `agent.env.get` twin.
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvGetPayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvGetResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "ClientEnvGetCall",
                nession_protocol::contracts::env::v1::ClientEnvGetPayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvGetPayload>,
            )),
            response: Some((
                "ClientEnvGetReply",
                nession_protocol::contracts::env::v1::ClientEnvGetResponsePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvGetResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.env.get",
            version: 1,
wires: &["agent.env.get"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvGetPayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvGetResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "EnvGetCall",
                nession_protocol::contracts::env::v1::ClientEnvGetPayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvGetPayload>,
            )),
            response: Some((
                "EnvGetReply",
                nession_protocol::contracts::env::v1::ClientEnvGetResponsePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvGetResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.env.write",
            version: 1,
            wires: &["server.env.write"],
            // Typed, like its `agent.env.write` twin. The contract gained four
            // fields the wire has always carried and it never named — `force`
            // on the request, and `in_use_by` / `re_sourced` /
            // `re_source_errors` on the reply — each optional so that the
            // branches which do not carry it are unchanged.
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvWritePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvWriteResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "ClientEnvWriteCall",
                nession_protocol::contracts::env::v1::ClientEnvWritePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvWritePayload>,
            )),
            response: Some((
                "ClientEnvWriteReply",
                nession_protocol::contracts::env::v1::ClientEnvWriteResponsePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvWriteResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.env.write",
            version: 1,
wires: &["agent.env.write"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvWritePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvWriteResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "EnvWriteCall",
                nession_protocol::contracts::env::v1::ClientEnvWritePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvWritePayload>,
            )),
            response: Some((
                "EnvWriteReply",
                nession_protocol::contracts::env::v1::ClientEnvWriteResponsePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvWriteResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.env.delete",
            version: 1,
            wires: &["server.env.delete"],
            // Typed, like its `agent.env.delete` twin. The only wire change is
            // that `force` is now named by the contract rather than read from
            // `Value` beside it — it was always sent.
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvDeletePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvDeleteResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "ClientEnvDeleteCall",
                nession_protocol::contracts::env::v1::ClientEnvDeletePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvDeletePayload>,
            )),
            response: Some((
                "ClientEnvDeleteReply",
                nession_protocol::contracts::env::v1::ClientEnvDeleteResponsePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvDeleteResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.env.delete",
            version: 1,
wires: &["agent.env.delete"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvDeletePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ClientEnvDeleteResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "EnvDeleteCall",
                nession_protocol::contracts::env::v1::ClientEnvDeletePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvDeletePayload>,
            )),
            response: Some((
                "EnvDeleteReply",
                nession_protocol::contracts::env::v1::ClientEnvDeleteResponsePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ClientEnvDeleteResponsePayload>,
            )),
        },
                Unit {
            owner: "core",
            id: "agent.env.query",
            version: 1,
wires: &["agent.env.query"],
            decls: vec![
                decl_of::<nession_protocol::contracts::env::v1::ServerEnvQueryPayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::AgentEnvStatePayload>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvFileRef>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "EnvQueryCall",
                nession_protocol::contracts::env::v1::ServerEnvQueryPayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::ServerEnvQueryPayload>,
            )),
            response: Some((
                "EnvQueryReply",
                nession_protocol::contracts::env::v1::AgentEnvStatePayload::inline,
                schema_of::<nession_protocol::contracts::env::v1::AgentEnvStatePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.info",
            version: 1,
wires: &["server.info"],
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
                schema_of::<nession_protocol::contracts::server::v1::ServerInfoRequest>,
            )),
            response: Some((
                "ServerInfoReply",
                nession_protocol::contracts::server::v1::ServerInfoResponse::inline,
                schema_of::<nession_protocol::contracts::server::v1::ServerInfoResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.commands.list",
            version: 1,
wires: &["server.commands.list"],
            decls: vec![
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsListPayload>(cfg),
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsListResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::commands::v1::QuickCommandItem>(cfg),
            ],
            request: Some((
                "CommandsListCall",
                nession_protocol::contracts::commands::v1::ClientCommandsListPayload::inline,
                schema_of::<nession_protocol::contracts::commands::v1::ClientCommandsListPayload>,
            )),
            response: Some((
                "CommandsListReply",
                nession_protocol::contracts::commands::v1::ClientCommandsListResponsePayload::inline,
                schema_of::<nession_protocol::contracts::commands::v1::ClientCommandsListResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.commands.add",
            version: 1,
wires: &["server.commands.add"],
            decls: vec![
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsAddPayload>(cfg),
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsAddResponsePayload>(cfg),
            ],
            request: Some((
                "CommandsAddCall",
                nession_protocol::contracts::commands::v1::ClientCommandsAddPayload::inline,
                schema_of::<nession_protocol::contracts::commands::v1::ClientCommandsAddPayload>,
            )),
            response: Some((
                "CommandsAddReply",
                nession_protocol::contracts::commands::v1::ClientCommandsAddResponsePayload::inline,
                schema_of::<nession_protocol::contracts::commands::v1::ClientCommandsAddResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.commands.remove",
            version: 1,
wires: &["server.commands.remove"],
            decls: vec![
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsRemovePayload>(cfg),
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsRemoveResponsePayload>(cfg),
            ],
            request: Some((
                "CommandsRemoveCall",
                nession_protocol::contracts::commands::v1::ClientCommandsRemovePayload::inline,
                schema_of::<nession_protocol::contracts::commands::v1::ClientCommandsRemovePayload>,
            )),
            response: Some((
                "CommandsRemoveReply",
                nession_protocol::contracts::commands::v1::ClientCommandsRemoveResponsePayload::inline,
                schema_of::<nession_protocol::contracts::commands::v1::ClientCommandsRemoveResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.commands.update",
            version: 1,
wires: &["server.commands.update"],
            decls: vec![
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsUpdatePayload>(cfg),
                decl_of::<nession_protocol::contracts::commands::v1::ClientCommandsUpdateResponsePayload>(cfg),
            ],
            request: Some((
                "CommandsUpdateCall",
                nession_protocol::contracts::commands::v1::ClientCommandsUpdatePayload::inline,
                schema_of::<nession_protocol::contracts::commands::v1::ClientCommandsUpdatePayload>,
            )),
            response: Some((
                "CommandsUpdateReply",
                nession_protocol::contracts::commands::v1::ClientCommandsUpdateResponsePayload::inline,
                schema_of::<nession_protocol::contracts::commands::v1::ClientCommandsUpdateResponsePayload>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.terminal.input",
            version: 1,
wires: &["agent.terminal.input"],
            decls: vec![
                decl_of::<nession_protocol::contracts::terminal::v1::TerminalInputPayload>(cfg),
            ],
            request: Some((
                "TerminalInputCall",
                nession_protocol::contracts::terminal::v1::TerminalInputPayload::inline,
                schema_of::<nession_protocol::contracts::terminal::v1::TerminalInputPayload>,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.terminal.resize",
            version: 1,
wires: &["agent.terminal.resize"],
            decls: vec![
                decl_of::<nession_protocol::contracts::terminal::v1::TerminalResizePayload>(cfg),
            ],
            request: Some((
                "TerminalResizeCall",
                nession_protocol::contracts::terminal::v1::TerminalResizePayload::inline,
                schema_of::<nession_protocol::contracts::terminal::v1::TerminalResizePayload>,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.file.list",
            version: 1,
wires: &["agent.file.list"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileListPayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileListResponse>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileEntry>(cfg),
            ],
            request: Some((
                "FileListCall",
                nession_protocol::contracts::file::v1::FileListPayload::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileListPayload>,
            )),
            response: Some((
                "FileListReply",
                nession_protocol::contracts::file::v1::FileListResponse::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileListResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.file.read",
            version: 1,
wires: &["agent.file.read"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileReadPayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileData>(cfg),
            ],
            request: Some((
                "FileReadCall",
                nession_protocol::contracts::file::v1::FileReadPayload::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileReadPayload>,
            )),
            response: Some((
                "FileReadReply",
                nession_protocol::contracts::file::v1::FileData::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileData>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.file.write",
            version: 1,
wires: &["agent.file.write"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileWritePayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileWriteResponse>(cfg),
            ],
            request: Some((
                "FileWriteCall",
                nession_protocol::contracts::file::v1::FileWritePayload::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileWritePayload>,
            )),
            response: Some((
                "FileWriteReply",
                nession_protocol::contracts::file::v1::FileWriteResponse::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileWriteResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.file.delete",
            version: 1,
wires: &["agent.file.delete"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileDeletePayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileMutationResponse>(cfg),
            ],
            request: Some((
                "FileDeleteCall",
                nession_protocol::contracts::file::v1::FileDeletePayload::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileDeletePayload>,
            )),
            response: Some((
                "FileDeleteReply",
                nession_protocol::contracts::file::v1::FileMutationResponse::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileMutationResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.file.create-dir",
            version: 1,
wires: &["agent.file.create-dir"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileCreateDirPayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileMutationResponse>(cfg),
            ],
            request: Some((
                "FileCreateDirCall",
                nession_protocol::contracts::file::v1::FileCreateDirPayload::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileCreateDirPayload>,
            )),
            response: Some((
                "FileCreateDirReply",
                nession_protocol::contracts::file::v1::FileMutationResponse::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileMutationResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.file.rename",
            version: 1,
wires: &["agent.file.rename"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileRenamePayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileRenameResponse>(cfg),
            ],
            request: Some((
                "FileRenameCall",
                nession_protocol::contracts::file::v1::FileRenamePayload::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileRenamePayload>,
            )),
            response: Some((
                "FileRenameReply",
                nession_protocol::contracts::file::v1::FileRenameResponse::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileRenameResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.file.cwd",
            version: 1,
wires: &["agent.file.cwd"],
            decls: vec![
                decl_of::<nession_protocol::contracts::file::v1::FileCwdPayload>(cfg),
                decl_of::<nession_protocol::contracts::file::v1::FileCwdResponse>(cfg),
            ],
            request: Some((
                "FileCwdCall",
                nession_protocol::contracts::file::v1::FileCwdPayload::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileCwdPayload>,
            )),
            response: Some((
                "FileCwdReply",
                nession_protocol::contracts::file::v1::FileCwdResponse::inline,
                schema_of::<nession_protocol::contracts::file::v1::FileCwdResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.keepalive.ping",
            version: 1,
wires: &["agent.keepalive.ping"],
            decls: vec![],
            request: None,
            response: None,
        },
    ]
}
