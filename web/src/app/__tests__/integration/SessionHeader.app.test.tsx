import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionHeader } from '@/app/patterns/SessionHeader';
import type { DomainState } from '@/product/session/model/domainState';

const healthy: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'attached', copy: null },
};

/**
 * The App title role, spelled out rather than imported. App-scoped in name
 * because `--typography-title-size` is emitted only under
 * `[data-experience="app"]` (`nession/no-cross-experience-token`).
 */
const AppTitleRoleClass = 'text-[length:var(--typography-title-size)]';

const base = {
  sessionName: 'fix-terminal-reconnect',
  agentLabel: 'devbox-01',
  state: healthy,
  surface: 'terminal' as const,
  onSurfaceChange: vi.fn(),
  onOpenAgent: vi.fn(),
};

describe('SessionHeader app branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a single row: sessions, name, workspace — and no status while healthy', () => {
    render(
      <SessionHeader
        {...base}
        experience="app"
        onOpenDrawer={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByTestId('session-header-line')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-workspace')).toBeInTheDocument();
    expect(screen.getByText('fix-terminal-reconnect')).toBeInTheDocument();
    // Healthy + redundant infrastructure is quiet: the status line exists only
    // when it has something the user can act on.
    expect(screen.queryByTestId('connection-status')).not.toBeInTheDocument();
  });

  it('sets the session name in the product face', () => {
    // #1050 stage 4: the name is Session identity — the same string the Sessions
    // row it was chosen from sets in the product face.
    render(<SessionHeader {...base} experience="app" onOpenDrawer={vi.fn()} />);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent('fix-terminal-reconnect');
    expect(title.className).not.toMatch(/font-mono/);
  });

  it('sets the status member in the product face', () => {
    // #1050 stage 4: the member reports channel words with their copy, which is
    // the Metadata role's "status details". The wrapper is what carried
    // `font-mono` — `ConnectionStatus` never set a family of its own — so the
    // assertion is on the wrapper that decides it.
    render(
      <SessionHeader
        {...base}
        state={{ ...healthy, agent: { channel: 'offline', copy: 'Agent offline' } }}
        experience="app"
        onOpenDrawer={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByTestId('session-header-status').className).not.toMatch(/font-mono/);
  });

  it('sets the session name at the App title role', () => {
    // #1073: the App header renders one page title, and it is the same role the
    // Workspace tool header and a pushed file detail state. `text-base` was the
    // primitive's 16px, which put the page's name at exactly the size of the
    // capsule's text field below it.
    render(<SessionHeader {...base} experience="app" onOpenDrawer={vi.fn()} />);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.className).toContain(AppTitleRoleClass);
    expect(title.className).not.toMatch(/(^|\s)text-(?:xs|sm|base)(\s|$)/);
  });

  it('sets the status member at the App metadata role', () => {
    // #1073: the size follows the same role the family does. The `text-xs` it
    // replaced happened to equal the App's metadata value, which is not the
    // same as being owned by the role.
    render(
      <SessionHeader
        {...base}
        state={{ ...healthy, agent: { channel: 'offline', copy: 'Agent offline' } }}
        experience="app"
        onOpenDrawer={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );
    const status = screen.getByTestId('session-header-status');
    expect(status.className).toContain('text-[length:var(--typography-metadata-size)]');
    expect(status.className).not.toMatch(/(^|\s)text-xs(\s|$)/);
  });

  it('renders the status line when the agent is unreachable', () => {
    render(
      <SessionHeader
        {...base}
        state={{ ...healthy, agent: { channel: 'offline', copy: 'Agent offline' } }}
        experience="app"
        onOpenDrawer={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByTestId('connection-status')).toHaveTextContent(/offline/);
  });

  it('omits the sessions and workspace buttons when callbacks are absent', () => {
    render(<SessionHeader {...base} experience="app" />);
    expect(screen.queryByTestId('app-header-sessions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-header-workspace')).not.toBeInTheDocument();
  });

  it('fires onOpenWorkspace from the workspace button', async () => {
    const onOpenWorkspace = vi.fn();
    render(<SessionHeader {...base} experience="app" onOpenWorkspace={onOpenWorkspace} />);
    await userEvent.click(screen.getByTestId('app-header-workspace'));
    expect(onOpenWorkspace).toHaveBeenCalled();
  });
});
