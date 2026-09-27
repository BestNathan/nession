import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { FixtureWorkspace } from '@/app/fixture/FixtureWorkspace';

/** The fixture reads its observations from the route, so every render needs one. */
function renderFixture(route = '/fixture/workspace') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <FixtureWorkspace />
    </MemoryRouter>,
  );
}

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('FixtureWorkspace', () => {
  it('renders the workspace shell with the tool bar and files layout', () => {
    renderFixture();
    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tool-bar')).toBeInTheDocument();
    expect(screen.getByTestId('files-web-layout')).toBeInTheDocument();
  });

  it('keeps direct chrome to the opened capability and discloses the rest through More', async () => {
    const user = userEvent.setup();
    renderFixture();

    // Files is the opened capability, so it owns the direct slot; registration
    // alone no longer buys a capability permanent navigation.
    expect(screen.getByTestId('workspace-tool-files')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tool-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tool-agent')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);

    await user.click(screen.getByTestId('workspace-capability-more'));
    expect(await screen.findByTestId('workspace-capability-picker-session')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-capability-picker-agent')).toBeInTheDocument();
  });

  it('gives a capability that is running here a direct slot, marked active', () => {
    renderFixture('/fixture/workspace?pane=claude.exe');

    const entry = screen.getByTestId('workspace-tool-claude-code');
    expect(entry).toHaveAttribute('data-capability-state', 'active');
    // Still bounded: the opened capability plus the one that earned it — the
    // remaining capabilities stay behind More.
    expect(screen.getByTestId('workspace-tool-files')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tool-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tool-agent')).not.toBeInTheDocument();
  });

  it('keeps a capability that ran here in direct chrome, marked relevant', () => {
    renderFixture('/fixture/workspace?pane=zsh&observed=claude.exe');

    const entry = screen.getByTestId('workspace-tool-claude-code');
    expect(entry).toHaveAttribute('data-capability-state', 'relevant');
    expect(entry).toHaveAttribute('data-capability-presence', 'contextual');
  });

  it('leaves a capability the session never ran in disclosure', () => {
    renderFixture('/fixture/workspace');

    expect(screen.queryByTestId('workspace-tool-claude-code')).not.toBeInTheDocument();
  });

  it('keeps Git out of direct chrome on the canonical route', () => {
    // Presence is earned, not granted: registering Git must not grow the dock,
    // which is also why the golden screenshots do not move.
    renderFixture('/fixture/workspace');

    expect(screen.queryByTestId('workspace-tool-git')).not.toBeInTheDocument();
  });

  it('renders the Git view when the route opens it', async () => {
    renderFixture('/fixture/workspace?capability=git');

    // The stub stands in for the agent, so this is the real view over canned
    // answers — which is what makes the e2e assertions about it meaningful.
    expect(await screen.findByTestId('git-workspace')).toBeInTheDocument();
    // The listing is what the status answer produces; waiting for it is what
    // makes the header assertions below about a resolved state, not a pending one.
    await screen.findByTestId('git-change-list');
    expect(screen.getByTestId('git-branch')).toHaveTextContent('feat/repo-status');
    expect(screen.getByTestId('git-summary')).toHaveTextContent('2 ahead, 1 behind');
  });

  /**
   * The conversation view `#1005` stage D built, finally reachable.
   *
   * The fixture could not open the capability and the manifest advertised no
   * conversation wire, so every state below rendered nowhere — which is how
   * `#1125` and `#1127` shipped UI that no image could capture (`#1029`,
   * `#1128`). The fixture half landed in `#1131`; these are the assertions that
   * were the reason for it.
   *
   * They live at the jsdom layer rather than in `fixture-visual.spec.ts` because
   * the properties below are *decidable*: a golden would cost a CI round to say
   * what a DOM query says in milliseconds, and `validation.md` asks that pixels
   * cover only the remainder no assertion can express.
   */
  it('renders the Claude Code conversation when the route opens it', async () => {
    renderFixture('/fixture/workspace?capability=claude-code');

    expect(await screen.findByTestId('conversation-open')).toBeInTheDocument();

    // Both message kinds render as turns — the rule the git surface follows for
    // its repository statuses, applied to the transcript.
    const kinds = (await screen.findAllByTestId('conversation-turn')).map((turn) =>
      turn.getAttribute('data-kind'),
    );
    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant');

    // A tool call is its **own** rendering rather than a turn — a collapsed
    // `<details>`, because `#1005` criterion 10 says tool use must not drown the
    // conversation. Asserting `data-kind="tool"` on a turn would assert a shape
    // this view does not have.
    const tool = screen.getAllByTestId('conversation-tool')[0]!;
    expect(tool.tagName).toBe('DETAILS');
    expect(tool).not.toHaveAttribute('open');

    // `ready` is a running conversation, so the header says so rather than
    // leaving the state implicit.
    expect(screen.getByTestId('conversation-state')).toHaveTextContent('Running now');
  });

  it('offers the candidates instead of choosing a conversation for the user', async () => {
    renderFixture('/fixture/workspace?capability=claude-code&conversation=ambiguous');

    // `#1005` decision 3: the list is the stable entry point, not a fallback. A
    // fixture that resolved a conversation here would let a case assert a
    // rendering the app never decided on.
    expect(await screen.findByTestId('conversation-candidates')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-open')).not.toBeInTheDocument();
  });

  it('reads a finished conversation, and says so', async () => {
    renderFixture('/fixture/workspace?capability=claude-code&conversation=inactive');

    // The same transcript as `ready` with a different header — which is the
    // whole of the difference, and the reason the fixture gives this state
    // items rather than leaving it empty.
    expect(await screen.findByTestId('conversation-open')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-state')).toHaveTextContent('Finished');
  });

  it('tells the two empty answers apart', async () => {
    // `not_found` is a directory that was read and held nothing; `unavailable`
    // is one that could not be read. Different causes, different notices — and
    // a fixture that answered one for the other would make the distinction
    // unassertable everywhere downstream.
    renderFixture('/fixture/workspace?capability=claude-code&conversation=none');
    expect(await screen.findByTestId('conversation-not-found')).toBeInTheDocument();
  });

  it('reports an unreadable directory rather than an empty one', async () => {
    renderFixture('/fixture/workspace?capability=claude-code&conversation=unavailable');

    expect(await screen.findByTestId('conversation-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-not-found')).not.toBeInTheDocument();
  });
});
