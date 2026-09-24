//! The Claude Code extension on the agent side: the erased dispatcher boundary
//! for this provider (`#678`).
//!
//! Handles `claude_code.list` and `claude_code.read`, relayed from the server
//! via CommandBroker. Each operation decodes its typed request once and answers
//! with the contract's typed response, so `Value` lives only at the dispatcher
//! edge — the same shape `nession-git` uses, for the same reason.
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
use crate::protocol::conversation::v1::{
    ConversationCandidateV1, ConversationIdentityV1, ConversationRequestV1, ConversationResponseV1,
    ConversationStateV1,
};
use crate::protocol::list::{ListRequestV1, ListResponseV1};
use crate::protocol::read::{ReadFailureV1, ReadOkV1, ReadRequestV1, ReadResponseV1, Scope};
use crate::protocol::{conversation as conversation_protocol, list, read};
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

    /// Answer `claude-code.conversation`.
    ///
    /// ## What decides the state, and what never does
    ///
    /// The cwd comes from the host and the candidates from that cwd, matched
    /// strictly (`#1005` decision 7). A conversation is **resolved only when the
    /// caller named it**: either it came in with the request, or — with no
    /// choice made — there is nothing to open and the caller gets the list.
    ///
    /// A single candidate is deliberately *not* opened. "There is only one, so
    /// it must be the current one" is the same reasoning as "it is the newest,
    /// so it must be current", which decision 3 forbids; until an exact binding
    /// exists (stage C) the honest answer is that the current conversation has
    /// not been determined. `Ambiguous` says that, whatever the list length.
    async fn handle_conversation(&self, payload: Value) -> anyhow::Result<Value> {
        let request: ConversationRequestV1 = match serde_json::from_value(payload) {
            Ok(request) => request,
            // Answered rather than propagated, like every other decode here: a
            // request that never gets a reply reads as a hang.
            Err(e) => {
                return Ok(serde_json::to_value(ConversationResponseV1::error(
                    format!("bad_request: {e}"),
                ))?)
            }
        };

        let Some(session_id) = request.session_id.as_deref() else {
            return Ok(serde_json::to_value(ConversationResponseV1::error(
                "session_id is required: a conversation is a session's",
            ))?);
        };

        // No host answer means cannot-say, never a guess. `Unavailable` rather
        // than `NotFound`: nothing is wrong with the session, this provider just
        // cannot reach the fact.
        let Some(cwd) = self.context.session_cwd(session_id).await else {
            return Ok(serde_json::to_value(ConversationResponseV1::bare(
                ConversationStateV1::Unavailable,
            ))?);
        };

        let found = conversation::conversations_at(&cwd);
        let candidates: Vec<ConversationCandidateV1> = found
            .iter()
            .map(|c| ConversationCandidateV1 {
                claude_session_id: c.claude_session_id.clone(),
                cwd: c.cwd.clone(),
                updated_at: c.updated_at.clone(),
            })
            .collect();

        let chosen = request
            .claude_session_id
            .as_deref()
            .and_then(|id| found.iter().find(|c| c.claude_session_id == id));

        let Some(chosen) = chosen else {
            // Either nothing was asked for, or what was asked for is not at this
            // cwd — and both end at the same place: the caller must choose. An
            // unknown id is not an error, because a conversation can be deleted
            // or the session's cwd can change between listing and selecting.
            let state = if candidates.is_empty() {
                ConversationStateV1::NotFound
            } else {
                ConversationStateV1::Ambiguous
            };
            return Ok(serde_json::to_value(ConversationResponseV1 {
                candidates,
                ..ConversationResponseV1::bare(state)
            })?);
        };

        let limit = ConversationResponseV1::page_limit(request.limit);
        let offset = match request.cursor.as_deref() {
            Some(raw) => match raw.parse::<u64>() {
                Ok(offset) => Some(offset),
                Err(_) => {
                    return Ok(serde_json::to_value(ConversationResponseV1::error(
                        "cursor is not a position in this conversation",
                    ))?)
                }
            },
            None => None,
        };

        // Driving the reader is synchronous file I/O; keep it off the async
        // worker the same way every other blocking read in this crate is kept
        // off it.
        let read = {
            let conversation = chosen.clone();
            tokio::task::spawn_blocking(move || {
                conversation::read_page(&conversation, offset, limit as usize)
            })
            .await
        };

        let page = match read {
            Ok(Ok(page)) => page,
            Ok(Err(e)) => {
                debug!("claude-code conversation read failed: {e}");
                return Ok(serde_json::to_value(ConversationResponseV1::error(
                    "the transcript could not be read",
                ))?);
            }
            Err(e) => {
                debug!("claude-code conversation read task failed: {e}");
                return Ok(serde_json::to_value(ConversationResponseV1::error(
                    "the transcript read did not complete",
                ))?);
            }
        };

        // `None` from the host is "cannot say", and cannot be reported as
        // either live or finished — so the conversation is still opened, with
        // the freshness left unclaimed.
        let active = self.context.session_claude_active(session_id).await;
        let state = if active == Some(true) {
            ConversationStateV1::Ready
        } else {
            ConversationStateV1::Inactive
        };

        Ok(serde_json::to_value(ConversationResponseV1 {
            state,
            conversation: Some(ConversationIdentityV1 {
                claude_session_id: chosen.claude_session_id.clone(),
                cwd: chosen.cwd.clone(),
            }),
            candidates,
            items: page.items,
            next_cursor: page.next_offset.map(|offset| offset.to_string()),
            has_more: page.has_more,
            partial_tail: page.partial_tail,
            skipped: page.skipped,
            error: None,
        })?)
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
            conversation_protocol::COMMAND => self.handle_conversation(payload).await,
            other => anyhow::bail!("unknown claude_code command: {other}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
                conversation_protocol::v1::WIRE,
                conversation_protocol::COMMAND,
                conversation_protocol::ID,
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
                conversation_protocol::v1::WIRE.to_string(),
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
    }

    #[async_trait]
    impl SessionContext for FixedContext {
        async fn session_cwd(&self, _session_id: &str) -> Option<String> {
            self.cwd.clone()
        }
        async fn session_claude_active(&self, _session_id: &str) -> Option<bool> {
            self.active
        }
    }

    #[tokio::test]
    async fn project_scope_resolves_the_sessions_own_claude_directory() {
        // This asserted `None` unconditionally, with a comment explaining that a
        // session's working directory was unavailable. **That had stopped being
        // true** — the agent asks tmux for `#{pane_current_path}` — so the
        // assertion was pinning a limitation of this provider's reach, not a
        // decision. #1005 called it out and asks for the resolver to be reused.
        let extension = ClaudeCodeAgentExtension::new(Arc::new(FixedContext {
            cwd: Some("/work/project".to_string()),
            active: None,
        }));
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

    // ---- the conversation handler ----------------------------------------

    /// A cwd no real transcript records, so the answer is about the cwd and not
    /// about whatever is on the machine running the tests.
    const CWD_WITH_NO_CONVERSATIONS: &str = "/nonexistent-cwd-for-this-test";

    fn extension_with(cwd: Option<&str>, active: Option<bool>) -> ClaudeCodeAgentExtension {
        ClaudeCodeAgentExtension::new(Arc::new(FixedContext {
            cwd: cwd.map(str::to_string),
            active,
        }))
    }

    #[tokio::test]
    async fn a_conversation_request_without_a_session_is_refused() {
        // A conversation is a session's, so there is nothing to answer with —
        // and it is answered rather than dropped, or the caller waits forever
        // on a correlation id that will never resolve.
        let extension = extension_with(Some("/work"), None);
        let value = extension
            .handle_conversation(serde_json::json!({}))
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
    async fn a_host_that_cannot_name_the_session_answers_unavailable_not_not_found() {
        // The distinction matters: `not_found` would say the session has no
        // conversations, which is a claim about the session. Nothing is known
        // about it — the provider cannot reach the fact at all.
        let extension = ClaudeCodeAgentExtension::new(Arc::new(NoSessionContext));
        let value = extension
            .handle_conversation(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();
        assert_eq!(value["state"], "unavailable");
    }

    #[tokio::test]
    async fn a_cwd_with_no_conversations_answers_not_found_rather_than_picking_one() {
        let extension = extension_with(Some(CWD_WITH_NO_CONVERSATIONS), None);
        let value = extension
            .handle_conversation(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();
        assert_eq!(value["state"], "not_found");
        assert!(
            value["candidates"]
                .as_array()
                .is_none_or(std::vec::Vec::is_empty),
            "nothing to choose from: {value}"
        );
    }

    #[tokio::test]
    async fn a_malformed_request_is_answered_rather_than_dropped() {
        let extension = extension_with(Some("/work"), None);
        let value = extension
            .handle_conversation(serde_json::json!({"session_id": "agent:s", "limit": "lots"}))
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
