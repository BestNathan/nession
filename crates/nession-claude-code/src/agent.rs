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
use crate::conversation_v2;
use crate::protocol::conversation::v1::{
    ConversationCandidateV1, ConversationIdentityV1, ConversationRequestV1, ConversationResponseV1,
    ConversationStateV1,
};
use crate::protocol::conversation::v2::{
    ConversationCandidateV2, ConversationIdentityV2, ConversationRequestV2, ConversationResponseV2,
    ConversationStateV2,
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

    /// Answer `claude-code.conversation` at **v1**.
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

        let routed = self
            .route(
                request.session_id.as_deref(),
                request.claude_session_id.as_deref(),
                request.cursor.as_deref(),
                request.limit,
            )
            .await;

        let resolved = match routed {
            Routed::Read(resolved) => resolved,
            Routed::NoSession => {
                return Ok(serde_json::to_value(ConversationResponseV1::error(
                    "session_id is required: a conversation is a session's",
                ))?)
            }
            Routed::NoCwd => {
                return Ok(serde_json::to_value(ConversationResponseV1::bare(
                    ConversationStateV1::Unavailable,
                ))?)
            }
            Routed::BadCursor => {
                return Ok(serde_json::to_value(ConversationResponseV1::error(
                    "cursor is not a position in this conversation",
                ))?)
            }
            Routed::Pick { found, none_exist } => {
                let state = if none_exist {
                    ConversationStateV1::NotFound
                } else {
                    ConversationStateV1::Ambiguous
                };
                return Ok(serde_json::to_value(ConversationResponseV1 {
                    candidates: candidates_v1(&found),
                    ..ConversationResponseV1::bare(state)
                })?);
            }
        };
        let Resolved {
            found,
            chosen,
            requested_limit,
            offset,
            active,
        } = resolved;

        let limit = ConversationResponseV1::page_limit(requested_limit);
        let page = match read_page_blocking(chosen.clone(), offset, limit).await {
            Ok(page) => page,
            Err(ReadFailure::Read(e)) => {
                debug!("claude-code conversation read failed: {e}");
                return Ok(serde_json::to_value(ConversationResponseV1::error(
                    "the transcript could not be read",
                ))?);
            }
            Err(ReadFailure::Task(e)) => {
                debug!("claude-code conversation read task failed: {e}");
                return Ok(serde_json::to_value(ConversationResponseV1::error(
                    "the transcript read did not complete",
                ))?);
            }
        };

        Ok(serde_json::to_value(ConversationResponseV1 {
            state: state_v1(active),
            conversation: Some(ConversationIdentityV1 {
                claude_session_id: chosen.claude_session_id.clone(),
                cwd: chosen.cwd.clone(),
            }),
            candidates: candidates_v1(&found),
            items: page.items,
            next_cursor: page.next_offset.map(|offset| offset.to_string()),
            has_more: page.has_more,
            partial_tail: page.partial_tail,
            skipped: page.skipped,
            error: None,
        })?)
    }

    /// Answer `claude-code.conversation` at **v2** (#1167).
    ///
    /// Same routing, different shape. The two handlers exist rather than one
    /// generic one because the response types are genuinely different types —
    /// and because a v2 that could quietly answer with v1's shape is the
    /// failure versions exist to prevent.
    async fn handle_conversation_v2(&self, payload: Value) -> anyhow::Result<Value> {
        let request: ConversationRequestV2 = match serde_json::from_value(payload) {
            Ok(request) => request,
            Err(e) => {
                return Ok(serde_json::to_value(ConversationResponseV2::error(
                    format!("bad_request: {e}"),
                ))?)
            }
        };

        let routed = self
            .route(
                request.session_id.as_deref(),
                request.claude_session_id.as_deref(),
                request.cursor.as_deref(),
                request.limit,
            )
            .await;

        let resolved = match routed {
            Routed::Read(resolved) => resolved,
            Routed::NoSession => {
                return Ok(serde_json::to_value(ConversationResponseV2::error(
                    "session_id is required: a conversation is a session's",
                ))?)
            }
            Routed::NoCwd => {
                return Ok(serde_json::to_value(ConversationResponseV2::bare(
                    ConversationStateV2::Unavailable,
                ))?)
            }
            Routed::BadCursor => {
                return Ok(serde_json::to_value(ConversationResponseV2::error(
                    "cursor is not a position in this conversation",
                ))?)
            }
            Routed::Pick { found, none_exist } => {
                let state = if none_exist {
                    ConversationStateV2::NotFound
                } else {
                    ConversationStateV2::Ambiguous
                };
                return Ok(serde_json::to_value(ConversationResponseV2 {
                    candidates: candidates_v2(&found),
                    ..ConversationResponseV2::bare(state)
                })?);
            }
        };
        let Resolved {
            found,
            chosen,
            requested_limit,
            offset,
            active,
        } = resolved;

        let limit = ConversationResponseV2::page_limit(requested_limit);
        let page = match read_page_v2_blocking(chosen.clone(), offset, limit).await {
            Ok(page) => page,
            Err(ReadFailure::Read(e)) => {
                debug!("claude-code conversation read failed: {e}");
                return Ok(serde_json::to_value(ConversationResponseV2::error(
                    "the transcript could not be read",
                ))?);
            }
            Err(ReadFailure::Task(e)) => {
                debug!("claude-code conversation read task failed: {e}");
                return Ok(serde_json::to_value(ConversationResponseV2::error(
                    "the transcript read did not complete",
                ))?);
            }
        };

        Ok(serde_json::to_value(ConversationResponseV2 {
            state: state_v2(active),
            conversation: Some(ConversationIdentityV2 {
                claude_session_id: chosen.claude_session_id.clone(),
                cwd: chosen.cwd.clone(),
            }),
            candidates: candidates_v2(&found),
            items: page.items,
            next_cursor: page.next_offset.map(|offset| offset.to_string()),
            has_more: page.has_more,
            partial_tail: page.partial_tail,
            skipped: page.skipped,
            error: None,
        })?)
    }

    /// Everything the two generations agree on between request and response.
    ///
    /// ## What decides the state, and what never does
    ///
    /// The cwd comes from the host and the candidates from that cwd, matched
    /// strictly (`#1005` decision 7). A conversation is resolved when the caller
    /// named it, or when the session is **bound** to one; with neither, there is
    /// nothing to open and the caller gets the list.
    ///
    /// A single candidate is deliberately *not* opened. "There is only one, so
    /// it must be the current one" is the same reasoning as "it is the newest,
    /// so it must be current", which decision 3 forbids — a list of one is still
    /// a list the caller has not chosen from. `Pick` says that, whatever the
    /// list length.
    ///
    /// Shared rather than written twice because these are *decisions*, not
    /// shape: a v2 that answered a different conversation than v1 for the same
    /// request would be a bug in one of them, and two copies is how that
    /// happens. The page **size** is deliberately not resolved here — each
    /// generation clamps it with its own contract's ceiling, so the policy stays
    /// with the version that states it.
    async fn route(
        &self,
        session_id: Option<&str>,
        claude_session_id: Option<&str>,
        cursor: Option<&str>,
        requested_limit: Option<u32>,
    ) -> Routed {
        let Some(session_id) = session_id else {
            return Routed::NoSession;
        };

        // No host answer means cannot-say, never a guess. `Unavailable` rather
        // than `NotFound`: nothing is wrong with the session, this provider just
        // cannot reach the fact.
        let Some(cwd) = self.context.session_cwd(session_id).await else {
            return Routed::NoCwd;
        };

        let found = conversation::conversations_at(&cwd);

        // A conversation the caller named, or — when they named none — the one
        // this session is bound to. The two are not interchangeable and the
        // order is not an optimisation: a caller who named an id that is not
        // here must be told so, and handing them the binding's conversation
        // instead would answer a different question than the one asked.
        let chosen = match claude_session_id {
            Some(id) => found.iter().find(|c| c.claude_session_id == id),
            None => self.bound_conversation(session_id, &found).await,
        };

        let Some(chosen) = chosen.cloned() else {
            // Either nothing was asked for, or what was asked for is not at this
            // cwd — and both end at the same place: the caller must choose. An
            // unknown id is not an error, because a conversation can be deleted
            // or the session's cwd can change between listing and selecting.
            return Routed::Pick {
                none_exist: found.is_empty(),
                found,
            };
        };

        let offset = match cursor {
            Some(raw) => match raw.parse::<u64>() {
                Ok(offset) => offset,
                Err(_) => return Routed::BadCursor,
            },
            None => u64::MAX,
        };

        // `None` from the host is "cannot say", and cannot be reported as
        // either live or finished — so the conversation is still opened, with
        // the freshness left unclaimed.
        let active = self.context.session_claude_active(session_id).await;

        Routed::Read(Resolved {
            found,
            chosen,
            requested_limit,
            offset,
            active,
        })
    }
}

