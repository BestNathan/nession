//! The Claude Code extension on the agent side: the erased dispatcher boundary
//! for this provider (`#678`).
//!
//! Handles `claude-code.list`, `claude-code.read`, `claude-code.conversations`
//! and `claude-code.messages`, relayed from the server via CommandBroker. Each
//! operation decodes its typed request once and answers with the contract's
//! typed response, so `Value` lives only at the dispatcher edge — the same
//! shape `nession-git` uses, for the same reason.
//!
//! ## This provider's failure vocabulary is its own
//!
//! `nession-git` answers failures as `state: unavailable | not_a_repository |
//! error`; this one answers `{ error: "access_denied" }` and
//! `{ available: false }`. Two vocabularies for one concept is a real cost —
//! the Web client branches on both — but unifying them is a wire change that
//! needs a new contract version and a client update together, so this migration
//! types what ships rather than changing it in passing.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use nession_common::extension::AgentExtension;
use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tracing::debug;

use crate::conversation;
use crate::messages;
use crate::protocol::conversations::v1::{
    ConversationActivityV1, ConversationBindingV1, ConversationItemV1, ConversationsRequestV1,
    ConversationsResponseV1, ConversationsStateV1,
};
use crate::protocol::list::{ListRequestV1, ListResponseV1};
use crate::protocol::messages::v1::{MessagesRequestV1, MessagesResponseV1, MessagesStateV1};
use crate::protocol::read::{ReadFailureV1, ReadOkV1, ReadRequestV1, ReadResponseV1, Scope};
use crate::protocol::{conversations, list, messages as messages_protocol, read};
use crate::scanner;
use crate::security;
use crate::session_context::SessionContext;

/// The one place a `Value` becomes a contract.
///
/// A malformed payload is answered rather than propagated, so the caller's
/// correlation id stays alive — a request that never gets a reply reads to the
/// UI as a hang, not an error.
fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, ReadFailureV1> {
    serde_json::from_value(payload).map_err(|e| ReadFailureV1::new(format!("bad_request: {e}")))
}

/// The Claude Code extension on the agent side.
pub struct ClaudeCodeAgentExtension {
    /// The host's session knowledge, injected at construction.
    ///
    /// Required rather than defaulted: a provider built without it cannot
    /// resolve any session, which is indistinguishable from one whose sessions
    /// have no conversations — and telling those two apart is the point of this
    /// capability (`#1005` constraint 1). A host that has to pass something
    /// cannot pass nothing by accident.
    context: Arc<dyn SessionContext>,
}

impl ClaudeCodeAgentExtension {
    pub fn new(context: Arc<dyn SessionContext>) -> Self {
        Self { context }
    }

    /// Resolve the `.claude/` directory a scope names.
    ///
    /// `None` is "there is no such directory", which both operations answer as
    /// a state rather than an error.
    async fn claude_root(&self, scope: Scope, session_id: Option<&str>) -> Option<PathBuf> {
        match scope {
            Scope::Global => security::claude_home_dir(),
            Scope::Project => self.resolve_project_claude_dir(session_id).await,
        }
    }

    async fn handle_list(&self, payload: Value) -> anyhow::Result<Value> {
        let request: ListRequestV1 = match decode(payload) {
            Ok(request) => request,
            Err(failure) => return Ok(serde_json::to_value(failure)?),
        };

        let Some(root) = self
            .claude_root(request.scope, request.session_id.as_deref())
            .await
            .filter(|dir| dir.exists())
        else {
            return Ok(serde_json::to_value(ListResponseV1::unavailable())?);
        };

        let mut categories = scanner::scan_claude_dir(&root);

        // History is only available at global scope: it lives under
        // `projects/*/`, which is a machine-wide record rather than a project's.
        if request.scope == Scope::Project {
            categories.retain(|c| c.name != "History");
        }

        Ok(serde_json::to_value(ListResponseV1::listing(categories))?)
    }

    async fn handle_read(&self, payload: Value) -> anyhow::Result<Value> {
        let request: ReadRequestV1 = match decode(payload) {
            Ok(request) => request,
            Err(failure) => return Ok(serde_json::to_value(failure)?),
        };

        Ok(serde_json::to_value(self.read(request).await)?)
    }

    /// The read itself, as a typed response.
    ///
    /// Split out from the handler so the security decisions and the pagination
    /// are readable in one place, and so the `?`-free path is obvious: every
    /// refusal here is a value the contract has a shape for.
    async fn read(&self, request: ReadRequestV1) -> ReadResponseV1 {
        if !security::is_path_allowed(&request.path) {
            return ReadResponseV1::Failed(ReadFailureV1::new("access_denied"));
        }

        let Some(root) = self
            .claude_root(request.scope, request.session_id.as_deref())
            .await
        else {
            return ReadResponseV1::Failed(ReadFailureV1::new("not_found"));
        };

        let Ok(full_path) = root.join(&request.path).canonicalize() else {
            return ReadResponseV1::Failed(ReadFailureV1::new("not_found"));
        };

        // The canonicalised path is checked against the canonicalised root, so a
        // symlink out of the tree is refused after resolution rather than before
        // it — checking the un-resolved join would miss exactly that case.
        let Ok(canonical_root) = root.canonicalize() else {
            return ReadResponseV1::Failed(ReadFailureV1::new("not_found"));
        };
        if !full_path.starts_with(&canonical_root) {
            return ReadResponseV1::Failed(ReadFailureV1::new("access_denied"));
        }

        let Ok(metadata) = std::fs::metadata(&full_path) else {
            return ReadResponseV1::Failed(ReadFailureV1::new("not_found"));
        };

        let total_size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        if total_size > security::MAX_FILE_SIZE {
            return ReadResponseV1::Failed(ReadFailureV1::file_too_large(total_size));
        }

        let Ok(content) = std::fs::read_to_string(&full_path) else {
            return ReadResponseV1::Failed(ReadFailureV1::new("binary_or_unreadable"));
        };

        // The bounds come from `chunk`, which clamps and saturates. The version
        // this replaced did `min(offset + limit, len)` on two client-supplied
        // numbers, which overflowed — see that function for what a
        // `limit: u64::MAX` used to do.
        let (start, end, has_more) = read::chunk(content.len(), request.offset, request.limit);

        ReadResponseV1::Ok(ReadOkV1 {
            // `get` rather than `[start..end]`: the range is proven ordered by
            // `chunk`, and stating it as a lookup keeps this free of the one
            // panic path a later edit could reintroduce.
            content: content.get(start..end).unwrap_or_default().to_string(),
            content_type: content_type_for(&request.path).to_string(),
            total_size,
            offset: start,
            has_more,
        })
    }

