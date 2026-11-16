import {
  PROTOCOL as LIST_PROTOCOL,
  VERSION as LIST_VERSION,
  WIRE as LIST_WIRE,
} from '@/generated/protocol/claude-code/list/v1';
// #3600: the Claude MCP view. Four operations, each its own contract.
import {
  PROTOCOL as MCP_CONNECT_PROTOCOL,
  VERSION as MCP_CONNECT_VERSION,
  WIRE as MCP_CONNECT_WIRE,
} from '@/generated/protocol/claude-code/mcp-connect/v1';
import {
  PROTOCOL as MCP_MUTATE_PROTOCOL,
  VERSION as MCP_MUTATE_VERSION,
  WIRE as MCP_MUTATE_WIRE,
} from '@/generated/protocol/claude-code/mcp-mutate/v1';
import {
  PROTOCOL as MCP_SERVER_PROTOCOL,
  VERSION as MCP_SERVER_VERSION,
  WIRE as MCP_SERVER_WIRE,
} from '@/generated/protocol/claude-code/mcp-server/v1';
import {
  PROTOCOL as MCP_SERVERS_PROTOCOL,
  VERSION as MCP_SERVERS_VERSION,
  WIRE as MCP_SERVERS_WIRE,
} from '@/generated/protocol/claude-code/mcp-servers/v1';
import {
  PROTOCOL as MEMORY_PROTOCOL,
  VERSION as MEMORY_VERSION,
  WIRE as MEMORY_WIRE,
} from '@/generated/protocol/claude-code/memory/v1';
import {
  PROTOCOL as MEMORY_READ_PROTOCOL,
  VERSION as MEMORY_READ_VERSION,
  WIRE as MEMORY_READ_WIRE,
} from '@/generated/protocol/claude-code/memory-read/v1';
import {
  PROTOCOL as READ_PROTOCOL,
  VERSION as READ_VERSION,
  WIRE as READ_WIRE,
} from '@/generated/protocol/claude-code/read/v1';
// `#1222`: the retired `claude-code.conversation` unit became two — the list
// (`conversations`) and one conversation's timeline (`messages`).
import {
  PROTOCOL as CONVERSATIONS_PROTOCOL,
  VERSION as CONVERSATIONS_VERSION,
  WIRE as CONVERSATIONS_WIRE,
} from '@/generated/protocol/claude-code/conversations/v1';
import {
  PROTOCOL as MESSAGES_PROTOCOL,
  VERSION as MESSAGES_VERSION,
  WIRE as MESSAGES_WIRE,
} from '@/generated/protocol/claude-code/messages/v1';
// `#1234`: the transcript projection. Its own collection, because a transcript
// is not always a session — a subagent's is listed here and deliberately not in
// the conversation list.
import {
  PROTOCOL as TRANSCRIPT_ITEMS_PROTOCOL,
  VERSION as TRANSCRIPT_ITEMS_VERSION,
  WIRE as TRANSCRIPT_ITEMS_WIRE,
} from '@/generated/protocol/claude-code/transcript-items/v1';
// #3726: raw record transport and bounded full-record access. The legacy
// `transcript-items` import above stays for the compatibility window; the
// Transcript view reads these two units instead.
import {
  PROTOCOL as TRANSCRIPT_RECORD_PROTOCOL,
  VERSION as TRANSCRIPT_RECORD_VERSION,
  WIRE as TRANSCRIPT_RECORD_WIRE,
} from '@/generated/protocol/claude-code/transcript-record/v1';
import {
  PROTOCOL as TRANSCRIPT_RECORDS_PROTOCOL,
  VERSION as TRANSCRIPT_RECORDS_VERSION,
  WIRE as TRANSCRIPT_RECORDS_WIRE,
} from '@/generated/protocol/claude-code/transcript-records/v1';
import {
  PROTOCOL as TRANSCRIPTS_PROTOCOL,
  VERSION as TRANSCRIPTS_VERSION,
  WIRE as TRANSCRIPTS_WIRE,
} from '@/generated/protocol/claude-code/transcripts/v1';
import { addressedPayload } from '@/platform/protocol';
import type { TransportPlugin, PluginSurface } from '@/platform/socket/types';
import type {
  ClaudeCodeConversationsRequest,
  ClaudeCodeConversationsResponse,
  ClaudeCodeListRequest,
  ClaudeCodeListResponse,
  ClaudeCodeMcpConnectRequest,
  ClaudeCodeMcpConnectResponse,
  ClaudeCodeMcpMutateRequest,
  ClaudeCodeMcpMutateResponse,
  ClaudeCodeMcpServerRequest,
  ClaudeCodeMcpServerResponse,
  ClaudeCodeMcpServersRequest,
  ClaudeCodeMcpServersResponse,
  ClaudeCodeMemoryReadRequest,
  ClaudeCodeMemoryReadResponse,
  ClaudeCodeMemoryRequest,
  ClaudeCodeMemoryResponse,
  ClaudeCodeMessagesRequest,
  ClaudeCodeMessagesResponse,
  ClaudeCodeReadRequest,
  ClaudeCodeReadResponse,
  ClaudeCodeTranscriptItemsRequest,
  ClaudeCodeTranscriptItemsResponse,
  ClaudeCodeTranscriptRecordRequest,
  ClaudeCodeTranscriptRecordResponse,
  ClaudeCodeTranscriptRecordsRequest,
  ClaudeCodeTranscriptRecordsResponse,
  ClaudeCodeTranscriptsRequest,
  ClaudeCodeTranscriptsResponse,
} from './types';