/// Where a conversation request routed to, before either generation answers.
///
/// The refusals are separate arms rather than pre-built responses because the
/// two generations word them into different types; keeping the *decision* here
/// and the *shape* in each handler is what stops the two from drifting.
enum Routed {
    Read(Resolved),
    NoSession,
    NoCwd,
    /// Nothing was chosen. The caller gets the candidate list.
    Pick {
        found: Vec<conversation::Discovered>,
        /// Whether there were no candidates at all, as opposed to several.
        none_exist: bool,
    },
    BadCursor,
}

/// A request that resolved to a conversation and a position in it.
struct Resolved {
    found: Vec<conversation::Discovered>,
    chosen: conversation::Discovered,
    /// As the caller asked; each generation clamps it with its own ceiling.
    requested_limit: Option<u32>,
    /// Where the page ends. `u64::MAX` is "the end of the file", which
    /// `read_page` clamps — it is how "no cursor" is expressed without adding a
    /// second field that could disagree with the first.
    offset: u64,
    active: Option<bool>,
}

/// Why a page could not be read.
///
/// Two arms because the two failures are different sentences to a reader: the
/// file was unreadable, or the blocking task that reads it did not complete.
enum ReadFailure {
    Read(std::io::Error),
    Task(tokio::task::JoinError),
}