    /// Resolve the project-level `.claude/` directory from a session_id.
    ///
    /// This used to answer `None` unconditionally, with a comment saying a
    /// session's working directory was not available. **That had stopped being
    /// true**: the agent asks tmux for `#{pane_current_path}` and has for a
    /// while, which `#1005`'s background notes. The limitation was in this
    /// provider's reach, not in the host — so project scope answers `not_found`
    /// now only when the host genuinely cannot name a directory.
    async fn resolve_project_claude_dir(&self, session_id: Option<&str>) -> Option<PathBuf> {
        let cwd = self.context.session_cwd(session_id?).await?;
        Some(PathBuf::from(cwd).join(".claude"))
    }

    /// The conversation `session_id` is bound to, among those `found`.
    ///
    /// Matching is on the **transcript path**, which is the binding's strongest
    /// statement: it names the exact file Claude said this session's
    /// conversation lives in. The Claude session id would match just as well
    /// today — discovery derives it from that same file's name — but it is the
    /// weaker claim of the two, and the binding carries the path precisely so
    /// this does not have to reconstruct it.
    ///
    /// Restricting the search to `found` is what keeps a stale binding harmless.
    /// `found` is the conversations at the session's **current** cwd, so a
    /// binding written before the user changed directory simply is not in it,
    /// and the caller gets the candidate list rather than a conversation from a
    /// directory this session has left.
    async fn bound_conversation<'a>(
        &self,
        session_id: &str,
        found: &'a [conversation::Discovered],
    ) -> Option<&'a conversation::Discovered> {
        let binding = self.context.session_claude_binding(session_id).await?;
        found
            .iter()
            .find(|candidate| candidate.path() == binding.transcript_path)
    }

    /// Answer `claude-code.conversations` (#1222).
    ///
    /// **The list is the answer.** The retired unit resolved one conversation —
    /// the caller's pick, or the binding, or nothing with an `ambiguous` state —
    /// and that unit's whole failure mode was the resolving. This one reports:
    /// the conversations at the Session's strict cwd, and the exact binding
    /// when one is current. What gets opened, and whether, is the caller's
    /// decision, made through `claude-code.messages`.
    async fn handle_conversations(&self, payload: Value) -> anyhow::Result<Value> {
        let request: ConversationsRequestV1 = match serde_json::from_value(payload) {
            Ok(request) => request,
            // Answered rather than propagated, like every other decode here: a
            // request that never gets a reply reads as a hang.
            Err(e) => {
                return Ok(serde_json::to_value(ConversationsResponseV1::error(
                    format!("bad_request: {e}"),
                ))?)
            }
        };

        // No host answer means cannot-say, never a guess. `Unavailable` rather
        // than an empty list: nothing is wrong with the directory, the scope
        // itself is out of reach — and an empty list is a claim about the cwd.
        let Some(cwd) = self.context.session_cwd(&request.session_id).await else {
            return Ok(serde_json::to_value(ConversationsResponseV1::bare(
                ConversationsStateV1::Unavailable,
            ))?);
        };

        let found = conversation::conversations_at(&cwd);

        // The binding is reported only while it is exact *and current*:
        // `bound_conversation` matches it against this cwd's transcripts, so a
        // binding made before the user changed directory is simply absent —
        // reporting it anyway would point the caller at a conversation this
        // list cannot show.
        let binding = match self.bound_conversation(&request.session_id, &found).await {
            Some(bound) => Some(ConversationBindingV1 {
                conversation_id: bound.claude_session_id.clone(),
                activity: activity_of(
                    self.context
                        .session_claude_active(&request.session_id)
                        .await,
                    true,
                ),
            }),
            None => None,
        };

        let start = match &request.cursor {
            Some(raw) => match raw.parse::<usize>() {
                Ok(index) if index <= found.len() => index,
                _ => {
                    return Ok(serde_json::to_value(ConversationsResponseV1::error(
                        "cursor is not a position in this list",
                    ))?)
                }
            },
            None => 0,
        };

        let limit = ConversationsResponseV1::page_limit(request.limit) as usize;
        let items: Vec<ConversationItemV1> = found
            .iter()
            .skip(start)
            .take(limit)
            .map(conversation_item)
            .collect();
        let end = start + items.len();
        let has_more = end < found.len();

        Ok(serde_json::to_value(ConversationsResponseV1 {
            state: ConversationsStateV1::Ready,
            cwd: Some(cwd),
            items,
            binding,
            next_cursor: has_more.then(|| end.to_string()),
            has_more,
            error: None,
        })?)
    }

    /// Answer `claude-code.messages` (#1222).
    ///
    /// One explicitly named conversation, or `not_found`. **Never a
    /// substitute**: the caller named one conversation, and handing them the
    /// binding's, the newest, or the only one answers a question they did not
    /// ask — with no way for them to notice (`#1005` decision 3, made
    /// structural by `#1222`).
    async fn handle_messages(&self, payload: Value) -> anyhow::Result<Value> {
        let request: MessagesRequestV1 = match serde_json::from_value(payload) {
            Ok(request) => request,
            Err(e) => {
                return Ok(serde_json::to_value(MessagesResponseV1::error(format!(
                    "bad_request: {e}"
                )))?)
            }
        };

        let Some(cwd) = self.context.session_cwd(&request.session_id).await else {
            return Ok(serde_json::to_value(MessagesResponseV1::bare(
                MessagesStateV1::Unavailable,
            ))?);
        };

        let found = conversation::conversations_at(&cwd);
        let Some(chosen) = found
            .iter()
            .find(|c| c.claude_session_id == request.conversation_id)
            .cloned()
        else {
            // An unknown id is not an error: the conversation can have been
            // deleted, or the Session's cwd can have changed between listing
            // and selecting. It is simply not here, and nothing else stands
            // in for it.
            return Ok(serde_json::to_value(MessagesResponseV1::bare(
                MessagesStateV1::NotFound,
            ))?);
        };

        let offset = match &request.cursor {
            Some(raw) => match raw.parse::<u64>() {
                Ok(offset) => offset,
                Err(_) => {
                    return Ok(serde_json::to_value(MessagesResponseV1::error(
                        "cursor is not a position in this conversation",
                    ))?)
                }
            },
            // `u64::MAX` is "the end of the file", which `read_page` clamps —
            // how "no cursor" is expressed without a second field that could
            // disagree with the first.
            None => u64::MAX,
        };

        let limit = MessagesResponseV1::page_limit(request.limit);
        let page = match read_page_blocking(chosen.clone(), offset, limit).await {
            Ok(page) => page,
            Err(ReadFailure::Read(e)) => {
                debug!("claude-code messages read failed: {e}");
                return Ok(serde_json::to_value(MessagesResponseV1::error(
                    "the transcript could not be read",
                ))?);
            }
            Err(ReadFailure::Task(e)) => {
                debug!("claude-code messages read task failed: {e}");
                return Ok(serde_json::to_value(MessagesResponseV1::error(
                    "the transcript read did not complete",
                ))?);
            }
        };

        // Activity is a fact about this conversation relative to the Session:
        // it is live only while the Session is bound to *it* — reading the
        // conversation the binding does not name is reading a finished one,
        // whatever Claude is doing elsewhere.
        let is_bound = self
            .bound_conversation(&request.session_id, &found)
            .await
            .is_some_and(|b| b.claude_session_id == chosen.claude_session_id);
        let activity = activity_of(
            self.context
                .session_claude_active(&request.session_id)
                .await,
            is_bound,
        );

        Ok(serde_json::to_value(MessagesResponseV1 {
            state: MessagesStateV1::Ready,
            conversation: Some(conversation_item(&chosen)),
            activity: Some(activity),
            items: page.items,
            next_cursor: page.next_offset.map(|offset| offset.to_string()),
            has_more: page.has_more,
            partial_tail: page.partial_tail,
            skipped: page.skipped,
            error: None,
        })?)
    }
}

