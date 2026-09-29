import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Agent, EnvFileInfo } from '@/types';

const contentHook = vi.hoisted(() => ({
  useEnvProfileContent: vi.fn(),
}));

vi.mock('@/capabilities/env/hooks/useEnvProfileContent', () => contentHook);

vi.mock('@/platform/editor', () => ({
  CodeMirrorEditor: ({ value, readOnly }: { value: string; readOnly?: boolean }) => (
    <div data-testid="codemirror-stub" data-readonly={readOnly ? 'true' : 'false'}>
      {value}
    </div>
  ),
}));

import { EnvProfileDetail } from '@/capabilities/env/components/EnvProfileDetail';

function info(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 5, modified: 0, var_count: 2, ...overrides };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'a1',
    hostname: 'devbox-01',
    ip_address: '10.0.0.1',
    port: 19090,
    status: 'online',
    ...overrides,
  } as Agent;
}

function hookResult(overrides: Record<string, unknown> = {}) {
  return {
    content: 'NODE_ENV=production\nAPI_KEY=supersecret\n',
    inUseBy: [],
    loading: false,
    error: null,
    reload: vi.fn(),
    ...overrides,
  };
}

function renderDetail(overrides: Partial<Parameters<typeof EnvProfileDetail>[0]> = {}) {
  // The callbacks come after the spread so they keep their Mock type — no
  // caller overrides them, and `{...defaults, ...overrides}` would widen them
  // to the prop's plain function type and hide `.mock` from tsc.
  const merged = {
    profile: info('staging.env'),
    agents: [] as Agent[],
    active: false,
    sourcedAtCreate: false,
    hasSession: true,
    sessionActionPending: false,
    ...overrides,
    onApply: vi.fn(),
    onRemove: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(async () => {}),
  };
  render(<EnvProfileDetail {...merged} />);
  return merged;
}

describe('EnvProfileDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contentHook.useEnvProfileContent.mockReturnValue(hookResult());
  });

  it('heads with the name, the location, and the variable count', () => {
    renderDetail({
      profile: info('staging.env', { source: 'agent', agent_id: 'a1', var_count: 18 }),
      agents: [agent()],
    });
    expect(screen.getByRole('heading', { name: 'staging.env' })).toBeInTheDocument();
    expect(screen.getByText('Agent · devbox-01 · 18 variables')).toBeInTheDocument();
  });

  it('shows the quiet Active state only for the Session-active profile', () => {
    renderDetail({ active: true });
    expect(screen.getByTestId('env-profile-active')).toHaveTextContent(
      'Active in current Session',
    );
  });

  it('names the sessions using the profile, including this one', () => {
    contentHook.useEnvProfileContent.mockReturnValue(
      hookResult({ inUseBy: ['api-tests', 'deploy'] }),
    );
    renderDetail({ active: true });
    expect(screen.getByTestId('env-profile-usage')).toHaveTextContent(
      'Used by 2 sessions · api-tests, deploy — including this Session',
    );
  });

  it('Apply and Remove are contextual to the current Session', async () => {
    const user = userEvent.setup();
    const first = renderDetail({ active: false });
    await user.click(screen.getByTestId('env-apply-to-session'));
    expect(first.onApply).toHaveBeenCalledTimes(1);
    first.onRemove.mockClear();

    const second = renderDetail({ active: true });
    await user.click(screen.getByTestId('env-remove-from-session'));
    expect(second.onRemove).toHaveBeenCalledTimes(1);
  });

  it('hides session actions entirely without a Session', () => {
    renderDetail({ hasSession: false });
    expect(screen.queryByTestId('env-apply-to-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('env-remove-from-session')).not.toBeInTheDocument();
  });

  it('a profile the Session was created with explains itself instead of offering Remove', () => {
    // The backend spares create-phase usage from `server.session.env.unset`,
    // so Remove there would unset the variables while the Active marker
    // stays — #1202 offers Apply/Remove only "when runtime semantics safely
    // permit it".
    renderDetail({ active: true, sourcedAtCreate: true });
    expect(screen.getByTestId('env-sourced-at-create')).toHaveTextContent(
      'Sourced at session creation',
    );
    expect(screen.queryByTestId('env-remove-from-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('env-apply-to-session')).not.toBeInTheDocument();
    // The Active recognition itself is unaffected.
    expect(screen.getByTestId('env-profile-active')).toBeInTheDocument();
  });

  it('Variables is the primary tab; Raw is one tab away and read-only', async () => {
    const user = userEvent.setup();
    renderDetail();
    expect(screen.getByTestId('env-variables')).toBeInTheDocument();
    expect(screen.queryByTestId('env-raw-view')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Raw' }));
    const raw = await screen.findByTestId('env-raw-view');
    expect(raw).toBeInTheDocument();
    expect(screen.getByTestId('codemirror-stub')).toHaveAttribute('data-readonly', 'true');
  });

  it('Edit and Duplicate disclose from the header', async () => {
    const user = userEvent.setup();
    const d = renderDetail();
    await user.click(screen.getByTestId('env-edit'));
    expect(d.onEdit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('env-more'));
    await user.click(await screen.findByTestId('env-duplicate'));
    expect(d.onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('Delete confirms with name, location, and session impact', async () => {
    const user = userEvent.setup();
    contentHook.useEnvProfileContent.mockReturnValue(
      hookResult({ inUseBy: ['api-tests'] }),
    );
    const d = renderDetail({ agents: [agent()], profile: info('prod.env', { source: 'agent', agent_id: 'a1' }) });

    await user.click(screen.getByTestId('env-more'));
    await user.click(await screen.findByTestId('env-delete'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete prod.env?');
    expect(dialog).toHaveTextContent('Agent · devbox-01');
    expect(dialog).toHaveTextContent('currently used by 1 session (api-tests)');
    expect(dialog).toHaveTextContent('This cannot be undone');

    await user.click(screen.getByTestId('env-delete-confirm'));
    await waitFor(() => expect(d.onDelete).toHaveBeenCalledTimes(1));
  });

  it('a load failure offers a retry', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    contentHook.useEnvProfileContent.mockReturnValue(
      hookResult({ content: null, error: 'agent unreachable', reload }),
    );
    renderDetail();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
