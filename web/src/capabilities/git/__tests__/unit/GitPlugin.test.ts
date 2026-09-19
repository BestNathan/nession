import { beforeEach, describe, expect, it } from 'vitest';
import { GitPlugin } from '@/capabilities/git/GitPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';

const statusReq = { agent_id: 'a1', session: 'a1:work' } as const;
const diffReq = { agent_id: 'a1', session: 'a1:work', path: 'src/a.ts' } as const;

const statusResponse = {
  state: 'ok',
  status: {
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    modified: [],
    untracked: [],
    unmerged: [],
  },
  truncated: false,
  truncatedBytes: 0,
} as const;

describe('GitPlugin', () => {
  let plugin: GitPlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new GitPlugin();
    surface = createMockPluginSurface();
  });

  it('exposes the "git" transport name', () => {
    expect(plugin.name).toBe('git');
  });

  describe('binding lifecycle', () => {
    it('double-mount replaces the binding; stale teardown keeps the newer binding active', async () => {
      const surfaceA = createMockPluginSurface();
      const surfaceB = createMockPluginSurface();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB); // replace semantics — no throw
      teardownA(); // stale release from the old generation

      const pending = plugin.gitStatus(statusReq);
      expect(surfaceA.requests).toHaveLength(0);
      expect(surfaceB.requests).toHaveLength(1);
      surfaceB.resolveNext('extension.git.status', statusResponse);
      await expect(pending).resolves.toEqual(statusResponse);

      teardownB();
      await expect(plugin.gitStatus(statusReq)).rejects.toThrow(
        'git capability is not connected',
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

    it('gitStatus forwards the whole request object as the payload', async () => {
      const pending = plugin.gitStatus(statusReq);
      expect(surface.requests[0]).toMatchObject({
        type: 'extension.git.status',
        payload: statusReq,
      });

      surface.resolveNext('extension.git.status', statusResponse);
      await expect(pending).resolves.toEqual(statusResponse);
    });

    it('gitDiff carries the agent id alongside the path it must not be able to widen', async () => {
      const pending = plugin.gitDiff(diffReq);
      expect(surface.requests[0]).toMatchObject({
        type: 'extension.git.diff',
        payload: diffReq,
      });

      surface.resolveNext('extension.git.diff', {
        state: 'ok',
        diff: { path: 'src/a.ts', text: '+x', binary: false, truncatedBytes: 0, truncated: false },
      });
      await expect(pending).resolves.toMatchObject({ state: 'ok' });
    });

    it('passes an unavailable state through raw rather than throwing', async () => {
      // "This is not a repository" is an answer, not a transport failure — a
      // plugin that rejected it would make #750 SC4's four states unreachable.
      const pending = plugin.gitStatus(statusReq);
      surface.resolveNext('extension.git.status', {
        state: 'not_a_repository',
        message: 'This Session’s working directory is not a git repository.',
      });
      await expect(pending).resolves.toEqual({
        state: 'not_a_repository',
        message: 'This Session’s working directory is not a git repository.',
      });
    });

    it('gitRoot forwards the whole request object', async () => {
      const pending = plugin.gitRoot(statusReq);
      expect(surface.requests[0]).toMatchObject({
        type: 'extension.git.root',
        payload: statusReq,
      });

      surface.resolveNext('extension.git.root', { state: 'ok', root: '/repo' });
      await expect(pending).resolves.toEqual({ state: 'ok', root: '/repo' });
    });
  });

  describe('unbound plugin', () => {
    it('rejects every method with "git capability is not connected" and sends nothing', async () => {
      await expect(plugin.gitStatus(statusReq)).rejects.toThrow(
        'git capability is not connected',
      );
      await expect(plugin.gitDiff(diffReq)).rejects.toThrow(
        'git capability is not connected',
      );
      await expect(plugin.gitRoot(statusReq)).rejects.toThrow(
        'git capability is not connected',
      );
      expect(surface.requests).toHaveLength(0);
    });
  });
});
