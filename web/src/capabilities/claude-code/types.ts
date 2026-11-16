/**
 * The claude-code capability's names for the wire types (#593).
 *
 * **Aliases, not mirrors** — see `capabilities/git/types.ts` for the argument.
 * These were hand-copied from the legacy `services/websocket/plugins/` before
 * `#678` Phase 5, and `ClaudeCodeReadResponse` shows what that cost: the wire is
 * a two-variant union (`ReadOkV1 | ReadFailureV1`), and the copy flattened it
 * into one interface with an optional `error` field. Every reader of
 * `response.content` got `undefined` on a failure with nothing to say so.
 */

// `#1222`: one retired `claude-code.conversation` unit became two — `conversations`
// owns the list and the exact binding, `messages` owns one explicitly named
// conversation's timeline. `messages` reuses `ConversationItemV1` for its
// `conversation` field, so the header a client renders comes from the response
// itself and no client-side join by id is ever needed.
import type {
  ConversationActivityV1,
  ConversationItemV1,
  ConversationsRequest,
  ConversationsResponse,
} from '@/generated/protocol/claude-code/conversations/v1';
import type {
  McpApprovalV1,
  McpHostInfoV1,
  McpInventoryStateV1,
  McpLoadStateV1,
  McpScopeV1,
  McpServerEntryV1,
  McpServersRequest,
  McpServersResponse,
  McpSourceStatusV1,
  McpTransportV1,
} from '@/generated/protocol/claude-code/mcp-servers/v1';
import type {
  McpProbeResultV1,
  McpProbeSourceV1,
  McpProbeStatusV1,
  McpServerRequest,
  McpServerResponse,
  McpToolV1,
} from '@/generated/protocol/claude-code/mcp-server/v1';
import type {
  McpDefinitionV1,
  McpKeyValueV1,
  McpMutateRequest,
  McpMutateResponse,
  McpMutationStateV1,
  McpMutationV1,
  McpWriteScopeV1,
} from '@/generated/protocol/claude-code/mcp-mutate/v1';
import type {
  McpConnectPreflightV1,
  McpConnectRequest,
  McpConnectResponse,
  McpConnectStateV1,
  McpHostingModeV1,
  McpPrerequisiteStateV1,
} from '@/generated/protocol/claude-code/mcp-connect/v1';
import type {
  MemoryFileV1,
  MemoryRepositoryKindV1,
  MemoryRequest,
  MemoryResponse,
  MemoryStateV1,
} from '@/generated/protocol/claude-code/memory/v1';
import type {
  MemoryReadRequest,
  MemoryReadResponse,
} from '@/generated/protocol/claude-code/memory-read/v1';
import type {
  MessagesRequest,
  MessagesResponse,
} from '@/generated/protocol/claude-code/messages/v1';
import type {
  ListRequest,
  ListResponse,
} from '@/generated/protocol/claude-code/list/v1';
import type {
  ReadFailureV1,
  ReadOkV1,
  ReadRequest,
  ReadResponse,
} from '@/generated/protocol/claude-code/read/v1';
import type {
  TranscriptEntryV1,
  TranscriptItemsRequest,
  TranscriptItemsResponse,
} from '@/generated/protocol/claude-code/transcript-items/v1';
import type {
  TranscriptRecordRequest,
  TranscriptRecordResponse,
} from '@/generated/protocol/claude-code/transcript-record/v1';
import type {
  TranscriptRecordV1,
  TranscriptRecordsRequest,
  TranscriptRecordsResponse,
} from '@/generated/protocol/claude-code/transcript-records/v1';
import type {
  TranscriptItemV1,
  TranscriptsRequest,
  TranscriptsResponse,
} from '@/generated/protocol/claude-code/transcripts/v1';

/**
 * Requests, with the routing field the contract does not carry — `agent_id` is
 * how the server finds the target, not part of what the target is asked.
 */
export type ClaudeCodeListRequest = ListRequest & { agent_id: string };
export type ClaudeCodeReadRequest = ReadRequest & { agent_id: string };
export type ClaudeCodeMemoryRequest = MemoryRequest & { agent_id: string };
export type ClaudeCodeMemoryReadRequest = MemoryReadRequest & { agent_id: string };
export type ClaudeCodeConversationsRequest = ConversationsRequest & { agent_id: string };
export type ClaudeCodeMessagesRequest = MessagesRequest & { agent_id: string };
export type ClaudeCodeTranscriptsRequest = TranscriptsRequest & { agent_id: string };
export type ClaudeCodeTranscriptItemsRequest = TranscriptItemsRequest & { agent_id: string };
/** `#3726`: a raw page of physical JSONL records. */
export type ClaudeCodeTranscriptRecordsRequest = TranscriptRecordsRequest & { agent_id: string };
/** `#3726`: bounded full-record access by an opaque record reference. */
export type ClaudeCodeTranscriptRecordRequest = TranscriptRecordRequest & { agent_id: string };
export type ClaudeCodeMcpServersRequest = McpServersRequest & { agent_id: string };
export type ClaudeCodeMcpServerRequest = McpServerRequest & { agent_id: string };
export type ClaudeCodeMcpMutateRequest = McpMutateRequest & { agent_id: string };
export type ClaudeCodeMcpConnectRequest = McpConnectRequest & { agent_id: string };

