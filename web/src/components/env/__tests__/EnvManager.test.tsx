import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvManager } from '../EnvManager';
import type { WebSocketService } from '../../../services/websocket';
import { WebSocketContext } from '../../../hooks/useWebSocket';
import type { Agent, EnvFileInfo } from '../../../types';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'host-1',
    ip_address: '1.2.3.4',
    port: 80,
    status: 'online',
    session_count: 0,
    last_heartbeat: new Date().toISOString(),
    ...overrides,
  };
}

function file(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 8, modified: 0, var_count: 2, ...overrides };
}

function makeWs(overrides: Partial<WebSocketService> = {}): WebSocketService {
  return {
    listEnvFiles: vi.fn().mockResolvedValue({ files: [] }),
    getEnvFile: vi.fn().mockResolvedValue({ success: true, content: '', in_use_by: [] }),
    writeEnvFile: vi.fn().mockResolvedValue({ success: true }),
    deleteEnvFile: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as WebSocketService;
}

describe('EnvManager', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows empty state when no files', async () => {
    render(
      <WebSocketContext.Provider value={makeWs()}>
        <EnvManager agents={[agent()]} onBack={vi.fn()} />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/No env files yet/)).toBeInTheDocument();
    });
  });

  it('lists files with source badge', async () => {
    const ws = makeWs({
      listEnvFiles: vi.fn().mockResolvedValue({ files: [file('staging.env')] }),
    });
    render(
      <WebSocketContext.Provider value={ws}>
        <EnvManager agents={[agent()]} onBack={vi.fn()} />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText('staging.env')).toBeInTheDocument();
    });
    expect(screen.getByText('server')).toBeInTheDocument();
  });

  it('calls onBack when Back clicked', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(
      <WebSocketContext.Provider value={makeWs()}>
        <EnvManager agents={[agent()]} onBack={onBack} />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText(/No env files yet/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('deletes a file after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteEnvFile = vi.fn().mockResolvedValue({ success: true });
    const ws = makeWs({
      listEnvFiles: vi.fn().mockResolvedValue({ files: [file('gone.env')] }),
      deleteEnvFile,
    });
    const user = userEvent.setup();
    render(
      <WebSocketContext.Provider value={ws}>
        <EnvManager agents={[agent()]} onBack={vi.fn()} />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText('gone.env')).toBeInTheDocument());
    // The delete button is the second action button in the row (Trash icon).
    const buttons = screen.getAllByRole('button');
    const trash = buttons[buttons.length - 1];
    await user.click(trash);
    await waitFor(() => expect(deleteEnvFile).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });

  it('opens the clone editor prefilled from the original file', async () => {
    const getEnvFile = vi
      .fn()
      .mockResolvedValue({ success: true, content: 'FOO=bar', in_use_by: [] });
    const ws = makeWs({
      listEnvFiles: vi.fn().mockResolvedValue({ files: [file('staging.env')] }),
      getEnvFile,
    });
    const user = userEvent.setup();
    render(
      <WebSocketContext.Provider value={ws}>
        <EnvManager agents={[agent()]} onBack={vi.fn()} />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText('staging.env')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /clone/i }));
    await waitFor(() => {
      expect(screen.getByDisplayValue('staging-copy.env')).toBeInTheDocument();
    });
    expect(getEnvFile).toHaveBeenCalledWith({
      name: 'staging.env',
      source: 'server',
      agent_id: undefined,
    });
  });

  it('opens the create dialog on New', async () => {
    const user = userEvent.setup();
    render(
      <WebSocketContext.Provider value={makeWs()}>
        <EnvManager agents={[agent()]} onBack={vi.fn()} />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText(/No env files yet/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /New/ }));
    await waitFor(() => expect(screen.getByText('New Env File')).toBeInTheDocument());
  });
});
