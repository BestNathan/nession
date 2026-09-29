import {
  PROTOCOL as LIST_PROTOCOL,
  VERSION as LIST_VERSION,
  WIRE as LIST_WIRE,
} from '@/generated/protocol/claude-code/list/v1';
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
import { addressedPayload } from '@/platform/protocol';
import type { TransportPlugin, PluginSurface } from '@/platform/socket/types';
import type {
  ClaudeCodeConversationsRequest,
  ClaudeCodeConversationsResponse,
  ClaudeCodeListRequest,
  ClaudeCodeListResponse,
  ClaudeCodeMessagesRequest,
  ClaudeCodeMessagesResponse,
  ClaudeCodeReadRequest,
  ClaudeCodeReadResponse,
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
