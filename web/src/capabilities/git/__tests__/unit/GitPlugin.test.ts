import { beforeEach, describe, expect, it } from 'vitest';
import { GitPlugin } from '@/capabilities/git/GitPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import type { ProtocolManifest } from '@/platform/protocol';

const statusReq = { agent_id: 'a1', session: 'a1:work' } as const;
const diffReq = { agent_id: 'a1', session: 'a1:work', path: 'src/a.ts' } as const;

/**
 * What `a1` advertises.
 *
 * Every test in this file addresses `a1`, so every test needs the directory to
 * know about it. That is not new — it is what a connection that has received an
 * agent list always has — but it used to be optional, because a manifest-less
 * target was relayed unversioned and the call still worked. Since `#963` that
 * path throws, so "there is an agent here" has to be stated rather than assumed.
 */
const AGENT_MANIFEST: ProtocolManifest = {
  provider: 'test',
  protocols: {
    'git.status': { versions: [1] },
    'git.diff': { versions: [1] },
    'git.root': { versions: [1] },
    'git.log': { versions: [1] },
    'git.branches': { versions: [1] },
    'git.worktrees': { versions: [1] },
  },
};

/** A surface whose agent `a1` is reachable — the premise of every test here. */
function surfaceWithAgent(): MockPluginSurface {
  const surface = createMockPluginSurface();
  surface.protocols.publish(new Map([['a1', AGENT_MANIFEST]]));
  return surface;
}

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
    surface = surfaceWithAgent();
  });

  it('exposes the "git" transport name', () => {
    expect(plugin.name).toBe('git');
  });

  describe('binding lifecycle', () => {
    it('double-mount replaces the binding; stale teardown keeps the newer binding active', async () => {
      const surfaceA = surfaceWithAgent();
      const surfaceB = surfaceWithAgent();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB); // replace semantics — no throw
      teardownA(); // stale release from the old generation

      const pending = plugin.gitStatus(statusReq);
      expect(surfaceA.requests).toHaveLength(0);
      expect(surfaceB.requests).toHaveLength(1);
      surfaceB.resolveNext('git.status', statusResponse);
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
        type: 'git.status',
        payload: statusReq,
      });

      surface.resolveNext('git.status', statusResponse);
      await expect(pending).resolves.toEqual(statusResponse);
    });

    it('gitDiff carries the agent id alongside the path it must not be able to widen', async () => {
      const pending = plugin.gitDiff(diffReq);
      expect(surface.requests[0]).toMatchObject({
        type: 'git.diff',
        payload: diffReq,
      });

      surface.resolveNext('git.diff', {
        state: 'ok',
        diff: { path: 'src/a.ts', text: '+x', binary: false, truncatedBytes: 0, truncated: false },
      });
      await expect(pending).resolves.toMatchObject({ state: 'ok' });
    });

    it('passes an unavailable state through raw rather than throwing', async () => {
      // "This is not a repository" is an answer, not a transport failure — a
      // plugin that rejected it would make #750 SC4's four states unreachable.
      const pending = plugin.gitStatus(statusReq);
      surface.resolveNext('git.status', {
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
        type: 'git.root',
        payload: statusReq,
      });

      surface.resolveNext('git.root', { state: 'ok', root: '/repo' });
      await expect(pending).resolves.toEqual({ state: 'ok', root: '/repo' });
    });
  });

  describe('contract version resolution (#678 Phase 4)', () => {
    const v = (versions: number[]) => ({ provider: 'a1', protocols: { 'git.status': { versions } } });

    beforeEach(() => {
      plugin.install(surface);
    });

    it('names the resolved version when the target advertises one we speak', async () => {
      surface.protocols.publish(new Map([['a1', v([1, 2])]]));

      const pending = plugin.gitStatus(statusReq);
      expect(surface.requests[0].payload).toMatchObject({
        agent_id: 'a1',
        session: 'a1:work',
        contract_version: 1,
      });

      surface.resolveNext('git.status', statusResponse);
      await expect(pending).resolves.toEqual(statusResponse);
    });

    it('refuses rather than sending unversioned when the target is not in the directory', async () => {
      // This was `sends no version to a target that advertised no manifest`,
      // and it asserted the request went out byte-identical to the pre-`#678`
      // one. That assertion *was* the bypass `#963` removed: a target nobody
      // had heard from yet was addressed as though it were a peer predating
      // manifests, so a slow agent list produced a call that had negotiated
      // nothing — and the server relays a caller that names no version, so
      // nothing downstream could catch it either.
      //
      // Rewritten rather than repaired. The behaviour it pinned is gone, and a
      // test that still described it would be describing a path that no longer
      // exists.
      surface.protocols.publish(new Map());

      await expect(plugin.gitStatus(statusReq)).rejects.toThrow(
        /`a1` is not in the protocol directory yet/,
      );
      expect(surface.requests, 'nothing may reach the wire').toHaveLength(0);
    });

    it('refuses locally when the target serves only versions we cannot read', async () => {
      surface.protocols.publish(new Map([['a1', v([2])]]));

      await expect(plugin.gitStatus(statusReq)).rejects.toThrow(
        '`a1` offers `git.status` at [v2], which this client cannot read',
      );
      expect(surface.requests, 'nothing may reach the wire').toHaveLength(0);
    });

    it('refuses a target that serves a manifest without git in it', async () => {
      surface.protocols.publish(
        new Map([['a1', { provider: 'a1', protocols: { 'git.status': { versions: [1] } } }]]),
      );

      await expect(plugin.gitDiff(diffReq)).rejects.toThrow(
        '`a1` does not advertise `git.diff`',
      );
      expect(surface.requests).toHaveLength(0);
    });

    it('resolves per target, not once for the connection', async () => {
      // The rule the design states outright: the Web reaches several agents
      // through one server, and one agent's versions say nothing about
      // another's. Two agents on one surface, two different answers — a
      // connection-wide resolution would give both the same one.
      surface.protocols.publish(
        new Map([
          ['a1', v([2])],
          ['a2', v([1])],
        ]),
      );

      await expect(plugin.gitStatus(statusReq)).rejects.toThrow('`a1` offers');

      const pending = plugin.gitStatus({ agent_id: 'a2', session: 'a2:work' });
      expect(surface.requests[0].payload).toMatchObject({ contract_version: 1 });
      surface.resolveNext('git.status', statusResponse);
      await expect(pending).resolves.toEqual(statusResponse);
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
