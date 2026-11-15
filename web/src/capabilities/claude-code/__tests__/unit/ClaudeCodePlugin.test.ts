import { beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodePlugin } from '@/capabilities/claude-code/ClaudeCodePlugin';
import type { ClaudeCodeMcpMutateRequest } from '@/capabilities/claude-code/types';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import type { ProtocolManifest } from '@/platform/protocol';

/**
 * What `a1` advertises.
 *
 * Every test here addresses `a1`, so the directory has to know about it — the
 * premise "there is an agent here", which a connection that has received an
 * agent list always satisfies. It used to be optional because a manifest-less
 * target was relayed unversioned; since `#963` that path throws.
 */
const AGENT_MANIFEST: ProtocolManifest = {
  provider: 'test',
  protocols: {
    'claude-code.list': { versions: [1] },
    'claude-code.read': { versions: [1] },
    // The two units #1222 replaced the retired `claude-code.conversation` with.
    // They are advertised here because `addressed()` resolves against the
    // manifest before anything is sent — an unadvertised unit would throw.
    'claude-code.conversations': { versions: [1] },
    'claude-code.messages': { versions: [1] },
    // `#1234`: the transcript projection's collection, which is where a
    // session's subagents are reachable. Advertised for the same reason.
    'claude-code.transcripts': { versions: [1] },
    'claude-code.transcript-items': { versions: [1] },
    // #3600: the four MCP operations.
    'claude-code.mcp-servers': { versions: [1] },
    'claude-code.mcp-server': { versions: [1] },
    'claude-code.mcp-mutate': { versions: [1] },
    'claude-code.mcp-connect': { versions: [1] },
  },
};

/** A surface whose agent `a1` is reachable — the premise of every test here. */
function surfaceWithAgent(): MockPluginSurface {
  const surface = createMockPluginSurface();
  surface.protocols.publish(new Map([['a1', AGENT_MANIFEST]]));
  return surface;
}

const listReq = {
  agent_id: 'a1',
  scope: 'global',
} as const;

const readReq = {
  agent_id: 'a1',
  scope: 'project',
  session_id: 'a1:work',
  path: '~/.claude/settings.json',
  offset: 0,
  limit: 2048,
} as const;

const conversationsReq = {
  agent_id: 'a1',
  session_id: 'a1:work',
  limit: 200,
} as const;

const transcriptsReq = {
  agent_id: 'a1',
  session_id: 'a1:work',
  limit: 200,
} as const;

const transcriptItemsReq = {
  agent_id: 'a1',
  session_id: 'a1:work',
  transcript_id: 's1/agent-a',
  limit: 200,
} as const;

const messagesReq = {
  agent_id: 'a1',
  session_id: 'a1:work',
  conversation_id: 'c0a1b2c3-1111-4222-8333-444455556666',
  limit: 60,
} as const;

const listResponse = {
  available: true,
  categories: [
    {
      name: 'settings',
      icon: null,
      files: [{ path: 'settings.json', size: 10, content_type: 'json' }],
    },
  ],
} as const;