/**
 * The contract versions this client can read, per unit (`#678`, Phase 4).
 *
 * Both halves come from the generated bindings. Worth noting what the ids are
 * *not*: `claude-code.list`, not the `claude_code.list` the wire suffix reads
 * as. The wire spells the family with an underscore and the canonical id does
 * not — `ProtocolId` refuses them — so those two are genuinely different
 * strings, and the generated file is the only place both appear side by side.
 */
const CONSUMER_REQUIREMENTS = {
  [LIST_PROTOCOL]: [LIST_VERSION],
  [READ_PROTOCOL]: [READ_VERSION],
  [CONVERSATIONS_PROTOCOL]: [CONVERSATIONS_VERSION],
  [MESSAGES_PROTOCOL]: [MESSAGES_VERSION],
  [TRANSCRIPTS_PROTOCOL]: [TRANSCRIPTS_VERSION],
  [TRANSCRIPT_ITEMS_PROTOCOL]: [TRANSCRIPT_ITEMS_VERSION],
  [TRANSCRIPT_RECORDS_PROTOCOL]: [TRANSCRIPT_RECORDS_VERSION],
  [TRANSCRIPT_RECORD_PROTOCOL]: [TRANSCRIPT_RECORD_VERSION],
  [MEMORY_PROTOCOL]: [MEMORY_VERSION],
  [MEMORY_READ_PROTOCOL]: [MEMORY_READ_VERSION],
  [MCP_SERVERS_PROTOCOL]: [MCP_SERVERS_VERSION],
  [MCP_SERVER_PROTOCOL]: [MCP_SERVER_VERSION],
  [MCP_MUTATE_PROTOCOL]: [MCP_MUTATE_VERSION],
  [MCP_CONNECT_PROTOCOL]: [MCP_CONNECT_VERSION],
} as const satisfies Record<string, readonly number[]>;

type ClaudeCodeUnit = keyof typeof CONSUMER_REQUIREMENTS;

/**
 * claude-code capability — the Claude Code config-browser extension
 * (`claude-code.list|read`, issue #593). The request objects are
 * forwarded whole — the transport never sees individual fields. The wire
 * strings are the generated bindings, not strings written here.
 *
 * `contract_version` is added on the way past, resolved per target against what
 * that agent advertises — see the git plugin, which does the same and records
 * why the resolution is per target rather than per connection.
 */
export class ClaudeCodePlugin implements TransportPlugin {
  readonly name = 'claude-code';

  private connection: PluginSurface | null = null;
  private generation = 0;

