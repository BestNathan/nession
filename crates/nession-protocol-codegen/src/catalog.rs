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
///
/// `Clone` so a test can describe a catalog this build does not serve — the
/// only way to check two versions of one unit survive generation, since no
/// shipped contract has a second version yet. Every field is a string, a
/// function pointer or a `Vec`, so this is a derive and not a decision.
#[derive(Clone)]
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
///
/// ## What is *not* one
///
/// Two categories, and they are different from each other as well as from a
/// unit — `docs/architecture/protocol.md` § *What is not a Protocol Unit* holds
/// the rule in prose. Restated here because this is where someone arrives when
/// the schema says a unit has no `response`:
///
/// * A **notification** — a message a peer pushes on its own initiative, on a
///   wire of its own (`server.agents.changed`, `agent.terminal.output`). It has
///   a wire, a payload type and a sender, which is exactly why it is the one
///   thing that gets mistaken for a unit. The test is one question:
///
///   > **Does anything dispatch it?** A unit is something a dispatcher
///   > *answers*. A notification is one nobody asks for: no route table has an
///   > arm for it, and nothing can ask for it.
///
/// * A **control** message (`control.heartbeat`, `control.ping`,
///   `control.pong`) — the other one. It *is* dispatched by every runtime and
///   still is not a unit, because the manifest is a statement of what you can
///   ask a peer for: every peer may *send* a control message and every peer
///   must *handle* one, so an offer is not the right description of it. Naming
///   it a unit would also break the operation grammar, whose first segment
///   names the answerer — and control has no answerer.
///
/// `server.heartbeat.ack` is the historical example of getting this wrong: it
/// was neither, and it has been deleted rather than classified.
#[derive(Clone)]
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
    /// Optional, though **always `Some` today**: every unit carries a request
    /// shape, and `every_unit_declares_a_request_shape` fails if one stops. It
    /// stays an `Option` because the half that is genuinely missing is the other
    /// one: a unit has no `response` when it is one-way
    /// (`server.agent.address-update` announces endpoints and nothing answers).
    ///
    /// The examples this comment used to give had gone stale in one direction
    /// and false in the other: it named `agent.terminal-resize` and
    /// `session.relay.begin` as events with "no request at all" (both have one
    /// now — every unit does), and it called the heartbeat's acknowledgement "a
    /// different unit's shape" when no such unit existed. Both were checkable
    /// claims nobody checked; the second is what sent someone hunting for a unit
    /// to add, and the answer is that the unit must *not* exist.
    ///
    /// Requiring the absent half would have meant inventing a type for it to
    /// satisfy the catalog, which is the opposite of what a catalog is for — and
    /// excluding those units would have put the "two lists that drift" problem
    /// back, which is the thing this file exists to avoid.
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
            owner: "claude-code",
            id: "claude-code.conversation",
            version: 1,
            wires: &["claude-code.conversation"],
            decls: vec![
                decl_of::<nession_claude_code::protocol::conversation::v1::ConversationRequestV1>(
                    cfg,
                ),
                decl_of::<nession_claude_code::protocol::conversation::v1::ConversationResponseV1>(
                    cfg,
                ),
                decl_of::<nession_claude_code::protocol::conversation::v1::ConversationStateV1>(cfg),
                decl_of::<nession_claude_code::protocol::conversation::v1::ConversationItemV1>(cfg),
                decl_of::<nession_claude_code::protocol::conversation::v1::ItemKindV1>(cfg),
                decl_of::<nession_claude_code::protocol::conversation::v1::ToolV1>(cfg),
                decl_of::<nession_claude_code::protocol::conversation::v1::ConversationIdentityV1>(
                    cfg,
                ),
                decl_of::<nession_claude_code::protocol::conversation::v1::ConversationCandidateV1>(
                    cfg,
                ),
            ],
            request: Some((
                "ConversationRequest",
                nession_claude_code::protocol::conversation::v1::ConversationRequestV1::inline,
                schema_of::<nession_claude_code::protocol::conversation::v1::ConversationRequestV1>,
            )),
            response: Some((
                "ConversationResponse",
                nession_claude_code::protocol::conversation::v1::ConversationResponseV1::inline,
                schema_of::<nession_claude_code::protocol::conversation::v1::ConversationResponseV1>,
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
        // `server.agent.heartbeat` used to be here, as a one-way unit with
        // `response: None` and a comment explaining that its acknowledgement
        // travelled on a wire of its own. Both halves of that are gone, and
        // they went together: the heartbeat is `control.heartbeat` — a control
        // wire, which is not a unit — and the acknowledgement does not exist,
        // because control has no acknowledgement.
        //
        // The reasoning that put it here is worth keeping, because it is what
        // the new category replaced. Its `response: None` was read as "the
        // answer is a *notification*", and the notification was then declared
        // nowhere, so a reader looking for the unit that carried it found no
        // unit and concluded one was missing. The missing thing was a
        // category, not an entry.
        Unit {
            owner: "core",
            id: "server.agent.session-update",
            version: 1,
            wires: &["server.agent.session-update"],
            // One-way: the agent reports one session's state and nothing answers.
            // All five exits of `handle_agent_session_update` are `Reply(None)` —
            // two of them deliberate early-outs, which is why "answers nothing"
            // is a different claim from "always succeeds".
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::AgentSessionUpdatePayload>(cfg),
            ],
            request: Some((
                "AgentSessionUpdateCall",
                nession_protocol::contracts::session::v1::AgentSessionUpdatePayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::AgentSessionUpdatePayload>,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.agent.git-invalidated",
            version: 1,
            wires: &["server.agent.git-invalidated"],
            // One-way (#1008): the agent reports that a Session's git state may
            // be stale; the server fans out `agent.git.invalidated` and answers
            // nothing.
            decls: vec![decl_of::<
                nession_protocol::contracts::session::v1::AgentGitInvalidatedPayload,
            >(cfg)],
            request: Some((
                "AgentGitInvalidatedCall",
                nession_protocol::contracts::session::v1::AgentGitInvalidatedPayload::inline,
                schema_of::<
                    nession_protocol::contracts::session::v1::AgentGitInvalidatedPayload,
                >,
            )),
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
            // One-way: a size change is announced, not answered. The server
            // re-broadcasts it to clients and returns `Reply(None)`.
            //
            // The type was already declared here and simply not attached as the
            // `request`, while the handler deserialised into it — so the contract
            // existed and the catalog did not know. The cheapest unit of the
            // seven: no new type, only the wire between the two.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::AgentTerminalResizePayload>(cfg),
            ],
            request: Some((
                "AgentTerminalResizeCall",
                nession_protocol::contracts::session::v1::AgentTerminalResizePayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::AgentTerminalResizePayload>,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.agent.address-update",
            version: 1,
            wires: &["server.agent.address-update"],
            // One-way: the agent announces its endpoints. Nothing answers it,
            // on any wire.
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
            // Typed. The view type already existed — with the right name and
            // seven of the builder's thirteen fields, which is how a
            // name-matched type hides a shape mismatch: you can see it by
            // counting.
            decls: vec![
                decl_of::<nession_protocol::contracts::agent::v1::AgentListPayload>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentListReply>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::WebAgentsListResponse>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::WebAgentInfo>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentRefusal>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::ProbedAddress>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentAddress>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::NetworkType>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AddressStatus>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentMetadata>(cfg),
                decl_of::<nession_protocol::ProtocolManifest>(cfg),
                // Transitive: the manifest is keyed by id, so declaring it
                // without this leaves an unresolved reference — which the
                // generator refuses to write rather than emitting it.
                decl_of::<nession_protocol::ProtocolId>(cfg),
                decl_of::<nession_protocol::ContractSupport>(cfg),
                decl_of::<nession_protocol::ContractVersion>(cfg),
            ],
            request: Some((
                "AgentListCall",
                nession_protocol::contracts::agent::v1::AgentListPayload::inline,
                schema_of::<nession_protocol::contracts::agent::v1::AgentListPayload>,
            )),
            response: Some((
                "AgentListResponse",
                nession_protocol::contracts::agent::v1::AgentListReply::inline,
                schema_of::<nession_protocol::contracts::agent::v1::AgentListReply>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.agent.rename",
            version: 1,
            wires: &["server.agent.rename"],
            // Typed, and the reply is `WebAgentInfo` — the same type
            // `server.agent.list` returns. That is the fix, not a tidy-up: this
            // arm used to build its own agent block and had drifted in exactly
            // the two ways those fields are easiest to lose.
            decls: vec![
                decl_of::<nession_protocol::contracts::agent::v1::AgentRenamePayload>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentRenameReply>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentRenameResponse>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentRenameFailure>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::WebAgentInfo>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::ProbedAddress>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentAddress>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::NetworkType>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AddressStatus>(cfg),
                decl_of::<nession_protocol::contracts::agent::v1::AgentMetadata>(cfg),
                decl_of::<nession_protocol::ProtocolManifest>(cfg),
                decl_of::<nession_protocol::ProtocolId>(cfg),
                decl_of::<nession_protocol::ContractSupport>(cfg),
                decl_of::<nession_protocol::ContractVersion>(cfg),
            ],
            request: Some((
                "AgentRenameCall",
                nession_protocol::contracts::agent::v1::AgentRenamePayload::inline,
                schema_of::<nession_protocol::contracts::agent::v1::AgentRenamePayload>,
            )),
            response: Some((
                "AgentRenameResult",
                nession_protocol::contracts::agent::v1::AgentRenameReply::inline,
                schema_of::<nession_protocol::contracts::agent::v1::AgentRenameReply>,
            )),
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
            // The client's door at the Server; `client.auth` is the same
            // handshake at the Agent's. One operation, two ends — which is why
            // both payload types are shared with it rather than duplicated per
            // end, and why this unit sits beside it in the `client` family.
            //
            // Typed once the handler built its answer from a type instead of
            // `json!`; before that there was no named shape to point at.
            decls: vec![
                decl_of::<nession_protocol::contracts::client::v1::ClientAuthPayload>(cfg),
                decl_of::<nession_protocol::contracts::client::v1::AuthResponsePayload>(cfg),
            ],
            request: Some((
                "ServerAuthCall",
                nession_protocol::contracts::client::v1::ClientAuthPayload::inline,
                schema_of::<nession_protocol::contracts::client::v1::ClientAuthPayload>,
            )),
            response: Some((
                "ServerAuthReply",
                nession_protocol::contracts::client::v1::AuthResponsePayload::inline,
                schema_of::<nession_protocol::contracts::client::v1::AuthResponsePayload>,
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
            id: "agent.p2p.grant",
            version: 1,
            wires: &["agent.p2p.grant"],
            // Server -> agent, and the direction is the point (#1013). The
            // Server issues a P2P credential and the Agent is what honours it,
            // so the record has to reach the verifier *before* the client that
            // will present it is given the token. The caller is the Server's
            // push on this same connection.
            decls: vec![
                decl_of::<nession_protocol::contracts::p2p::v1::P2pGrantPayload>(cfg),
                decl_of::<nession_protocol::contracts::p2p::v1::P2pGrantResponse>(cfg),
                decl_of::<nession_protocol::contracts::p2p::v1::CredentialScope>(cfg),
            ],
            request: Some((
                "P2pGrantCall",
                nession_protocol::contracts::p2p::v1::P2pGrantPayload::inline,
                schema_of::<nession_protocol::contracts::p2p::v1::P2pGrantPayload>,
            )),
            response: Some((
                "P2pGrantReply",
                nession_protocol::contracts::p2p::v1::P2pGrantResponse::inline,
                schema_of::<nession_protocol::contracts::p2p::v1::P2pGrantResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "client.sessions.list",
            version: 1,
            wires: &["client.sessions.list"],
            // The same pair `agent.session.list` uses, and the same situation:
            // the agent already built `WebSessionsListResponse` by name, and the
            // item types were declared here while neither alias was.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionsListPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::WebSessionsListResponse>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::WebSessionInfo>(cfg),
            ],
            request: Some((
                "ClientSessionsListCall",
                nession_protocol::contracts::session::v1::ClientSessionsListPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionsListPayload>,
            )),
            response: Some((
                "WebSessionsListReply",
                nession_protocol::contracts::session::v1::WebSessionsListResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::WebSessionsListResponse>,
            )),
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
            // The first union. This wire has two disjoint shapes — a list and a
            // refusal — and the refusal half was never declared anywhere,
            // though eleven handlers reply it.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ServerSessionListPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ServerSessionListReply>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::WebSessionsListResponse>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::WebSessionInfo>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionRefusal>(cfg),
            ],
            request: Some((
                "SessionListCall",
                nession_protocol::contracts::session::v1::ServerSessionListPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ServerSessionListPayload>,
            )),
            response: Some((
                "SessionListReply",
                nession_protocol::contracts::session::v1::ServerSessionListReply::inline,
                schema_of::<nession_protocol::contracts::session::v1::ServerSessionListReply>,
            )),
        },
        Unit {
            owner: "core",
            id: "agent.session.report",
            version: 1,
            wires: &["agent.session.report"],
            // Request-only: the answer goes out on `server.agent.command-response`
            // — a unit of its own — because that is what the `command`/`request_id`
            // protocol is for. A reply declared here would describe a message
            // nobody sends.
            //
            // `SessionListResponse` and `SessionInfo` were declared here and are
            // gone: this unit's wire carries `{request_id}` and nothing else. The
            // session list travels on the *answer*, and that belongs to
            // `server.agent.command-response`. They were decls for a shape this
            // unit does not carry.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ServerSessionReportPayload>(cfg),
            ],
            request: Some((
                "ServerSessionReportCall",
                nession_protocol::contracts::session::v1::ServerSessionReportPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ServerSessionReportPayload>,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "agent.session.list",
            version: 1,
            wires: &["agent.session.list"],
            // Typed, and unlike every other unit here the *handler needed no
            // change*: the agent already built `SessionListResponse` by name —
            // it was the only side of this protocol that did, and the catalog
            // had not caught up.
            //
            // Its request is *empty*, not absent: the arm reads nothing off the
            // payload, and `request: None` would claim the unit has no request
            // — which the catalogue's own invariant refuses, correctly.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::AgentSessionListPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionListResponse>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionInfo>(cfg),
            ],
            request: Some((
                "AgentSessionListCall",
                nession_protocol::contracts::session::v1::AgentSessionListPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::AgentSessionListPayload>,
            )),
            response: Some((
                "SessionListReply",
                nession_protocol::contracts::session::v1::SessionListResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::SessionListResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.create",
            version: 1,
            wires: &["server.session.create"],
            // Typed. The request gained `env_files`, which the handler read
            // off the payload and the contract never named — the compiler
            // pointed at it once the parse started moving the payload.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionCreatePayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionCreateResponsePayload>(
                    cfg,
                ),
                decl_of::<nession_protocol::contracts::env::v1::EnvFileRef>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "SessionCreateCall",
                nession_protocol::contracts::session::v1::ClientSessionCreatePayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionCreatePayload>,
            )),
            response: Some((
                "SessionCreateReply",
                nession_protocol::contracts::session::v1::ClientSessionCreateResponsePayload::inline,
                schema_of::<
                    nession_protocol::contracts::session::v1::ClientSessionCreateResponsePayload,
                >,
            )),
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
            // Typed. No contract change: `WebSessionKillResponse` already
            // described this wire exactly, including `error: null` where the
            // hand-written `json!` produced it. One branch still moves — the
            // offline-agent success reply gains `error: null` — because that
            // branch omitted the field rather than the type being wrong.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionKillPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::WebSessionKillResponse>(cfg),
            ],
            request: Some((
                "SessionKillCall",
                nession_protocol::contracts::session::v1::ClientSessionKillPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionKillPayload>,
            )),
            response: Some((
                "SessionKillReply",
                nession_protocol::contracts::session::v1::WebSessionKillResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::WebSessionKillResponse>,
            )),
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
                // The reply is a union: the attach plan, or the refusal. Both
                // arms and the shared refusal type, or the generated binding
                // carries an unresolved reference.
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionAttachReply>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionAttachResponsePayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionRefusal>(cfg),
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
                nession_protocol::contracts::session::v1::ClientSessionAttachReply::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionAttachReply>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.capture-preview",
            version: 1,
            wires: &["server.session.capture-preview"],
            // Request typed; **response deliberately absent**.
            //
            // The Server's reply here is the agent's reply, forwarded. The
            // relay "depends on no concrete provider crate … routes by
            // manifest, not by knowing a payload schema"
            // (`docs/architecture/protocol.md`), so the shape on this wire
            // belongs to `agent.session.capture-preview`'s contract and is not
            // Nession's to describe from this side. `None` with that reason
            // beats the silent `None` it used to be.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionCapturePreviewPayload>(
                    cfg,
                ),
            ],
            request: Some((
                "SessionCapturePreviewCall",
                nession_protocol::contracts::session::v1::ClientSessionCapturePreviewPayload::inline,
                schema_of::<
                    nession_protocol::contracts::session::v1::ClientSessionCapturePreviewPayload,
                >,
            )),
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
            // The reply is a **refusal, and only a refusal** — the success path
            // returns `HandlerAction::Relay` and sends no message at all. Its own
            // comment says so: *"No separate response — the server enters relay
            // forwarding immediately."* So the response is `SessionRefusal`, not
            // an untagged union: there is no second branch to discriminate
            // against, and inventing one would describe a message nobody sends.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientRelayBeginPayload>(cfg),
                decl_of::<nession_protocol::contracts::session::v1::SessionRefusal>(cfg),
            ],
            request: Some((
                "ClientRelayBeginCall",
                nession_protocol::contracts::session::v1::ClientRelayBeginPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientRelayBeginPayload>,
            )),
            response: Some((
                "ClientRelayBeginReply",
                nession_protocol::contracts::session::v1::SessionRefusal::inline,
                schema_of::<nession_protocol::contracts::session::v1::SessionRefusal>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.relay.end",
            version: 1,
            wires: &["server.session.relay.end"],
            // One-way, and routed off the dispatcher: the route table's arm is a
            // bare `Ok(HandlerAction::Reply(None))` stub, because the real
            // interception happens inside the relay forwarding loop — by then the
            // connection is pumped by two `async` blocks and never returns to
            // `handle_message`. Declared here so the wire has a shape; the
            // routing lives with the loop that must see it.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientRelayEndPayload>(cfg),
            ],
            request: Some((
                "ClientRelayEndCall",
                nession_protocol::contracts::session::v1::ClientRelayEndPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientRelayEndPayload>,
            )),
            response: None,
        },
        Unit {
            owner: "core",
            id: "server.session.env.apply",
            version: 1,
            wires: &["server.session.env.apply"],
            // Typed. Two of its three replies gain `warnings: []` — the field
            // is always serialised and those branches produced none, which is
            // true rather than additive-only.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvApplyPayload>(
                    cfg,
                ),
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload>(
                    cfg,
                ),
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
                schema_of::<
                    nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload,
                >,
            )),
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
            // Typed, sharing `ClientSessionEnvResponsePayload` with `apply`.
            // Its success branch gains `warnings: []` — always serialised, and
            // there were none.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvUnsetPayload>(
                    cfg,
                ),
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload>(
                    cfg,
                ),
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
                schema_of::<
                    nession_protocol::contracts::session::v1::ClientSessionEnvResponsePayload,
                >,
            )),
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
            // It already declared the item types but neither alias, so the
            // schema said a shape existed and then named nothing.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvActivePayload>(
                    cfg,
                ),
                decl_of::<nession_protocol::contracts::session::v1::SessionEnvActiveResponse>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::ActiveEnvFile>(cfg),
                decl_of::<nession_protocol::contracts::env::v1::EnvSource>(cfg),
            ],
            request: Some((
                "SessionEnvActiveCall",
                nession_protocol::contracts::session::v1::ClientSessionEnvActivePayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionEnvActivePayload>,
            )),
            response: Some((
                "SessionEnvActiveReply",
                nession_protocol::contracts::session::v1::SessionEnvActiveResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::SessionEnvActiveResponse>,
            )),
        },
        Unit {
            owner: "core",
            id: "server.session.env.query",
            version: 1,
            wires: &["server.session.env.query"],
            // Typed. `sourced_files` is a list of *names* on this wire, not of
            // `EnvFileRef`s — the handler maps the agent's array through
            // `as_str`. Reading the branch is what said so.
            decls: vec![
                decl_of::<nession_protocol::contracts::session::v1::ClientSessionEnvQueryPayload>(
                    cfg,
                ),
                decl_of::<nession_protocol::contracts::session::v1::SessionEnvQueryResponse>(cfg),
            ],
            request: Some((
                "SessionEnvQueryCall",
                nession_protocol::contracts::session::v1::ClientSessionEnvQueryPayload::inline,
                schema_of::<nession_protocol::contracts::session::v1::ClientSessionEnvQueryPayload>,
            )),
            response: Some((
                "SessionEnvQueryReply",
                nession_protocol::contracts::session::v1::SessionEnvQueryResponse::inline,
                schema_of::<nession_protocol::contracts::session::v1::SessionEnvQueryResponse>,
            )),
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
            // One-way, and `response: None` **is** the statement: keystrokes go
            // to the pty and nothing answers them. Verified rather than
            // assumed — under one wire per operation a reply would arrive as
            // `agent.terminal.input` itself, and nothing in the tree sends one.
            // The absence used to be indistinguishable from an unfinished
            // entry, which is what this comment is for.
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
            // One-way: a size change is announced, not answered — a reply would
            // arrive as `agent.terminal.resize` itself, and none is sent. `None`
            // is the model rather than a gap.
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
        // `agent.keepalive.ping` used to be here — the one unit whose missing
        // half was a *classification* of a wire that already existed
        // (`keepalive.pong`) rather than a missing type. That was the right
        // answer to the wrong question: a ping, a pong and a heartbeat are
        // **control** wires, which are not units at all. Control has no
        // answerer and no emitter — every peer may send one and every peer must
        // handle one — so what the catalog was missing was not a response
        // shape, it was the category. `docs/architecture/protocol.md` is where
        // the three are defined, and `scripts/protocol-gate.mjs` is what holds
        // every runtime to handling all of them.
    ]
}