/** The capability's names for the responses. */
export type ClaudeCodeListResponse = ListResponse;
export type ClaudeCodeReadResponse = ReadResponse;
export type ClaudeCodeMemoryResponse = MemoryResponse;
export type ClaudeCodeMemoryReadResponse = MemoryReadResponse;
export type ClaudeCodeConversationsResponse = ConversationsResponse;
export type ClaudeCodeMessagesResponse = MessagesResponse;
export type ClaudeCodeTranscriptsResponse = TranscriptsResponse;
export type ClaudeCodeTranscriptItemsResponse = TranscriptItemsResponse;
export type ClaudeCodeTranscriptRecordsResponse = TranscriptRecordsResponse;
export type ClaudeCodeTranscriptRecordResponse = TranscriptRecordResponse;

/** The MCP units' answers (#3600). Re-exported, never mirrored. */
export type ClaudeCodeMcpServersResponse = McpServersResponse;
export type ClaudeCodeMcpServerResponse = McpServerResponse;
export type ClaudeCodeMcpMutateResponse = McpMutateResponse;
export type ClaudeCodeMcpConnectResponse = McpConnectResponse;

/** The MCP vocabulary a view switches on. */
export type ClaudeCodeMcpEntry = McpServerEntryV1;
export type ClaudeCodeMcpScope = McpScopeV1;
export type ClaudeCodeMcpTransport = McpTransportV1;
export type ClaudeCodeMcpApproval = McpApprovalV1;
export type ClaudeCodeMcpLoadState = McpLoadStateV1;
export type ClaudeCodeMcpInventoryState = McpInventoryStateV1;
export type ClaudeCodeMcpSource = McpSourceStatusV1;
export type ClaudeCodeMcpHost = McpHostInfoV1;
export type ClaudeCodeMcpProbe = McpProbeResultV1;
export type ClaudeCodeMcpProbeStatus = McpProbeStatusV1;
export type ClaudeCodeMcpProbeSource = McpProbeSourceV1;
export type ClaudeCodeMcpTool = McpToolV1;
export type ClaudeCodeMcpDefinition = McpDefinitionV1;
export type ClaudeCodeMcpKeyValue = McpKeyValueV1;
export type ClaudeCodeMcpMutation = McpMutationV1;
export type ClaudeCodeMcpMutationState = McpMutationStateV1;
export type ClaudeCodeMcpWriteScope = McpWriteScopeV1;
export type ClaudeCodeMcpHostingMode = McpHostingModeV1;
export type ClaudeCodeMcpPreflight = McpConnectPreflightV1;
export type ClaudeCodeMcpConnectState = McpConnectStateV1;
export type ClaudeCodeMcpPrerequisiteState = McpPrerequisiteStateV1;

/**
 * The two units' state names, narrowed for callers.
 *
 * Re-exported rather than written out: the union is the contract's, and a
 * hand-kept copy of it is the same mistake the `ReadResponse` mirror above
 * records — the states a client switches on must be the states the provider
 * can answer with.
 */
export type ClaudeCodeConversationsState = ConversationsResponse['state'];
export type ClaudeCodeMessagesState = MessagesResponse['state'];

/**
 * The memory unit's closed state vocabulary and file shape (#2689).
 *
 * Re-exported for the same reason the conversation states are: a hand-kept
 * copy of a union is a copy that drifts, and the view switches on every arm of
 * this one.
 */
export type ClaudeCodeMemoryState = MemoryStateV1;
export type ClaudeCodeMemoryRepositoryKind = MemoryRepositoryKindV1;
export type ClaudeCodeMemoryFile = MemoryFileV1;

/** The conversation shape both units speak, and its liveness. */
export type ClaudeCodeConversationItem = ConversationItemV1;
export type ClaudeCodeConversationActivity = ConversationActivityV1;

/**
 * A transcript, which is not always a session (#1234).
 *
 * A session's own transcript and each subagent's are the same shape, told apart
 * by `kind` — and a sidechain carries `parent_id`/`agent_id`, which is the whole
 * relation without a tree. Re-exported rather than narrowed, for the same reason
 * the states above are: a hand-kept copy of a union is a copy that drifts.
 */
export type ClaudeCodeTranscriptItem = TranscriptItemV1;

/**
 * One raw record of a transcript (#3726).
 *
 * The wire shape here is a physical JSONL line plus its opaque reference —
 * not a semantic transcript item. Decoding and rendering belong to
 * `model/transcriptRecord.ts`.
 */
export type ClaudeCodeTranscriptRecord = TranscriptRecordV1;
export type ClaudeCodeTranscriptRecordsState = TranscriptRecordsResponse['state'];

/**
 * One item of a transcript's execution timeline (#1234).
 *
 * Kept for the legacy `claude-code.transcript-items` compatibility path. The
 * #3726 Transcript surface reads raw records instead.
 */
export type ClaudeCodeTranscriptEntry = TranscriptEntryV1;

/**
 * The two halves of `claude-code.read`'s answer.
 *
 * The wire distinguishes them by *shape* — `ReadResponseV1` is `#[serde(untagged)]`,
 * so there is no discriminator to switch on and the test is `'error' in
 * response`. The hand-written mirror this replaced flattened the pair into one
 * interface with `error?: string`, which made `response.error` look like a
 * field of the success shape too, and made `response.content` look present on a
 * failure.
 */
export type ClaudeCodeReadOk = ReadOkV1;
export type ClaudeCodeReadFailure = ReadFailureV1;
