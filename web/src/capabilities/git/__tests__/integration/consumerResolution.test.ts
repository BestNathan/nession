import { beforeEach, describe, expect, it } from 'vitest';
import { GitPlugin } from '@/capabilities/git/GitPlugin';
import { AgentsPlugin } from '@/product/agent/AgentsPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import type { Agent } from '@/types';

/**
 * The two halves of `#678` Phase 4, wired through one transport.
 *
 * Split by ownership: `product/agent` is the only plugin that learns what
 * agents advertise, and `capabilities/git` is the one that has to address a
 * call to one of them. Neither may reach into the other, so the manifest
 * travels through the surface's `ProtocolDirectory` — and the property that
 * matters is that the whole chain works, not that each end works alone. Each
 * end's own tests pass with the other end missing.
 */

function agent(id: string, versions: number[] | null): Agent {
  return {
    agent_id: id,
    hostname: id,
    ip_address: '10.0.0.1',
    port: 19091,
    status: 'online',
    session_count: 1,
    last_heartbeat: '2026-01-01T00:00:00Z',
    protocols:
      versions === null
        ? null
        : { provider: id, protocols: { 'git.status': { versions } } },
  };
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

describe('consumer contract resolution end to end', () => {
  let surface: MockPluginSurface;
  let agents: AgentsPlugin;
  let git: GitPlugin;

  beforeEach(() => {
    surface = createMockPluginSurface();
    agents = new AgentsPlugin();
    git = new GitPlugin();
    agents.install(surface);
    git.install(surface);
  });

  async function listAgents(list: Agent[]): Promise<void> {
    const pending = agents.listAgents();
    surface.resolveNext('server.agent.list', { agents: list });
    await pending;
  }

  it('carries the version the agent advertised all the way to the request', async () => {
    await listAgents([agent('a1', [1])]);

    const pending = git.gitStatus({ agent_id: 'a1', session: 'a1:work' });
    expect(surface.requests[0].payload).toEqual({
      agent_id: 'a1',
      session: 'a1:work',
      contract_version: 1,
    });
    surface.resolveNext('git.status', statusResponse);
    await expect(pending).resolves.toEqual(statusResponse);
  });

  it('refuses an agent that advertises nothing, rather than relaying unversioned', async () => {
    // This was `serves an agent that advertises nothing exactly as it did
    // before #678`, and it asserted the request was byte-identical to the
    // pre-`#678` one. That *was* the Legacy Peer bypass: a target that
    // advertised nothing got a payload naming no contract version, and the
    // server relays a caller that names no version — so nothing downstream
    // could tell this apart from a negotiation that had succeeded.
    //
    // `#963` removed that path. An agent that advertises nothing cannot be
    // addressed, because there is no version to address it with.
    await listAgents([agent('a1', null)]);

    await expect(git.gitStatus({ agent_id: 'a1', session: 'a1:work' })).rejects.toThrow(
      '`a1` does not advertise `git.status`',
    );
    expect(surface.requests, 'the refused call never left').toHaveLength(0);
  });

  it('resolves each agent against its own manifest', async () => {
    await listAgents([agent('a1', [2]), agent('a2', [1])]);

    await expect(git.gitStatus({ agent_id: 'a1', session: 'a1:work' })).rejects.toThrow(
      '`a1` offers `git.status` at [v2]',
    );
    expect(surface.requests, 'the refused call never left').toHaveLength(0);

    const pending = git.gitStatus({ agent_id: 'a2', session: 'a2:work' });
    expect(surface.requests[0].payload).toMatchObject({ contract_version: 1 });
    surface.resolveNext('git.status', statusResponse);
    await expect(pending).resolves.toEqual(statusResponse);
  });

  it('stops resolving once the agent list stops listing the agent', async () => {
    // The list is a snapshot, not a growing map. An agent removed from it may
    // be gone, and resolving against the manifest it used to advertise would
    // send a versioned call to a target that no longer answers for it.
    //
    // The old assertion here was that the call went out *unversioned and still
    // worked*, which is the same bypass seen from the other side: dropping the
    // agent from the list silently downgraded the call instead of stopping it.
    // Now the agent is `unknown`, and `unknown` refuses.
    await listAgents([agent('a1', [1])]);
    await listAgents([]);

    await expect(git.gitStatus({ agent_id: 'a1', session: 'a1:work' })).rejects.toThrow(
      /`a1` is not in the protocol directory yet/,
    );
    expect(surface.requests, 'the refused call never left').toHaveLength(0);
  });
});