/// Read a v1 page off the async worker.
///
/// Driving the reader is synchronous file I/O, and this is how every blocking
/// read in this crate is kept off the async worker. `offset` is the end of the
/// page; `u64::MAX` means "the end of the file", which `read_page` clamps.
async fn read_page_blocking(
    conversation: conversation::Discovered,
    offset: u64,
    limit: u32,
) -> Result<conversation::Page, ReadFailure> {
    tokio::task::spawn_blocking(move || {
        conversation::read_page(&conversation, Some(offset), limit as usize)
    })
    .await
    .map_err(ReadFailure::Task)?
    .map_err(ReadFailure::Read)
}

/// Read a v2 page off the async worker. The same, for the other generation.
async fn read_page_v2_blocking(
    conversation: conversation::Discovered,
    offset: u64,
    limit: u32,
) -> Result<conversation_v2::PageV2, ReadFailure> {
    tokio::task::spawn_blocking(move || {
        conversation_v2::read_page(&conversation, Some(offset), limit as usize)
    })
    .await
    .map_err(ReadFailure::Task)?
    .map_err(ReadFailure::Read)
}

fn candidates_v1(found: &[conversation::Discovered]) -> Vec<ConversationCandidateV1> {
    found
        .iter()
        .map(|c| ConversationCandidateV1 {
            claude_session_id: c.claude_session_id.clone(),
            cwd: c.cwd.clone(),
            updated_at: c.updated_at.clone(),
            title: c.title.clone(),
            preview: c.preview.clone(),
        })
        .collect()
}

fn candidates_v2(found: &[conversation::Discovered]) -> Vec<ConversationCandidateV2> {
    found
        .iter()
        .map(|c| ConversationCandidateV2 {
            claude_session_id: c.claude_session_id.clone(),
            cwd: c.cwd.clone(),
            updated_at: c.updated_at.clone(),
            title: c.title.clone(),
            preview: c.preview.clone(),
        })
        .collect()
}

