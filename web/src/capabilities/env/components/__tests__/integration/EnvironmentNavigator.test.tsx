import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Agent, EnvFileInfo } from '@/types';
import {
  EnvironmentNavigator,
  type EnvironmentNavigatorProps,
} from '@/capabilities/env/components/EnvironmentNavigator';

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

function props(overrides: Partial<EnvironmentNavigatorProps> = {}): EnvironmentNavigatorProps {
  return {
    profiles: [],
    agents: [],
    activeKeys: new Set(),
    hasSession: false,
    loading: false,
    error: null,
    selectedKey: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onImport: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

describe('EnvironmentNavigator', () => {
  it('leads rows with the name and keeps location and count as metadata', () => {
    render(
      <EnvironmentNavigator
        {...props({
          profiles: [info('staging.env', { source: 'agent', agent_id: 'a1', var_count: 18 })],
          agents: [agent()],
        })}
      />,
    );
    const row = screen.getByTestId('env-profile-row-agent:a1:staging.env');
    expect(row).toHaveTextContent('staging.env');
    expect(row).toHaveTextContent('devbox-01 · 18 vars');
  });

  it('marks the Session-active profiles quietly', () => {
    render(
      <EnvironmentNavigator
        {...props({
          profiles: [info('a.env'), info('b.env')],
          activeKeys: new Set(['server::a.env']),
          hasSession: true,
        })}
      />,
    );
    expect(screen.getByTestId('env-profile-row-server::a.env')).toHaveTextContent('Active');
    expect(screen.getByTestId('env-profile-row-server::b.env')).not.toHaveTextContent('Active');
    expect(screen.getByTestId('env-session-summary')).toHaveTextContent(
      'Current Session · a.env',
    );
  });

  it('says when no environment is applied to the current Session', () => {
    render(<EnvironmentNavigator {...props({ profiles: [info('a.env')], hasSession: true })} />);
    expect(screen.getByTestId('env-session-summary')).toHaveTextContent(
      'Current Session · no environment applied',
    );
  });

  it('hides the Session summary when there is no Session', () => {
    render(<EnvironmentNavigator {...props({ profiles: [info('a.env')] })} />);
    expect(screen.queryByTestId('env-session-summary')).not.toBeInTheDocument();
  });

  it('filters rows by name and location', async () => {
    const user = userEvent.setup();
    render(
      <EnvironmentNavigator
        {...props({
          profiles: [info('staging.env'), info('prod.env', { source: 'agent', agent_id: 'a1' })],
          agents: [agent()],
        })}
      />,
    );
    await user.type(screen.getByTestId('env-search'), 'devbox');
    expect(screen.queryByTestId('env-profile-row-server::staging.env')).not.toBeInTheDocument();
    expect(screen.getByTestId('env-profile-row-agent:a1:prod.env')).toBeInTheDocument();

    await user.clear(screen.getByTestId('env-search'));
    await user.type(screen.getByTestId('env-search'), 'zzz');
    expect(screen.getByText('No environments match “zzz”')).toBeInTheDocument();
  });

  it('selecting a row hands the profile object over', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const profile = info('a.env');
    render(<EnvironmentNavigator {...props({ profiles: [profile], onSelect })} />);
    await user.click(screen.getByTestId('env-profile-row-server::a.env'));
    expect(onSelect).toHaveBeenCalledWith(profile);
  });

  it('the + menu discloses New environment and Import .env file', async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    const onImport = vi.fn();
    render(<EnvironmentNavigator {...props({ profiles: [info('a.env')], onNew, onImport })} />);

    await user.click(screen.getByTestId('env-new-menu'));
    await user.click(await screen.findByTestId('env-new-profile'));
    expect(onNew).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('env-new-menu'));
    await user.click(await screen.findByTestId('env-import'));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('an empty workspace speaks Environment and offers the two ways in', async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    render(<EnvironmentNavigator {...props({ onNew })} />);
    expect(screen.getByTestId('env-navigator-empty')).toHaveTextContent('No environments yet');
    await user.click(screen.getByRole('button', { name: 'New environment' }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('shows a loading skeleton and an error with retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { unmount } = render(<EnvironmentNavigator {...props({ loading: true })} />);
    expect(screen.getByTestId('env-navigator-loading')).toBeInTheDocument();
    unmount();

    render(<EnvironmentNavigator {...props({ error: 'socket closed', onRetry })} />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
