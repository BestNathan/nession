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
    includedInBinding: false,
    sessionLabel: null as string | null,
    ...overrides,
    onShowSession: vi.fn(),
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

  it('marks a profile in the desired binding without claiming convergence', () => {
    renderDetail({ includedInBinding: true });
    expect(screen.getByTestId('env-profile-included')).toHaveTextContent(
      'Included in binding',
    );
    expect(screen.queryByText('Active in current Session')).not.toBeInTheDocument();
  });

  it('names the session bindings that include the profile', () => {
    contentHook.useEnvProfileContent.mockReturnValue(
      hookResult({ inUseBy: ['api-tests', 'deploy'] }),
    );
    renderDetail({ includedInBinding: true });
    expect(screen.getByTestId('env-profile-usage')).toHaveTextContent(
      'Included in 2 session bindings · api-tests, deploy',
    );
  });

  it('offers the current Session status and returns to it without applying anything', async () => {
    const user = userEvent.setup();
    const d = renderDetail({ sessionLabel: 'Waiting for the next shell prompt' });
    await user.click(screen.getByTestId('env-profile-session-link'));
    expect(d.onShowSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('env-apply-to-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('env-remove-from-session')).not.toBeInTheDocument();
  });

  it('hides the Session link without a current Session', () => {
    renderDetail({ sessionLabel: null });
    expect(screen.queryByTestId('env-profile-session-link')).not.toBeInTheDocument();
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
    expect(dialog).toHaveTextContent('included in 1 session binding (api-tests)');
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
