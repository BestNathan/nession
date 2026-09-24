import { beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodePlugin } from '@/capabilities/claude-code/ClaudeCodePlugin';
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
  });

  describe('unbound plugin', () => {
    it('rejects every method with "claude-code feature is not connected" and sends nothing', async () => {
      await expect(plugin.claudeCodeList(listReq)).rejects.toThrow(
        'claude-code feature is not connected',
      );
      await expect(plugin.claudeCodeRead(readReq)).rejects.toThrow(
        'claude-code feature is not connected',
      );
      expect(surface.requests).toHaveLength(0);
    });
  });
});