  /**
   * Bind the plugin to a connection. A later install replaces an earlier
   * binding (same instance, new surface — StrictMode remount); the returned
   * teardown is generation-guarded so a stale release can never detach the
   * newer binding.
   */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;
    return () => {
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
    };
  }

  /** List the config files an agent can expose for a scope. */
  async claudeCodeList(req: ClaudeCodeListRequest): Promise<ClaudeCodeListResponse> {
    return this.requireConnection().request<ClaudeCodeListResponse>(
      LIST_WIRE,
      this.addressed(LIST_PROTOCOL, req.agent_id, req),
    );
  }

  /** Read a chunk of one exposed config file. */
  async claudeCodeRead(req: ClaudeCodeReadRequest): Promise<ClaudeCodeReadResponse> {
    return this.requireConnection().request<ClaudeCodeReadResponse>(
      READ_WIRE,
      this.addressed(READ_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * The Auto Memory of the repository this Session is in (#2689).
   *
   * The request names a Session and nothing else. The repository, its project
   * key and Claude Code's effective memory directory are resolved agent-side
   * from the Session's own working directory — there is no project argument to
   * pass and no picker to populate.
   */
  async claudeCodeMemory(req: ClaudeCodeMemoryRequest): Promise<ClaudeCodeMemoryResponse> {
    return this.requireConnection().request<ClaudeCodeMemoryResponse>(
      MEMORY_WIRE,
      this.addressed(MEMORY_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * One Markdown file out of that memory directory, paginated (#2689).
   *
   * `path` is relative to the directory the `memory` unit reported; the unit
   * re-resolves the root from the Session on every call, so this cannot be
   * pointed at another repository.
   */
  async claudeCodeMemoryRead(
    req: ClaudeCodeMemoryReadRequest,
  ): Promise<ClaudeCodeMemoryReadResponse> {
    return this.requireConnection().request<ClaudeCodeMemoryReadResponse>(
      MEMORY_READ_WIRE,
      this.addressed(MEMORY_READ_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * The conversations visible at one Nession Session's strict cwd, plus the
   * exact Nession↔Claude binding when one is current (#1222).
   *
   * **The list is the answer**: this unit resolves nothing — an unbound
   * session is not an ambiguity, it is a list the caller has not chosen from
   * yet. Opening one is `claudeCodeMessages`, with an explicit id.
   */
  async claudeCodeConversations(
    req: ClaudeCodeConversationsRequest,
  ): Promise<ClaudeCodeConversationsResponse> {
    return this.requireConnection().request<ClaudeCodeConversationsResponse>(
      CONVERSATIONS_WIRE,
      this.addressed(CONVERSATIONS_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * The transcripts visible at one Nession Session's strict cwd (#1234).
   *
   * The conversation list's sibling, and not a replacement for it: the same
   * upstream session is one conversation *and* one transcript, and this list
   * additionally carries the subagents that session spawned — which is why a
   * transcript item has a `kind`, a `parent_id` and an `agent_id`. Like
   * `claudeCodeConversations`, this resolves nothing; opening one names an
   * explicit id.
   */
  async claudeCodeTranscripts(
    req: ClaudeCodeTranscriptsRequest,
  ): Promise<ClaudeCodeTranscriptsResponse> {
    return this.requireConnection().request<ClaudeCodeTranscriptsResponse>(
      TRANSCRIPTS_WIRE,
      this.addressed(TRANSCRIPTS_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * One explicitly named transcript's **raw** record page (#3726).
   *
   * The provider returns physical JSONL lines and opaque references; it does
   * not classify them. `transcript_id` is the only selection mechanism, and a
   * cursor from another transcript or a replaced file answers `stale_cursor`
   * with no page.
   */
  async claudeCodeTranscriptRecords(
    req: ClaudeCodeTranscriptRecordsRequest,
  ): Promise<ClaudeCodeTranscriptRecordsResponse> {
    return this.requireConnection().request<ClaudeCodeTranscriptRecordsResponse>(
      TRANSCRIPT_RECORDS_WIRE,
      this.addressed(TRANSCRIPT_RECORDS_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * One raw record's full text, in bounded chunks (#3726).
   *
   * `record_ref` comes from a `claudeCodeTranscriptRecords` page. The same
   * reference cannot be replayed against another transcript or a replaced
   * file; those answer `not_found`/`stale_generation` with no bytes.
   */
  async claudeCodeTranscriptRecord(
    req: ClaudeCodeTranscriptRecordRequest,
  ): Promise<ClaudeCodeTranscriptRecordResponse> {
    return this.requireConnection().request<ClaudeCodeTranscriptRecordResponse>(
      TRANSCRIPT_RECORD_WIRE,
      this.addressed(TRANSCRIPT_RECORD_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * One explicitly named transcript's normalized execution timeline (#1234).
   *
   * **Legacy compatibility path.** The #3726 Transcript surface reads raw
   * records through `claudeCodeTranscriptRecords`; this method stays so a
   * client built before that migration still has a binding, and so the
   * provider's advertised unit has a named consumer while the compatibility
   * window is open.
   */
  async claudeCodeTranscriptItems(
    req: ClaudeCodeTranscriptItemsRequest,
  ): Promise<ClaudeCodeTranscriptItemsResponse> {
    return this.requireConnection().request<ClaudeCodeTranscriptItemsResponse>(
      TRANSCRIPT_ITEMS_WIRE,
      this.addressed(TRANSCRIPT_ITEMS_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * One explicitly named conversation's normalized timeline, paged (#1222).
   *
   * `conversation_id` is the only selection mechanism — an unknown id answers
   * `not_found`, never the binding, the newest, or the only conversation. A
   * follow-up page passes the previous response's `next_cursor` back as
   * `cursor`. The response's `conversation` is the full item shape, so the
   * header renders from this response alone.
   */
  async claudeCodeMessages(
    req: ClaudeCodeMessagesRequest,
  ): Promise<ClaudeCodeMessagesResponse> {
    return this.requireConnection().request<ClaudeCodeMessagesResponse>(
      MESSAGES_WIRE,
      this.addressed(MESSAGES_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * The current Session's Claude MCP inventory (#3600).
   *
   * Reads configuration only. It never runs a health check, starts a stdio
   * server or opens a discovery connection; `claudeCodeMcpServer` is the
   * explicit, separate probe.
   */
  async claudeCodeMcpServers(
    req: ClaudeCodeMcpServersRequest,
  ): Promise<ClaudeCodeMcpServersResponse> {
    return this.requireConnection().request<ClaudeCodeMcpServersResponse>(
      MCP_SERVERS_WIRE,
      this.addressed(MCP_SERVERS_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * One named MCP entry, and — only with `probe: true` — bounded capability
   * discovery. A stdio probe additionally requires `allow_stdio: true`.
   */
  async claudeCodeMcpServer(
    req: ClaudeCodeMcpServerRequest,
  ): Promise<ClaudeCodeMcpServerResponse> {
    return this.requireConnection().request<ClaudeCodeMcpServerResponse>(
      MCP_SERVER_WIRE,
      this.addressed(MCP_SERVER_PROTOCOL, req.agent_id, req),
    );
  }

  /** Add, update or remove one local/project definition (#3600). */
  async claudeCodeMcpMutate(
    req: ClaudeCodeMcpMutateRequest,
  ): Promise<ClaudeCodeMcpMutateResponse> {
    return this.requireConnection().request<ClaudeCodeMcpMutateResponse>(
      MCP_MUTATE_WIRE,
      this.addressed(MCP_MUTATE_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * Preflight or perform the Nession MCP registration (#3600).
   *
   * `confirm: false` is the preflight. The Agent re-runs the same check before
   * a confirmed write, so a stale UI cannot skip a prerequisite.
   */
  async claudeCodeMcpConnect(
    req: ClaudeCodeMcpConnectRequest,
  ): Promise<ClaudeCodeMcpConnectResponse> {
    return this.requireConnection().request<ClaudeCodeMcpConnectResponse>(
      MCP_CONNECT_WIRE,
      this.addressed(MCP_CONNECT_PROTOCOL, req.agent_id, req),
    );
  }

  /**
   * The payload to address `unit` to `agentId` with — see the git plugin.
   *
   * `req` is typed by what addressing needs from it rather than by the request
   * interface: an `interface` has no index signature, so it is not assignable
   * to the `Record<string, unknown>` the transport takes. Spreading it into a
   * fresh object literal at the call below is what widens it, and that is the
   * same `{ ...req }` the methods used before.
   */
  private addressed(
    unit: ClaudeCodeUnit,
    agentId: string,
    req: { agent_id: string },
  ): Record<string, unknown> {
    const connection = this.requireConnection();
    return addressedPayload({
      unit,
      target: agentId,
      requirements: CONSUMER_REQUIREMENTS[unit],
      protocols: connection.protocols.targetProtocols(agentId),
      payload: { ...req },
    });
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('claude-code feature is not connected');
    }
    return this.connection;
  }
}

/**
 * App-level singleton — one claude-code binding per WebSocketService lifetime.
 *
 * It lives here rather than in `index.ts` so that the capability's own UI can
 * import it without reaching back through the public barrel: `index` re-exports
 * the contribution, the contribution imports the component, and the component
 * imports this module. Defining the singleton in the barrel would close that
 * into a cycle.
 */
export const claudeCodeApi = new ClaudeCodePlugin();
