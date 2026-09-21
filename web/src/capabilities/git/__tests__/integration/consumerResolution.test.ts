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

  it('serves an agent that advertises nothing exactly as it did before #678', async () => {
    // A Legacy Peer. The request is byte-identical to the one this client sent
    // before any of this existed, which is the design's condition for putting
    // the manifest in `agent.register` rather than requiring it.
    await listAgents([agent('a1', null)]);

    const pending = git.gitStatus({ agent_id: 'a1', session: 'a1:work' });
    expect(surface.requests[0].payload).toEqual({ agent_id: 'a1', session: 'a1:work' });
    surface.resolveNext('git.status', statusResponse);
    await expect(pending).resolves.toEqual(statusResponse);
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
    // be gone; resolving against the manifest it used to advertise would send
    // a versioned call to a target that no longer answers for it.
    await listAgents([agent('a1', [1])]);
    await listAgents([]);

    const pending = git.gitStatus({ agent_id: 'a1', session: 'a1:work' });
    expect(surface.requests[0].payload).not.toHaveProperty('contract_version');
    surface.resolveNext('git.status', statusResponse);
    await expect(pending).resolves.toEqual(statusResponse);
  });
});