/// Why a page could not be read.
///
/// Two arms because the two failures are different sentences to a reader: the
/// file was unreadable, or the blocking task that reads it did not complete.
enum ReadFailure {
    Read(std::io::Error),
    Task(tokio::task::JoinError),
}

/// Read a page off the async worker.
///
/// Driving the reader is synchronous file I/O, and this is how every blocking
/// read in this crate is kept off the async worker. `offset` is the end of the
/// page; `u64::MAX` means "the end of the file", which `read_page` clamps.
async fn read_page_blocking(
    conversation: conversation::Discovered,
    offset: u64,
    limit: u32,
) -> Result<messages::MessagesPage, ReadFailure> {
    tokio::task::spawn_blocking(move || {
        messages::read_page(&conversation, Some(offset), limit as usize)
    })
    .await
    .map_err(ReadFailure::Task)?
    .map_err(ReadFailure::Read)
}

/// A discovered conversation as the wire item. The provider-internal
/// `claude_session_id` is the item's `id`: inside this provider's namespace the
/// longer name says nothing the shorter one does not.
fn conversation_item(c: &conversation::Discovered) -> ConversationItemV1 {
    ConversationItemV1 {
        id: c.claude_session_id.clone(),
        cwd: c.cwd.clone(),
        updated_at: c.updated_at.clone(),
        title: c.title.clone(),
        preview: c.preview.clone(),
    }
}

/// Whether a conversation is live, from the host's activity answer and whether
/// the Session is bound to it.
///
/// `active: None` is "the host cannot say", and it is reported as `Unknown`
/// rather than collapsed into either claim — presenting "we do not know" as
/// "finished" is exactly what the closed enum exists to prevent.
fn activity_of(active: Option<bool>, is_bound: bool) -> ConversationActivityV1 {
    match (active, is_bound) {
        (None, _) => ConversationActivityV1::Unknown,
        (Some(true), true) => ConversationActivityV1::Active,
        _ => ConversationActivityV1::Inactive,
    }
}

fn content_type_for(path: &str) -> &'static str {
    if path.ends_with(".json") {
        "json"
    } else if path.ends_with(".jsonl") {
        "jsonl"
    } else if path.ends_with(".md") {
        "markdown"
    } else {
        "text"
    }
}

