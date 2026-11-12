import { beforeEach, describe, expect, it } from 'vitest';
import { GithubPlugin } from '@/capabilities/git/GithubPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import type { ProtocolManifest } from '@/platform/protocol';

const MANIFEST: ProtocolManifest = {
  provider: 'test',
  protocols: {
    'github.repository': { versions: [1] },
    'github.issues': { versions: [1] },
    'github.issue-detail': { versions: [1] },
    'github.pull-requests': { versions: [1] },
    'github.pull-request-detail': { versions: [1] },
    'github.workflows': { versions: [1] },
  },
};

function surfaceWithAgent(): MockPluginSurface {
  const surface = createMockPluginSurface();
  surface.protocols.publish(new Map([['a1', MANIFEST]]));
  return surface;
}

const target = { agent_id: 'a1', session: 'a1:work' };

describe('GithubPlugin', () => {
  let plugin: GithubPlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new GithubPlugin();
    surface = surfaceWithAgent();
  });

  it('exposes the "github" transport name and refuses calls before binding', async () => {
    expect(plugin.name).toBe('github');
    await expect(plugin.repository(target)).rejects.toThrow('GitHub capability is not connected');
  });

  it('install replaces the previous surface and teardown is generation-guarded', async () => {
    const first = surfaceWithAgent();
    const second = surfaceWithAgent();
    const releaseFirst = plugin.install(first);
    const releaseSecond = plugin.install(second);
    releaseFirst();

    const pending = plugin.repository(target);
    expect(first.requests).toHaveLength(0);
    expect(second.requests).toHaveLength(1);
    second.resolveNext('github.repository', {
      state: 'ok',
      resolution: 'resolved',
      repository: {
        host: 'github.com',
        owner: 'acme',
        repo: 'repo',
        remote_name: 'origin',
        source_url: 'https://github.com/acme/repo',
      },
      branch: 'main',
      choices: [],
      authenticated: true,
    });
    await expect(pending).resolves.toMatchObject({ state: 'ok' });
    releaseSecond();
    await expect(plugin.repository(target)).rejects.toThrow('GitHub capability is not connected');
  });

  it('forwards each unit with the routing field and the resolved contract version', async () => {
    plugin.install(surface);
    const calls: [string, Record<string, unknown>][] = [
      ['github.repository', target],
      ['github.issues', { ...target, state: 'open' }],
      ['github.issue-detail', { ...target, number: 1290 }],
      ['github.pull-requests', { ...target, state: 'open' }],
      ['github.pull-request-detail', { ...target, number: 2229 }],
      ['github.workflows', { ...target, scope: 'branch' }],
    ];
    const methods = [
      () => plugin.repository(target),
      () => plugin.issues({ ...target, state: 'open' }),
      () => plugin.issueDetail({ ...target, number: 1290 }),
      () => plugin.pullRequests({ ...target, state: 'open' }),
      () => plugin.pullRequestDetail({ ...target, number: 2229 }),
      () => plugin.workflows({ ...target, scope: 'branch' }),
    ];
    for (let index = 0; index < calls.length; index += 1) {
      const pending = methods[index]!();
      const [type, payload] = calls[index]!;
      const last = surface.requests[surface.requests.length - 1];
      expect(last).toMatchObject({ type, payload });
      expect(last?.payload.contract_version).toBe(1);
      surface.resolveNext(type, { state: 'error', code: 'api_error', message: 'test' });
      await pending;
    }
  });
});
