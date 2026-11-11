import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GithubHostingView } from '@/capabilities/git/components/GithubHostingView';
import { githubApi } from '@/capabilities/git/GithubPlugin';
import { fixtureGithubSurface } from '@/app/fixture/fixtureGithub';
import { FIXTURE_AGENTS } from '@/app/fixture/fixtureData';

const agentId = FIXTURE_AGENTS[0]!.agent_id;
const sessionId = `${agentId}:dev`;

let releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases) {
    release();
  }
  releases = [];
  delete (window as Window & { fixtureGithubInjected?: boolean }).fixtureGithubInjected;
});

function renderHosting(scenario = '') {
  const surface = fixtureGithubSurface(`?github=${scenario}`);
  releases.push(githubApi.install(surface));
  return render(<GithubHostingView agentId={agentId} sessionId={sessionId} />);
}

describe('GithubHostingView', () => {
  it('resolves the repository identity and renders the Issues list', async () => {
    renderHosting();
    expect(await screen.findByTestId('github-repository')).toHaveTextContent(
      'GitHub · github.com/fixture-owner/nession',
    );
    expect(await screen.findByTestId('github-issue-list')).toBeInTheDocument();
    expect(await screen.findByTestId('github-issue-row-1290')).toBeInTheDocument();
  });

  it('fetches a detail lazily, renders its Markdown safely and never injects raw HTML', async () => {
    renderHosting();
    await screen.findByTestId('github-issue-row-1290');
    const counts = (window as Window & {
      fixtureGithubRequests?: { issueDetail: number };
    }).fixtureGithubRequests;
    expect(counts?.issueDetail).toBe(0);

    await userEvent.click(screen.getByTestId('github-issue-row-1290'));
    expect(await screen.findByTestId('github-issue-detail-1290')).toBeInTheDocument();
    expect(counts?.issueDetail).toBe(1);
    expect(screen.getByTestId('github-issue-detail-1290')).toHaveTextContent('Fixture Issue');
    expect(screen.getByTestId('github-issue-detail-1290').querySelector('script')).toBeNull();
    expect((window as Window & { fixtureGithubInjected?: boolean }).fixtureGithubInjected).toBeUndefined();
    expect(screen.getByTestId('github-source-link')).toHaveAttribute(
      'href',
      'https://github.com/fixture-owner/nession/issues/1290',
    );
  });

  it('preserves the list when a detail opens, and Back restores it with the selection intact', async () => {
    renderHosting();
    await screen.findByTestId('github-issue-row-1290');
    await userEvent.click(screen.getByTestId('github-issue-row-1290'));
    await screen.findByTestId('github-issue-detail-1290');

    const focus = screen.getByTestId('github-focus-reading');
    expect(focus).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(focus);
    expect(screen.getByTestId('github-focus-reading')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByTestId('github-back-to-list'));
    expect(screen.getByTestId('github-issue-row-1290')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('github-issue-detail-1290')).toBeInTheDocument();
  });

  it('filters Issues, searches the loaded page and pages with an explicit continuation', async () => {
    renderHosting();
    await screen.findByTestId('github-issue-row-1290');

    await userEvent.click(screen.getByTestId('github-filter-all'));
    await screen.findByTestId('github-issue-row-2514');
    await userEvent.click(await screen.findByTestId('github-issues-load-more'));
    expect(await screen.findByTestId('github-issue-row-2323')).toBeInTheDocument();

    const search = screen.getByTestId('github-issues-search');
    await userEvent.type(search, 'session');
    expect(screen.queryByTestId('github-issue-row-1290')).toBeNull();
    expect(screen.getByTestId('github-issue-row-2514')).toBeInTheDocument();
  });

  it('shows a typed empty state rather than an empty repository', async () => {
    renderHosting('empty');
    expect(await screen.findByTestId('github-issues-empty')).toHaveTextContent(
      'No Issues in this filter.',
    );
  });

  it('shows not-authenticated, ambiguous-remote and no-remote explanations', async () => {
    const { unmount } = renderHosting('unauthenticated');
    expect(await screen.findByTestId('github-auth-unavailable')).toHaveTextContent(
      'GITHUB_TOKEN',
    );
    unmount();
    releases.pop()?.();

    renderHosting('ambiguous');
    expect(await screen.findByTestId('github-ambiguous-remote')).toBeInTheDocument();
    expect(screen.getByTestId('github-remote-choice-upstream')).toBeInTheDocument();
    releases.pop()?.();

    renderHosting('no-remote');
    expect(await screen.findByTestId('github-no-remote')).toHaveTextContent(
      'Local Repository remains available',
    );
  });

  it('renders a rate-limit error with its retry hint', async () => {
    renderHosting('rate-limited');
    expect(await screen.findByTestId('github-repository-error')).toHaveTextContent(
      'Retry after 30s',
    );
  });

  it('renders Pull Requests with the exact current-branch relation and lazy detail', async () => {
    renderHosting();
    await userEvent.click(await screen.findByTestId('github-tab-pull-requests'));
    expect(await screen.findByTestId('github-pr-relation')).toHaveTextContent(
      'Current branch · PR #2229',
    );
    await userEvent.click(screen.getByTestId('github-pr-row-2229'));
    const detail = await screen.findByTestId('github-pr-detail-2229');
    expect(detail).toHaveTextContent('fixture-owner:feature/git-github');
    expect(detail).toHaveTextContent('→ main');
    expect(screen.getByTestId('github-pr-detail-2229')).toHaveTextContent('read-only');
  });

  it('scopes Actions to repository or current branch and preserves run states', async () => {
    renderHosting();
    await userEvent.click(await screen.findByTestId('github-tab-actions'));
    expect(await screen.findByTestId('github-workflow-1')).toBeInTheDocument();
    expect(screen.getByTestId('github-workflow-status-1')).toHaveTextContent('Completed · success');
    expect(screen.getByTestId('github-workflow-status-2')).toHaveTextContent('Queued');
    expect(screen.getByTestId('github-workflow-status-3')).toHaveTextContent('Disabled');

    await userEvent.click(screen.getByTestId('github-actions-scope-branch'));
    await waitFor(() =>
      expect(screen.getByTestId('github-actions-scope-label')).toHaveTextContent(
        'Latest run per workflow · feature/git-github',
      ),
    );
    expect(screen.getByTestId('github-workflow-status-1')).toHaveTextContent('In progress');
  });

  it('offers no mutation controls anywhere in the GitHub depths', async () => {
    renderHosting();
    await screen.findByTestId('github-issue-row-1290');
    await userEvent.click(screen.getByTestId('github-issue-row-1290'));
    await screen.findByTestId('github-issue-detail-1290');
    const text = document.body.textContent ?? '';
    for (const forbidden of ['New issue', 'Comment', 'Merge', 'Close issue', 'Dispatch workflow']) {
      expect(text).not.toContain(forbidden);
    }
    expect(within(screen.getByTestId('github-issue-reader')).queryAllByRole('textbox')).toHaveLength(0);
  });
});