fn state_v1(active: Option<bool>) -> ConversationStateV1 {
    if active == Some(true) {
        ConversationStateV1::Ready
    } else {
        ConversationStateV1::Inactive
    }
}

fn state_v2(active: Option<bool>) -> ConversationStateV2 {
    if active == Some(true) {
        ConversationStateV2::Ready
    } else {
        ConversationStateV2::Inactive
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
            // The unit's one wire carries two generations, so the wire alone
            // does not name a handler. The version is read from the payload —
            // where the contract puts it — rather than added to the extension
            // trait, which would answer "what does a multi-generation provider
            // API look like?" for every provider at once. The registry has
            // already refused a version this provider does not serve, so the
            // remaining arms are exactly the two below.
            conversation_protocol::COMMAND => {
                match crate::protocol::named_contract_version(&payload) {
                    conversation_protocol::v2::CONTRACT_VERSION => {
                        self.handle_conversation_v2(payload).await
                    }
                    _ => self.handle_conversation(payload).await,
                }
            }
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
        //
        // **Deduplicated**, because a unit at two generations advertises its one
        // wire twice: once per contract. That repetition is the model working
        // (`contract_version` is what tells them apart, and the wire is
        // deliberately blind to it), so the assertion is on the set — while the
        // version count below keeps it from passing on a unit that lost a
        // generation by accident.
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
                conversation_protocol::v2::WIRE.to_string(),
            ]
        );
    }

    #[test]
    fn the_conversation_unit_advertises_both_generations_on_one_wire() {
        // The claim the two identical wire strings above are making. If the
        // second one were ever a respelled wire, the list would still be the
        // right length and the gate would still pass — this is what says the
        // repetition means "v1 and v2", not "two units that happen to collide".
        let conversation = ClaudeCodeAgentExtension::new(Arc::new(NoSessionContext))
            .descriptors()
            .unwrap()
            .into_iter()
            .find(|d| d.id.as_str() == conversation_protocol::ID)
            .expect("the conversation unit is advertised");

        let versions: Vec<u32> = conversation
            .contracts
            .iter()
            .map(|c| c.version.get())
            .collect();
        assert_eq!(versions, vec![1, 2]);
        assert!(
            conversation
                .contracts
                .iter()
                .all(|c| c.wire == vec![conversation_protocol::ID.to_string()]),
            "a generation advertised on its own wire: {conversation:?}"
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

    // ---- the conversation handler ----------------------------------------

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

    // ---- the binding resolves the conversation ---------------------------

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
    async fn a_bound_session_opens_its_conversation_rather_than_asking_which() {
        // The whole point of stage C. Without a binding this is exactly the
        // `ambiguous` case — two candidates, no way to tell them apart — so
        // this test fails if the binding is not consulted, and it is the
        // failure #1005 success criterion 1 is about.
        let (root, _guard) = projects(&[
            ("aaa", BOUND_CWD, "2026-09-25T00:00:01Z"),
            ("bbb", BOUND_CWD, "2026-09-25T00:00:09Z"),
        ]);
        let extension = ClaudeCodeAgentExtension::new(Arc::new(
            FixedContext::at(Some(BOUND_CWD)).bound(&transcript_path(root.path(), "aaa")),
        ));

        let value = extension
            .handle_conversation(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();

        // `bbb` is newer, so this also pins that the binding — not recency —
        // chose: #1005 decision 3 forbids the newest-wins heuristic, and a
        // "helpful" fallback to it would be invisible if the fixture agreed.
        assert_eq!(
            value["conversation"]["claude_session_id"], "aaa",
            "the bound conversation must be the one opened: {value}"
        );
        assert_ne!(
            value["state"], "ambiguous",
            "a bound session has nothing to be ambiguous about: {value}"
        );
        assert!(
            value["candidates"].as_array().is_some_and(|c| c.len() == 2),
            "the other conversation is still offered: {value}"
        );
    }

    #[tokio::test]
    async fn a_binding_whose_transcript_is_not_here_leaves_the_question_open() {
        // A binding outlives the directory it was made in: the user starts
        // Claude, then `cd`s. The recorded conversation is no longer among this
        // cwd's candidates, so opening it would show a conversation from a
        // directory this session has left. Falling back to the list is the
        // honest answer, and `ambiguous` is what says so.
        let (root, _guard) = projects(&[("aaa", BOUND_CWD, "2026-09-25T00:00:01Z")]);
        let elsewhere = root.path().join("-gone").join("zzz.jsonl");
        let extension = ClaudeCodeAgentExtension::new(Arc::new(
            FixedContext::at(Some(BOUND_CWD)).bound(&elsewhere.to_string_lossy()),
        ));

        let value = extension
            .handle_conversation(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();

        assert_eq!(value["state"], "ambiguous", "{value}");
        assert!(
            value["conversation"].is_null(),
            "nothing was opened: {value}"
        );
    }

    #[tokio::test]
    async fn a_caller_who_named_a_conversation_is_not_handed_the_binding_instead() {
        // Selection is a request, not a suggestion. A caller who names an id
        // that is not here must be told it is not here — quietly substituting
        // the binding would answer a different question than the one asked, and
        // the caller has no way to notice.
        let (root, _guard) = projects(&[
            ("aaa", BOUND_CWD, "2026-09-25T00:00:01Z"),
            ("bbb", BOUND_CWD, "2026-09-25T00:00:09Z"),
        ]);
        let extension = ClaudeCodeAgentExtension::new(Arc::new(
            FixedContext::at(Some(BOUND_CWD)).bound(&transcript_path(root.path(), "aaa")),
        ));

        let value = extension
            .handle_conversation(
                serde_json::json!({"session_id": "agent:s", "claude_session_id": "aaa"}),
            )
            .await
            .unwrap();
        assert_eq!(
            value["conversation"]["claude_session_id"], "aaa",
            "the named conversation is the one opened: {value}"
        );

        let value = extension
            .handle_conversation(
                serde_json::json!({"session_id": "agent:s", "claude_session_id": "nope"}),
            )
            .await
            .unwrap();
        assert_eq!(
            value["state"], "ambiguous",
            "an unknown id must fall back to the list, not to the binding: {value}"
        );
        assert!(value["conversation"].is_null(), "{value}");
    }

    #[tokio::test]
    async fn a_session_with_no_binding_at_all_still_answers_with_its_candidates() {
        // The ordinary state before Claude starts, and the one the capability
        // spends most of its life in. A host that answers `None` must not turn
        // into "no conversations".
        // Both bindings are held for the whole test: the guard points discovery
        // at the tempdir, and the tempdir has to still exist when it looks.
        let (_root, _guard) = projects(&[("aaa", BOUND_CWD, "2026-09-25T00:00:01Z")]);
        let extension = ClaudeCodeAgentExtension::new(Arc::new(FixedContext::at(Some(BOUND_CWD))));

        let value = extension
            .handle_conversation(serde_json::json!({"session_id": "agent:s"}))
            .await
            .unwrap();

        assert_eq!(value["state"], "ambiguous", "{value}");
        assert!(value["candidates"].as_array().is_some_and(|c| c.len() == 1));
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

    // ---- the two generations of the conversation wire ---------------------

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
    async fn the_one_wire_dispatches_two_generations_by_the_version_in_the_payload() {
        // The claim `handle_command` makes: the wire names the unit and the
        // payload's `contract_version` picks the generation. Asserted on the two
        // shapes actually differing — v1's item carries `text`, v2's is a tagged
        // union — because a dispatch test that only checked "not an error" would
        // pass if both arms ran the same handler.
        let (_root, _guard, extension) = bound_to(&[spoken("u1", "user", "hello")]);

        let unnamed = extension
            .handle_command(
                conversation_protocol::COMMAND,
                serde_json::json!({"session_id": "agent:s"}),
            )
            .await
            .unwrap();
        let v1 = extension
            .handle_command(
                conversation_protocol::COMMAND,
                serde_json::json!({"session_id": "agent:s", "contract_version": 1}),
            )
            .await
            .unwrap();
        let v2 = extension
            .handle_command(
                conversation_protocol::COMMAND,
                serde_json::json!({"session_id": "agent:s", "contract_version": 2}),
            )
            .await
            .unwrap();

        assert_eq!(
            unnamed, v1,
            "an unversioned call is a v1 call — that is the only thing it could have meant"
        );
        assert_eq!(v1["items"][0]["text"], "hello");
        assert!(
            v1["items"][0].get("kind").and_then(|k| k.as_str()) == Some("user"),
            "v1's item kind is the speaker: {v1}"
        );

        assert_eq!(v2["items"][0]["kind"], "message");
        assert_eq!(v2["items"][0]["role"], "user");
        assert_eq!(v2["items"][0]["content"][0]["type"], "text");
        assert_eq!(v2["items"][0]["content"][0]["text"], "hello");
        assert!(
            v2["items"][0].get("text").is_none(),
            "v2 must not also carry v1's flat field: {v2}"
        );
    }

    #[tokio::test]
    async fn v2_answers_a_tool_with_its_outcome_where_v1_could_not() {
        // The reason the generation exists, asserted across both handlers on one
        // transcript: v1 renders the call and drops the result, so its `is_error`
        // is the hardcoded `false` it always was; v2 pairs them.
        let (_root, _guard, extension) = bound_to(&[
            called(
                "a1",
                "t1",
                "Bash",
                serde_json::json!({"command": "cargo test"}),
            ),
            answered("u1", "t1", "error: 1 test failed"),
        ]);

        let v1 = extension
            .handle_command(
                conversation_protocol::COMMAND,
                serde_json::json!({"session_id": "agent:s", "contract_version": 1}),
            )
            .await
            .unwrap();
        assert_eq!(v1["items"][0]["kind"], "tool");
        assert_eq!(
            v1["items"][0]["tool"]["is_error"], false,
            "v1 has no way to say otherwise: {v1}"
        );

        let v2 = extension
            .handle_command(
                conversation_protocol::COMMAND,
                serde_json::json!({"session_id": "agent:s", "contract_version": 2}),
            )
            .await
            .unwrap();
        let tool = &v2["items"][0]["tool"];
        assert_eq!(v2["items"][0]["kind"], "tool");
        assert_eq!(tool["call_id"], "t1");
        assert_eq!(tool["summary"], "cargo test");
        assert_eq!(
            tool["output"]["text"], "error: 1 test failed",
            "the result body is the whole point: {v2}"
        );
        assert_eq!(
            tool["status"], "success",
            "a result with no `is_error` is a success, not an error: {v2}"
        );
    }

    #[tokio::test]
    async fn both_generations_resolve_the_same_conversation() {
        // Routing is shared, and this is what says so from outside: the same
        // request at either version must name the same conversation. Two copies
        // of the routing is how one of them starts answering a different
        // conversation for the same question.
        let (_root, _guard, extension) = bound_to(&[spoken("u1", "user", "hello")]);

        let v1 = extension
            .handle_command(
                conversation_protocol::COMMAND,
                serde_json::json!({"session_id": "agent:s", "contract_version": 1}),
            )
            .await
            .unwrap();
        let v2 = extension
            .handle_command(
                conversation_protocol::COMMAND,
                serde_json::json!({"session_id": "agent:s", "contract_version": 2}),
            )
            .await
            .unwrap();

        assert_eq!(v1["state"], "inactive");
        assert_eq!(v2["state"], "inactive");
        assert_eq!(
            v1["conversation"]["claude_session_id"], v2["conversation"]["claude_session_id"],
            "{v1} / {v2}"
        );
        assert_eq!(v1["candidates"], v2["candidates"]);
    }

    #[tokio::test]
    async fn a_v2_refusal_is_shaped_like_v2() {
        // The refusals are worded per generation. This is the one that would be
        // easiest to miss: a shared refusal path returning a v1 body to a v2
        // caller is a shape error the client sees as a decode failure.
        let extension = extension_with(Some("/work"), None);
        let value = extension
            .handle_command(
                conversation_protocol::COMMAND,
                serde_json::json!({"contract_version": 2}),
            )
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
        // v2's response has the same envelope as v1's, so the shape is asserted
        // where the generations actually differ: nothing v1-only leaked in.
        assert!(value["items"].is_null(), "{value}");
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