#[async_trait]
impl AgentExtension for ClaudeCodeAgentExtension {
    fn name(&self) -> &'static str {
        "claude_code"
    }

    /// The contracts this provider offers, from the module that owns them.
    ///
    /// The registry derives its routing table from these, so there is no second
    /// list to drift: the advertised set and the routed set are the same set.
    fn descriptors(&self) -> Result<Vec<ProtocolDescriptor>, IdentityError> {
        crate::protocol::descriptors()
    }

    /// Dispatch on the **wire type**, which for this provider *is* the protocol
    /// id.
    ///
    /// The registry passes `msg_type` through verbatim — there is no namespace
    /// left to strip — so `command` here is exactly what the peer sent and
    /// exactly what the descriptor advertises. The two used to differ, as
    /// `extension.claude_code.read` against `claude-code.read`; the parent
    /// module records why the wire took the dash rather than the id taking an
    /// underscore.
    async fn handle_command(&self, command: &str, payload: Value) -> anyhow::Result<Value> {
        match command {
            list::COMMAND => self.handle_list(payload).await,
            read::COMMAND => self.handle_read(payload).await,
            conversations::COMMAND => self.handle_conversations(payload).await,
            messages_protocol::COMMAND => self.handle_messages(payload).await,
            other => anyhow::bail!("unknown claude_code command: {other}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binding::Binding;
    use crate::security::MAX_CHUNK_SIZE;
    use crate::session_context::NoSessionContext;

    #[test]
    fn the_command_the_wire_and_the_id_are_one_string() {
        // Three names that used to differ, and both differences are gone. The
        // wire carried an `extension.` namespace the registry stripped before
        // dispatching; the id spelled `claude-code` where the wire spelled
        // `claude_code`, because `ProtocolId` refuses underscores.
        //
        // So there is nothing left to translate. This provider compares.
        for (wire, command, id) in [
            (list::v1::WIRE, list::COMMAND, list::ID),
            (read::v1::WIRE, read::COMMAND, read::ID),
            (
                conversations::v1::WIRE,
                conversations::COMMAND,
                conversations::ID,
            ),
            (
                messages_protocol::v1::WIRE,
                messages_protocol::COMMAND,
                messages_protocol::ID,
            ),
        ] {
            assert_eq!(wire, command, "the dispatch key is the wire");
            assert_eq!(wire, id, "and the wire is the protocol id");
        }
    }

    #[test]
    fn the_advertised_wire_types_are_the_contracts_own() {
        // "Advertised" and "routed" are one set now — the registry derives its
        // table from these — so this asserts the set is what the contracts name.
        let advertised: Vec<String> = ClaudeCodeAgentExtension::new(Arc::new(NoSessionContext))
            .descriptors()
            .unwrap()
            .into_iter()
            .flat_map(|d| d.contracts.into_iter().flat_map(|c| c.wire))
            .collect();
        assert_eq!(
            advertised,
            vec![
                list::v1::WIRE.to_string(),
                read::v1::WIRE.to_string(),
                conversations::v1::WIRE.to_string(),
                messages_protocol::v1::WIRE.to_string(),
            ]
        );
    }

    #[test]
    fn the_protocol_ids_are_the_canonical_spelling_not_the_wire_one() {
        // `claude_code.read` is what travels; `claude-code.read` is what the
        // protocol is. Both are asserted so neither can drift into the other.
        assert_eq!(list::ID, "claude-code.list");
        assert_eq!(read::ID, "claude-code.read");
        assert_eq!(list::COMMAND, "claude-code.list");
        assert_eq!(read::COMMAND, "claude-code.read");
        assert_eq!(conversations::ID, "claude-code.conversations");
        assert_eq!(messages_protocol::ID, "claude-code.messages");
    }

    #[test]
    fn a_malformed_payload_is_answered_rather_than_propagated() {
        let failure = decode::<ReadRequestV1>(serde_json::json!({"scope": "globel"})).unwrap_err();
        let value = serde_json::to_value(ReadResponseV1::Failed(failure)).unwrap();
        assert!(
            value["error"]
                .as_str()
                .unwrap_or("")
                .starts_with("bad_request"),
            "got {value}"
        );
    }

    #[test]
    fn the_chunk_ceiling_is_what_the_bound_actually_uses() {
        // Pinned so the constant and the clamp cannot drift apart: the read path
        // calls `chunk`, which clamps to this.
        assert_eq!(read::CHUNK_CEILING, MAX_CHUNK_SIZE);
        assert_eq!(
            read::chunk(MAX_CHUNK_SIZE * 4, 0, Some(u64::MAX)).1,
            MAX_CHUNK_SIZE
        );
    }

    #[test]
    fn content_type_follows_the_extension() {
        assert_eq!(content_type_for("settings.json"), "json");
        assert_eq!(content_type_for("history.jsonl"), "jsonl");
        assert_eq!(content_type_for("CLAUDE.md"), "markdown");
        assert_eq!(content_type_for("notes.txt"), "text");
    }

    /// A host that answers from a fixed table.
    struct FixedContext {
        cwd: Option<String>,
        active: Option<bool>,
        binding: Option<Binding>,
    }

    impl FixedContext {
        /// A host that knows the cwd and nothing else — the common case here,
        /// and the one every pre-binding test wanted.
        fn at(cwd: Option<&str>) -> Self {
            Self {
                cwd: cwd.map(str::to_string),
                active: None,
                binding: None,
            }
        }

        /// The same host, with Claude having reported a binding to `transcript`.
        ///
        /// The cwd comes from the context rather than a constant so the two
        /// cannot disagree: a fixture whose binding claimed a different
        /// directory than the host was asked about would make a later test that
        /// checks the binding's cwd fail for the wrong reason.
        fn bound(mut self, transcript: &str) -> Self {
            let payload = serde_json::json!({
                "session_id": "claude-abc",
                "transcript_path": transcript,
                "cwd": self.cwd.clone().unwrap_or_default(),
                "hook_event_name": "SessionStart",
            })
            .to_string();
            self.binding =
                Some(crate::binding::parse(&payload).expect("the fixture payload binds"));
            self
        }

        /// The same host, answering the activity question with `active`.
        fn with_active(mut self, active: Option<bool>) -> Self {
            self.active = active;
            self
        }
    }

    #[async_trait]
    impl SessionContext for FixedContext {
        async fn session_cwd(&self, _session_id: &str) -> Option<String> {
            self.cwd.clone()
        }
        async fn session_claude_active(&self, _session_id: &str) -> Option<bool> {
            self.active
        }
        async fn session_claude_binding(&self, _session_id: &str) -> Option<Binding> {
            self.binding.clone()
        }
    }

    #[tokio::test]
    async fn project_scope_resolves_the_sessions_own_claude_directory() {
        // This asserted `None` unconditionally, with a comment explaining that a
        // session's working directory was unavailable. **That had stopped being
        // true** — the agent asks tmux for `#{pane_current_path}` — so the
        // assertion was pinning a limitation of this provider's reach, not a
        // decision. #1005 called it out and asks for the resolver to be reused.
        let extension =
            ClaudeCodeAgentExtension::new(Arc::new(FixedContext::at(Some("/work/project"))));
        assert_eq!(
            extension.resolve_project_claude_dir(Some("agent:s")).await,
            Some(PathBuf::from("/work/project/.claude"))
        );
    }

    #[tokio::test]
    async fn project_scope_says_nothing_when_the_host_cannot_name_a_directory() {
        // The remaining limitation, and it is the host's to answer: no session
        // id, or a host that does not know this session, resolves to nothing
        // rather than to some other tree.
        let extension = ClaudeCodeAgentExtension::new(Arc::new(NoSessionContext));
        assert_eq!(
            extension.resolve_project_claude_dir(Some("agent:s")).await,
            None
        );
        assert_eq!(extension.resolve_project_claude_dir(None).await, None);
    }

    // ---- the conversations handler -----------------------------------------

    /// A cwd no real transcript records, so the answer is about the cwd and not
    /// about whatever is on the machine running the tests.
    const CWD_WITH_NO_CONVERSATIONS: &str = "/nonexistent-cwd-for-this-test";

    fn extension_with(cwd: Option<&str>, active: Option<bool>) -> ClaudeCodeAgentExtension {
        ClaudeCodeAgentExtension::new(Arc::new(FixedContext {
            cwd: cwd.map(str::to_string),
            active,
            binding: None,
        }))
    }

    #[tokio::test]
    async fn a_conversations_request_without_a_session_is_refused() {
        // `session_id` is a required field, so its absence is a malformed
        // request — answered rather than dropped, or the caller waits forever
        // on a correlation id that will never resolve.
        let extension = extension_with(Some("/work"), None);
        let value = extension
            .handle_conversations(serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(value["state"], "error");
        assert!(
            value["error"]
                .as_str()
                .unwrap_or_default()
                .contains("session_id"),
            "the refusal must name what was missing: {value}"
        );
    }

    #[tokio::test]
    async fn a_host_that_cannot_name_the_session_answers_unavailable_not_an_empty_list() {
        // The distinction matters: an empty list would say the cwd has no
        // conversations, which is a claim about the directory. Nothing is known
        // about it — the provider cannot reach the fact at all.
        let extension = ClaudeCodeAgentExtension::new(Arc::new(NoSessionContext));
        let value = extension
            .handle_conversations(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();
        assert_eq!(value["state"], "unavailable");
    }

    #[tokio::test]
    async fn a_cwd_with_no_conversations_is_a_ready_empty_list_not_a_failure() {
        // "The provider answered and there were none" is a successful answer
        // with nothing in it — there is deliberately no `not_found` state on
        // this unit to collapse it into.
        let extension = extension_with(Some(CWD_WITH_NO_CONVERSATIONS), None);
        let value = extension
            .handle_conversations(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();
        assert_eq!(value["state"], "ready", "{value}");
        assert!(
            value["items"]
                .as_array()
                .is_none_or(std::vec::Vec::is_empty),
            "nothing to choose from: {value}"
        );
        assert_eq!(value["has_more"], false);
        assert!(
            value["binding"].is_null(),
            "nothing to be bound to: {value}"
        );
    }

    // ---- the binding is reported, never resolved for the caller -------------

    /// The cwd every binding test's transcripts record.
    const BOUND_CWD: &str = "/work/bound";

    /// A temporary `~/.claude/projects` holding one project folder with the
    /// given transcripts, each `(session id, cwd, timestamp)`.
    ///
    /// Returns the tempdir so it outlives the test, and the guard that points
    /// discovery at it — dropping the guard restores the real root.
    fn projects(
        files: &[(&str, &str, &str)],
    ) -> (tempfile::TempDir, conversation::ProjectsRootForTest) {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("-work-bound");
        std::fs::create_dir_all(&project).expect("project directory");
        for (id, cwd, timestamp) in files {
            let record = serde_json::json!({
                "type": "user",
                "uuid": "u",
                "timestamp": timestamp,
                "cwd": cwd,
                "sessionId": id,
                "message": {"role": "user", "content": "hello"},
            });
            std::fs::write(project.join(format!("{id}.jsonl")), record.to_string())
                .expect("write the transcript");
        }
        let guard = conversation::ProjectsRootForTest::set(root.path().to_path_buf());
        (root, guard)
    }

    /// Where a transcript named `id` lives inside a tree from [`projects`].
    fn transcript_path(root: &std::path::Path, id: &str) -> String {
        root.join("-work-bound")
            .join(format!("{id}.jsonl"))
            .to_string_lossy()
            .into_owned()
    }

    #[tokio::test]
    async fn a_bound_session_reports_the_binding_with_its_activity() {
        // The binding is *reported*, and the list is still the whole list —
        // this unit resolves nothing. `bbb` is newer, so this also pins that
        // the binding — not recency — is what gets named: #1005 decision 3
        // forbids the newest-wins heuristic, and a "helpful" fallback to it
        // would be invisible if the fixture agreed.
        let (root, _guard) = projects(&[
            ("aaa", BOUND_CWD, "2026-09-25T00:00:01Z"),
            ("bbb", BOUND_CWD, "2026-09-25T00:00:09Z"),
        ]);
        let extension = ClaudeCodeAgentExtension::new(Arc::new(
            FixedContext::at(Some(BOUND_CWD))
                .with_active(Some(true))
                .bound(&transcript_path(root.path(), "aaa")),
        ));

        let value = extension
            .handle_conversations(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();

        assert_eq!(value["state"], "ready", "{value}");
        assert_eq!(
            value["binding"]["conversation_id"], "aaa",
            "the exact binding is reported: {value}"
        );
        assert_eq!(value["binding"]["activity"], "active", "{value}");
        assert!(
            value["items"].as_array().is_some_and(|c| c.len() == 2),
            "the other conversation is still listed: {value}"
        );
    }

    #[tokio::test]
    async fn an_activity_the_host_cannot_answer_is_unknown_not_a_claim() {
        // `None` from the host is "cannot say", and cannot be reported as
        // either live or finished — the closed enum exists so those never
        // collapse into each other.
        let (root, _guard) = projects(&[("aaa", BOUND_CWD, "2026-09-25T00:00:01Z")]);
        let extension = ClaudeCodeAgentExtension::new(Arc::new(
            FixedContext::at(Some(BOUND_CWD)).bound(&transcript_path(root.path(), "aaa")),
        ));

        let value = extension
            .handle_conversations(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();

        assert_eq!(
            value["binding"]["activity"], "unknown",
            "cannot-say must not read as finished: {value}"
        );
    }

    #[tokio::test]
    async fn a_stale_binding_is_omitted_from_the_report() {
        // A binding outlives the directory it was made in: the user starts
        // Claude, then `cd`s. The recorded conversation is no longer among this
        // cwd's transcripts, so it is not this Session's current binding —
        // reporting it would point the caller at a conversation the list
        // cannot show.
        let (root, _guard) = projects(&[("aaa", BOUND_CWD, "2026-09-25T00:00:01Z")]);
        let elsewhere = root.path().join("-gone").join("zzz.jsonl");
        let extension = ClaudeCodeAgentExtension::new(Arc::new(
            FixedContext::at(Some(BOUND_CWD)).bound(&elsewhere.to_string_lossy()),
        ));

        let value = extension
            .handle_conversations(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();

        assert_eq!(value["state"], "ready", "{value}");
        assert!(
            value["binding"].is_null(),
            "a stale binding is no binding: {value}"
        );
        assert!(
            value["items"].as_array().is_some_and(|c| c.len() == 1),
            "the current cwd's conversation is still listed: {value}"
        );
    }

    #[tokio::test]
    async fn conversations_are_paginated_and_a_bad_cursor_is_an_error() {
        let (_root, _guard) = projects(&[
            ("aaa", BOUND_CWD, "2026-09-25T00:00:01Z"),
            ("bbb", BOUND_CWD, "2026-09-25T00:00:05Z"),
            ("ccc", BOUND_CWD, "2026-09-25T00:00:09Z"),
        ]);
        let extension = ClaudeCodeAgentExtension::new(Arc::new(FixedContext::at(Some(BOUND_CWD))));

        let first = extension
            .handle_conversations(serde_json::json!({"session_id": "agent:s", "limit": 2}))
            .await
            .unwrap();
        assert_eq!(first["items"].as_array().map(Vec::len), Some(2), "{first}");
        assert_eq!(first["has_more"], true);
        // Newest first — a listing order, not a selection.
        assert_eq!(first["items"][0]["id"], "ccc", "{first}");
        let cursor = first["next_cursor"]
            .as_str()
            .expect("a second page exists")
            .to_string();

        let second = extension
            .handle_conversations(
                serde_json::json!({"session_id": "agent:s", "limit": 2, "cursor": cursor}),
            )
            .await
            .unwrap();
        assert_eq!(
            second["items"].as_array().map(Vec::len),
            Some(1),
            "{second}"
        );
        assert_eq!(second["items"][0]["id"], "aaa", "{second}");
        assert_eq!(second["has_more"], false, "{second}");

        for bad in ["not-a-position", "9"] {
            let value = extension
                .handle_conversations(serde_json::json!({"session_id": "agent:s", "cursor": bad}))
                .await
                .unwrap();
            assert_eq!(value["state"], "error", "cursor {bad:?}: {value}");
        }
    }

    #[tokio::test]
    async fn the_binding_is_reported_even_when_it_lands_off_the_first_page() {
        // The binding is computed from the whole list, not the page: a caller
        // paging a long directory must not lose which conversation is live.
        let (root, _guard) = projects(&[
            ("aaa", BOUND_CWD, "2026-09-25T00:00:01Z"),
            ("bbb", BOUND_CWD, "2026-09-25T00:00:09Z"),
        ]);
        let extension = ClaudeCodeAgentExtension::new(Arc::new(
            FixedContext::at(Some(BOUND_CWD)).bound(&transcript_path(root.path(), "aaa")),
        ));

        let value = extension
            .handle_conversations(serde_json::json!({"session_id": "agent:s", "limit": 1}))
            .await
            .unwrap();

        assert_eq!(value["items"].as_array().map(Vec::len), Some(1), "{value}");
        assert_eq!(
            value["binding"]["conversation_id"], "aaa",
            "the binding survives pagination: {value}"
        );
    }

    #[tokio::test]
    async fn a_malformed_conversations_request_is_answered_rather_than_dropped() {
        let extension = extension_with(Some("/work"), None);
        let value = extension
            .handle_conversations(serde_json::json!({"session_id": "agent:s", "limit": "lots"}))
            .await
            .unwrap();
        assert_eq!(value["state"], "error");
        assert!(
            value["error"]
                .as_str()
                .unwrap_or_default()
                .contains("bad_request"),
            "the decode failure must say it was the request: {value}"
        );
    }

    // ---- the messages handler ------------------------------------------------

    /// A projects tree holding one transcript, written the way transcripts
    /// really are: one JSON object per line, every line newline-terminated.
    ///
    /// [`projects`] writes a single unterminated record, which is enough for
    /// discovery — that is all its callers ask about — but a reader treats an
    /// unterminated last line as a record still arriving and returns nothing for
    /// it. These tests are about what the reader *returns*, so they write the
    /// terminator.
    fn projects_with_lines(
        id: &str,
        lines: &[String],
    ) -> (tempfile::TempDir, conversation::ProjectsRootForTest) {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("-work-bound");
        std::fs::create_dir_all(&project).expect("project directory");
        let mut body = lines.join("\n");
        body.push('\n');
        std::fs::write(project.join(format!("{id}.jsonl")), body).expect("write the transcript");
        let guard = conversation::ProjectsRootForTest::set(root.path().to_path_buf());
        (root, guard)
    }

    fn spoken(uuid: &str, role: &str, text: &str) -> String {
        serde_json::json!({
            "type": role,
            "uuid": uuid,
            "timestamp": "2026-09-25T00:00:01Z",
            "cwd": BOUND_CWD,
            "sessionId": "aaa",
            "message": {"role": role, "content": text},
        })
        .to_string()
    }

    fn called(uuid: &str, call_id: &str, name: &str, input: Value) -> String {
        serde_json::json!({
            "type": "assistant",
            "uuid": uuid,
            "timestamp": "2026-09-25T00:00:02Z",
            "cwd": BOUND_CWD,
            "sessionId": "aaa",
            "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": call_id, "name": name, "input": input}
            ]},
        })
        .to_string()
    }

    fn answered(uuid: &str, call_id: &str, body: &str) -> String {
        serde_json::json!({
            "type": "user",
            "uuid": uuid,
            "timestamp": "2026-09-25T00:00:03Z",
            "cwd": BOUND_CWD,
            "sessionId": "aaa",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": call_id, "content": body}
            ]},
        })
        .to_string()
    }

    /// An extension bound to a transcript built from `lines`.
    fn bound_to(
        lines: &[String],
    ) -> (
        tempfile::TempDir,
        conversation::ProjectsRootForTest,
        ClaudeCodeAgentExtension,
    ) {
        let (root, guard) = projects_with_lines("aaa", lines);
        let extension = ClaudeCodeAgentExtension::new(Arc::new(
            FixedContext::at(Some(BOUND_CWD)).bound(&transcript_path(root.path(), "aaa")),
        ));
        (root, guard, extension)
    }

    #[tokio::test]
    async fn a_messages_request_without_either_id_is_malformed() {
        // Both ids are required fields — visibility is per-Session-cwd, and the
        // explicit id is the only selection mechanism. A request missing either
        // is not a smaller question, it is no question.
        let extension = extension_with(Some("/work"), None);

        let no_session = extension
            .handle_messages(serde_json::json!({"conversation_id": "aaa"}))
            .await
            .unwrap();
        assert_eq!(no_session["state"], "error", "{no_session}");
        assert!(
            no_session["error"]
                .as_str()
                .unwrap_or_default()
                .contains("session_id"),
            "{no_session}"
        );

        let no_conversation = extension
            .handle_messages(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();
        assert_eq!(no_conversation["state"], "error", "{no_conversation}");
        assert!(
            no_conversation["error"]
                .as_str()
                .unwrap_or_default()
                .contains("conversation_id"),
            "{no_conversation}"
        );
    }

    #[tokio::test]
    async fn a_host_that_cannot_name_the_session_answers_messages_unavailable() {
        let extension = ClaudeCodeAgentExtension::new(Arc::new(NoSessionContext));
        let value = extension
            .handle_messages(serde_json::json!({"session_id": "agent:s", "conversation_id": "aaa"}))
            .await
            .unwrap();
        assert_eq!(value["state"], "unavailable");
    }

    #[tokio::test]
    async fn an_unknown_conversation_is_not_found_and_nothing_stands_in_for_it() {
        // The substitution ban, pinned at the wire: the session is bound to
        // `aaa` and the caller asked for `nope`. `not_found` names no other
        // conversation — not the binding, not the newest, not the only one —
        // because a substituted answer is a guess the caller cannot detect.
        let (_root, _guard, extension) = bound_to(&[spoken("u1", "user", "hello")]);

        let value = extension
            .handle_messages(
                serde_json::json!({"session_id": "agent:s", "conversation_id": "nope"}),
            )
            .await
            .unwrap();

        assert_eq!(value["state"], "not_found", "{value}");
        assert!(
            value["conversation"].is_null(),
            "the binding must not be substituted: {value}"
        );
        assert!(value["items"].is_null(), "{value}");
    }

    #[tokio::test]
    async fn a_named_conversation_is_opened_with_the_full_item_shape() {
        // `conversation` is the same ConversationItem the list carries —
        // metadata included — so a client renders the header from the response
        // and never joins back against the list by id.
        let (_root, _guard, extension) = bound_to(&[spoken("u1", "user", "hello")]);

        let value = extension
            .handle_messages(serde_json::json!({"session_id": "agent:s", "conversation_id": "aaa"}))
            .await
            .unwrap();

        assert_eq!(value["state"], "ready", "{value}");
        assert_eq!(value["conversation"]["id"], "aaa", "{value}");
        assert_eq!(value["conversation"]["cwd"], BOUND_CWD, "{value}");
        assert_eq!(value["items"][0]["kind"], "message", "{value}");
        assert_eq!(value["items"][0]["role"], "user", "{value}");
        assert_eq!(value["items"][0]["content"][0]["text"], "hello", "{value}");
    }

    #[tokio::test]
    async fn reading_another_conversation_than_the_binding_is_reading_a_finished_one() {
        // Activity is a fact about *this* conversation relative to the Session,
        // not about the Session: bound to `aaa` and reading `bbb`, Claude
        // running does not make `bbb` live.
        let (root, _guard) = projects(&[
            ("aaa", BOUND_CWD, "2026-09-25T00:00:01Z"),
            ("bbb", BOUND_CWD, "2026-09-25T00:00:09Z"),
        ]);
        let extension = ClaudeCodeAgentExtension::new(Arc::new(
            FixedContext::at(Some(BOUND_CWD))
                .with_active(Some(true))
                .bound(&transcript_path(root.path(), "aaa")),
        ));

        let other = extension
            .handle_messages(serde_json::json!({"session_id": "agent:s", "conversation_id": "bbb"}))
            .await
            .unwrap();
        assert_eq!(other["state"], "ready", "{other}");
        assert_eq!(
            other["activity"], "inactive",
            "a conversation the binding does not name is not live: {other}"
        );

        let own = extension
            .handle_messages(serde_json::json!({"session_id": "agent:s", "conversation_id": "aaa"}))
            .await
            .unwrap();
        assert_eq!(own["activity"], "active", "{own}");
    }

    #[tokio::test]
    async fn an_activity_the_host_cannot_answer_is_unknown_in_the_page_too() {
        let (_root, _guard, extension) = bound_to(&[spoken("u1", "user", "hello")]);

        let value = extension
            .handle_messages(serde_json::json!({"session_id": "agent:s", "conversation_id": "aaa"}))
            .await
            .unwrap();

        assert_eq!(
            value["activity"], "unknown",
            "cannot-say must not read as finished: {value}"
        );
    }

    #[tokio::test]
    async fn a_tool_is_answered_with_its_outcome_at_the_wire() {
        // The wire-level proof of the engine's pairing: the response carries
        // one tool item with the paired result's body and status.
        let (_root, _guard, extension) = bound_to(&[
            called(
                "a1",
                "t1",
                "Bash",
                serde_json::json!({"command": "cargo test"}),
            ),
            answered("u1", "t1", "error: 1 test failed"),
        ]);

        let value = extension
            .handle_messages(serde_json::json!({"session_id": "agent:s", "conversation_id": "aaa"}))
            .await
            .unwrap();

        let tool = &value["items"][0]["tool"];
        assert_eq!(value["items"][0]["kind"], "tool", "{value}");
        assert_eq!(tool["call_id"], "t1", "{value}");
        assert_eq!(tool["summary"], "cargo test", "{value}");
        assert_eq!(
            tool["output"]["text"], "error: 1 test failed",
            "the result body is the whole point: {value}"
        );
        assert_eq!(
            tool["status"], "success",
            "a result with no `is_error` is a success, not an error: {value}"
        );
    }

    #[tokio::test]
    async fn a_bad_cursor_is_an_error_not_a_restart() {
        let (_root, _guard, extension) = bound_to(&[spoken("u1", "user", "hello")]);

        let value = extension
            .handle_messages(serde_json::json!({
                "session_id": "agent:s",
                "conversation_id": "aaa",
                "cursor": "not-a-position",
            }))
            .await
            .unwrap();
        assert_eq!(value["state"], "error", "{value}");
        assert!(
            value["error"]
                .as_str()
                .unwrap_or_default()
                .contains("cursor"),
            "{value}"
        );
    }

    #[tokio::test]
    async fn a_malformed_messages_request_is_answered_rather_than_dropped() {
        let extension = extension_with(Some("/work"), None);
        let value = extension
            .handle_messages(serde_json::json!({
                "session_id": "agent:s",
                "conversation_id": "aaa",
                "limit": "lots",
            }))
            .await
            .unwrap();
        assert_eq!(value["state"], "error");
        assert!(
            value["error"]
                .as_str()
                .unwrap_or_default()
                .contains("bad_request"),
            "the decode failure must say it was the request: {value}"
        );
    }

    #[tokio::test]
    async fn the_wire_dispatches_each_unit_to_its_own_handler() {
        // The claim `handle_command` makes: each wire names one unit and one
        // handler. Asserted on the responses' shapes differing, because a
        // dispatch test that only checked "not an error" would pass if both
        // arms ran the same handler.
        let (_root, _guard, extension) = bound_to(&[spoken("u1", "user", "hello")]);

        let listed = extension
            .handle_command(
                conversations::COMMAND,
                serde_json::json!({"session_id": "agent:s"}),
            )
            .await
            .unwrap();
        assert_eq!(listed["state"], "ready", "{listed}");
        assert!(
            listed["items"].as_array().is_some_and(|i| i.len() == 1),
            "conversations answers the list: {listed}"
        );

        let read = extension
            .handle_command(
                messages_protocol::COMMAND,
                serde_json::json!({"session_id": "agent:s", "conversation_id": "aaa"}),
            )
            .await
            .unwrap();
        assert_eq!(read["state"], "ready", "{read}");
        assert_eq!(read["conversation"]["id"], "aaa", "{read}");
        assert_eq!(read["items"][0]["kind"], "message", "{read}");
    }

    #[tokio::test]
    async fn a_path_outside_the_allowed_set_is_refused_before_anything_is_opened() {
        let extension = ClaudeCodeAgentExtension::new(Arc::new(NoSessionContext));
        let response = extension
            .read(ReadRequestV1 {
                scope: Scope::Global,
                session_id: None,
                path: "../../../etc/passwd".to_string(),
                offset: 0,
                limit: None,
            })
            .await;
        let value = serde_json::to_value(response).unwrap();
        // Either the allowlist refuses it or the root cannot be resolved; both
        // are refusals, and neither opens the file.
        assert!(
            matches!(
                value["error"].as_str(),
                Some("access_denied") | Some("not_found")
            ),
            "got {value}"
        );
    }
}
