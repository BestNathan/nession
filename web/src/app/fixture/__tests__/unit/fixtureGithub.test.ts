import { describe, expect, it } from 'vitest';
import { fixtureGithubSurface } from '@/app/fixture/fixtureGithub';
import { FIXTURE_AGENTS } from '@/app/fixture/fixtureData';

describe('fixture GitHub surface', () => {
  it('advertises the six units the real provider serves', () => {
    const surface = fixtureGithubSurface('');
    expect(surface.protocols.targetProtocols(FIXTURE_AGENTS[0]!.agent_id)).toMatchObject({
      kind: 'present',
      manifest: {
        protocols: {
          'github.repository': { versions: [1] },
          'github.issue-detail': { versions: [1] },
          'github.pull-requests': { versions: [1] },
        },
      },
    });
  });

  it('answers repository, list and lazy detail without N+1 body reads', async () => {
    const surface = fixtureGithubSurface('');
    const repository = await surface.request<{ state: string; resolution: string }>(
      'github.repository',
      {},
    );
    expect(repository).toMatchObject({ state: 'ok', resolution: 'resolved' });

    const list = await surface.request<{ issues: { number: number }[]; nextCursor: string | null }>(
      'github.issues',
      { state: 'all' },
    );
    expect(list.issues.map((issue) => issue.number)).toEqual([1290, 2514]);
    expect(list.nextCursor).toBe('2');

    const detail = await surface.request<{ issue: { body: string } }>('github.issue-detail', {
      number: 1290,
    });
    expect(detail.issue.body).toContain('Fixture Issue');
  });

  it('distinguishes empty, missing, unauthenticated and remote states', async () => {
    const empty = await fixtureGithubSurface('?github=empty').request<{ issues: unknown[]; hasMore: boolean }>(
      'github.issues',
      {},
    );
    expect(empty.issues).toEqual([]);
    expect(empty.hasMore).toBe(false);

    const missing = await fixtureGithubSurface('').request<{ state: string; code: string }>(
      'github.issue-detail',
      { number: 999 },
    );
    expect(missing).toMatchObject({ state: 'error', code: 'not_found' });

    const unauthenticated = await fixtureGithubSurface('?github=unauthenticated').request<{
      authenticated: boolean;
    }>('github.repository', {});
    expect(unauthenticated.authenticated).toBe(false);

    const ambiguous = await fixtureGithubSurface('?github=ambiguous').request<{
      resolution: string;
      choices: unknown[];
    }>('github.repository', {});
    expect(ambiguous.resolution).toBe('ambiguous');
    expect(ambiguous.choices.length).toBeGreaterThan(1);
  });

  it('scopes Actions runs and preserves queued/in-progress/disabled states', async () => {
    const surface = fixtureGithubSurface('');
    const repo = await surface.request<{ workflows: { state: string; latestRun?: { status: string } }[] }>(
      'github.workflows',
      { scope: 'repository' },
    );
    expect(repo.workflows.some((workflow) => workflow.state === 'disabled')).toBe(true);
    expect(repo.workflows.some((workflow) => workflow.latestRun?.status === 'queued')).toBe(true);

    const branch = await surface.request<{ branch: string; workflows: { latestRun?: { status: string; branch: string } }[] }>(
      'github.workflows',
      { scope: 'branch' },
    );
    expect(branch.branch).toBe('feature/git-github');
    expect(branch.workflows[0]?.latestRun).toMatchObject({
      status: 'in_progress',
      branch: 'feature/git-github',
    });
  });

});