describe('ClaudeCodePlugin', () => {
  let plugin: ClaudeCodePlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new ClaudeCodePlugin();
    surface = surfaceWithAgent();
  });

  it('exposes the "claude-code" capability name', () => {
    expect(plugin.name).toBe('claude-code');
  });

  describe('binding lifecycle', () => {
    it('double-mount replaces the binding; stale teardown keeps the newer binding active', async () => {
      const surfaceA = surfaceWithAgent();
      const surfaceB = surfaceWithAgent();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB); // replace semantics — no throw
      teardownA(); // stale release from the old generation

      const pending = plugin.claudeCodeList(listReq);
      expect(surfaceA.requests).toHaveLength(0);
      expect(surfaceB.requests).toHaveLength(1);
      surfaceB.resolveNext('claude-code.list', listResponse);
      await expect(pending).resolves.toEqual(listResponse);

      teardownB();
      await expect(plugin.claudeCodeList(listReq)).rejects.toThrow(
        'claude-code feature is not connected',
      );
    });

    it('teardown is idempotent', () => {
      const teardown = plugin.install(surface);
      expect(() => {
        teardown();
        teardown();
      }).not.toThrow();
    });
  });

  describe('requests', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('claudeCodeList forwards the whole request object as the payload', async () => {
      const pending = plugin.claudeCodeList(listReq);
      expect(surface.requests[0]).toMatchObject({
        type: 'claude-code.list',
        payload: listReq,
      });

      surface.resolveNext('claude-code.list', listResponse);
      await expect(pending).resolves.toEqual(listResponse);
    });

    it('claudeCodeList passes error responses through raw', async () => {
      const pending = plugin.claudeCodeList(listReq);
      surface.resolveNext('claude-code.list', {
        available: false,
        categories: [],
        error: 'agent offline',
      });
      await expect(pending).resolves.toEqual({
        available: false,
        categories: [],
        error: 'agent offline',
      });
    });

    it('claudeCodeConversations forwards the whole request object', async () => {
      const pending = plugin.claudeCodeConversations(conversationsReq);
      expect(surface.requests[0]).toMatchObject({
        type: 'claude-code.conversations',
        payload: conversationsReq,
      });

      const response = { state: 'ready', items: [], has_more: false };
      surface.resolveNext('claude-code.conversations', response);
      await expect(pending).resolves.toEqual(response);
    });

    it('claudeCodeTranscripts forwards the whole request object', async () => {
      // Its own unit since #1234: a transcript is not always a session, so this
      // list carries subagents the conversation list deliberately excludes. If
      // the request did not survive addressing, the caller would silently get
      // whichever unit answered instead.
      const pending = plugin.claudeCodeTranscripts(transcriptsReq);
      expect(surface.requests[0]).toMatchObject({
        type: 'claude-code.transcripts',
        payload: transcriptsReq,
      });

      const response = { state: 'ready', items: [], has_more: false };
      surface.resolveNext('claude-code.transcripts', response);
      await expect(pending).resolves.toEqual(response);
    });

    it('claudeCodeTranscriptItems forwards the whole request object, transcript_id included', async () => {
      // Both ids have to survive addressing: the session scopes the read and the
      // transcript names it, and this is the unit where a subagent's transcript
      // is reachable at all (#1234).
      const pending = plugin.claudeCodeTranscriptItems(transcriptItemsReq);
      expect(surface.requests[0]).toMatchObject({
        type: 'claude-code.transcript-items',
        payload: transcriptItemsReq,
      });

      const response = { state: 'ready', items: [], has_more: false, partial_tail: false };
      surface.resolveNext('claude-code.transcript-items', response);
      await expect(pending).resolves.toEqual(response);
    });

    it('claudeCodeMessages forwards the whole request object, conversation_id included', async () => {
      // The id is the unit's only selection mechanism (#1222) — if it did not
      // survive addressing intact, every read would name nothing and answer
      // `not_found`.
      const pending = plugin.claudeCodeMessages(messagesReq);
      expect(surface.requests[0]).toMatchObject({
        type: 'claude-code.messages',
        payload: messagesReq,
      });

      const response = {
        state: 'ready',
        conversation: { id: messagesReq.conversation_id, cwd: '/work' },
        activity: 'active',
        items: [],
        has_more: false,
        partial_tail: false,
        skipped: 0,
      };
      surface.resolveNext('claude-code.messages', response);
      await expect(pending).resolves.toEqual(response);
    });

    it('claudeCodeRead forwards the whole request object', async () => {
      const pending = plugin.claudeCodeRead(readReq);
      expect(surface.requests[0]).toMatchObject({
        type: 'claude-code.read',
        payload: readReq,
      });

      surface.resolveNext('claude-code.read', {
        content: '{"apiKey":"x"}',
        content_type: 'json',
        total_size: 100,
        offset: 0,
        has_more: true,
      });
      await expect(pending).resolves.toEqual({
        content: '{"apiKey":"x"}',
        content_type: 'json',
        total_size: 100,
        offset: 0,
        has_more: true,
      });
    });

    it('claudeCodeMcpServers addresses the inventory to the Session agent', async () => {
      const request = { agent_id: 'a1', session_id: 'a1:work' } as const;
      const pending = plugin.claudeCodeMcpServers(request);
      expect(surface.requests[0]).toMatchObject({
        type: 'claude-code.mcp-servers',
        payload: request,
      });
      const response = { state: 'ready', sources: [], servers: [] };
      surface.resolveNext('claude-code.mcp-servers', response);
      await expect(pending).resolves.toEqual(response);
    });

    it('claudeCodeMcpServer forwards the explicit probe and stdio consent', async () => {
      const request = {
        agent_id: 'a1',
        session_id: 'a1:work',
        name: 'github',
        scope: 'local',
        probe: true,
        allow_stdio: true,
      } as const;
      const pending = plugin.claudeCodeMcpServer(request);
      expect(surface.requests[0]).toMatchObject({
        type: 'claude-code.mcp-server',
        payload: request,
      });
      const response = { state: 'ready', probe: { status: 'ok', tools: [] } };
      surface.resolveNext('claude-code.mcp-server', response);
      await expect(pending).resolves.toEqual(response);
    });

    it('claudeCodeMcpMutate forwards the operation, scope and conflict fields', async () => {
      const request: ClaudeCodeMcpMutateRequest = {
        agent_id: 'a1',
        session_id: 'a1:work',
        operation: 'update',
        scope: 'project',
        name: 'github',
        definition: {
          name: 'github',
          transport: 'http',
          url: 'https://example.invalid/mcp',
          args: [],
          env: [],
          headers: [{ name: 'Authorization', value: null }],
          replace_env: false,
          replace_headers: false,
          replace_args: false,
        },
        expected_fingerprint: 'deadbeef',
        confirm_project_write: true,
        confirm_replace: false,
      };
      const pending = plugin.claudeCodeMcpMutate(request);
      expect(surface.requests[0]).toMatchObject({
        type: 'claude-code.mcp-mutate',
        payload: request,
      });
      surface.resolveNext('claude-code.mcp-mutate', {
        state: 'ok',
        scope: 'project',
        servers: [],
        reload_required: true,
      });
      await expect(pending).resolves.toMatchObject({ state: 'ok' });
    });

    it('claudeCodeMcpConnect carries the hosting mode and never a credential value', async () => {
      const request = {
        agent_id: 'a1',
        session_id: 'a1:work',
        mode: 'server',
        scope: 'local',
        name: 'nession',
        server_endpoint: { enabled: true, path: '/mcp' },
        confirm: false,
        confirm_project_write: false,
        confirm_replace: false,
      } as const;
      const pending = plugin.claudeCodeMcpConnect(request);
      expect(surface.requests[0]).toMatchObject({
        type: 'claude-code.mcp-connect',
        payload: request,
      });
      expect(JSON.stringify(surface.requests[0]?.payload)).not.toContain('Bearer');
      surface.resolveNext('claude-code.mcp-connect', {
        state: 'preflight',
        preflight: { mode: 'server', credential_env: 'NESSON_MCP_TOKEN', ready: false, prerequisites: [] },
        reload_required: false,
      });
      await expect(pending).resolves.toMatchObject({ state: 'preflight' });
    });
  });

  describe('unbound plugin', () => {
    it('rejects every method with "claude-code feature is not connected" and sends nothing', async () => {
      await expect(plugin.claudeCodeList(listReq)).rejects.toThrow(
        'claude-code feature is not connected',
      );
      await expect(plugin.claudeCodeRead(readReq)).rejects.toThrow(
        'claude-code feature is not connected',
      );
      await expect(plugin.claudeCodeConversations(conversationsReq)).rejects.toThrow(
        'claude-code feature is not connected',
      );
      await expect(plugin.claudeCodeMessages(messagesReq)).rejects.toThrow(
        'claude-code feature is not connected',
      );
      await expect(plugin.claudeCodeTranscripts(transcriptsReq)).rejects.toThrow(
        'claude-code feature is not connected',
      );
      await expect(plugin.claudeCodeTranscriptItems(transcriptItemsReq)).rejects.toThrow(
        'claude-code feature is not connected',
      );
      await expect(
        plugin.claudeCodeMcpServers({ agent_id: 'a1', session_id: 'a1:work' }),
      ).rejects.toThrow('claude-code feature is not connected');
      await expect(
        plugin.claudeCodeMcpServer({
          agent_id: 'a1',
          session_id: 'a1:work',
          name: 'github',
          probe: false,
          allow_stdio: false,
        }),
      ).rejects.toThrow('claude-code feature is not connected');
      await expect(
        plugin.claudeCodeMcpMutate({
          agent_id: 'a1',
          session_id: 'a1:work',
          operation: 'remove',
          scope: 'local',
          name: 'github',
          confirm_project_write: false,
          confirm_replace: false,
        }),
      ).rejects.toThrow('claude-code feature is not connected');
      await expect(
        plugin.claudeCodeMcpConnect({
          agent_id: 'a1',
          session_id: 'a1:work',
          mode: 'agent',
          scope: 'local',
          confirm: false,
          confirm_project_write: false,
          confirm_replace: false,
        }),
      ).rejects.toThrow('claude-code feature is not connected');
      expect(surface.requests).toHaveLength(0);
    });
  });
});
