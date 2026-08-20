import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvEditorDialog } from '@/components/env/EnvEditorDialog';
import type { WebSocketService } from '@/services/websocket';
import { WebSocketContext } from '@/hooks/useWebSocket';
import type { Agent, EnvFileInfo } from '@/types';

function agent(): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'host-1',
    ip_address: '1.2.3.4',
    port: 80,
    status: 'online',
    session_count: 0,
    last_heartbeat: new Date().toISOString(),
  };
}

function makeWs(overrides: Partial<WebSocketService> = {}): WebSocketService {
  return {
    getEnvFile: vi.fn().mockResolvedValue({ success: true, content: 'FOO=bar', in_use_by: [] }),
    writeEnvFile: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as WebSocketService;
}

const editingFile: EnvFileInfo = {
  name: 'staging.env',
  source: 'server',
  size: 8,
  modified: 0,
  var_count: 1,
};

describe('EnvEditorDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a new file', async () => {
    const writeEnvFile = vi.fn().mockResolvedValue({ success: true });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <WebSocketContext.Provider value={makeWs({ writeEnvFile })}>
        <EnvEditorDialog
          isOpen
          onClose={vi.fn()}
          editing={null}
          agents={[agent()]}
          onSaved={onSaved}
        />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText('New Env File')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('staging.env'), 'prod.env');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(writeEnvFile).toHaveBeenCalledWith(
        { name: 'prod.env', source: 'server', agent_id: undefined },
        '',
        false,
        false,
      );
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it('loads content and shows in-use warning with Force Override when editing', async () => {
    const writeEnvFile = vi.fn().mockResolvedValue({ success: true });
    const ws = makeWs({
      getEnvFile: vi
        .fn()
        .mockResolvedValue({ success: true, content: 'A=1', in_use_by: ['agent-1:dev'] }),
      writeEnvFile,
    });
    const user = userEvent.setup();
    render(
      <WebSocketContext.Provider value={ws}>
        <EnvEditorDialog
          isOpen
          onClose={vi.fn()}
          editing={editingFile}
          agents={[agent()]}
          onSaved={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/This file is in use by 1 session\(s\)/)).toBeInTheDocument();
    });
    expect(screen.getByText(/agent-1:dev/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Force Override' }));
    await waitFor(() => {
      expect(writeEnvFile).toHaveBeenCalledWith(
        { name: 'staging.env', source: 'server', agent_id: undefined },
        'A=1',
        true,
        true,
      );
    });
  });

  it('prefills a new editor from cloneFrom', async () => {
    const getEnvFile = vi
      .fn()
      .mockResolvedValue({ success: true, content: 'A=1\nB=2', in_use_by: [] });
    const ws = makeWs({ getEnvFile });
    render(
      <WebSocketContext.Provider value={ws}>
        <EnvEditorDialog
          isOpen
          onClose={vi.fn()}
          editing={null}
          cloneFrom={editingFile}
          agents={[agent()]}
          onSaved={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByDisplayValue('staging-copy.env')).toBeInTheDocument();
    });
    expect(getEnvFile).toHaveBeenCalledWith({
      name: 'staging.env',
      source: 'server',
      agent_id: undefined,
    });
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /content/i })).toHaveValue('A=1\nB=2');
    });
  });

  it('appends .env suffix when missing', async () => {
    const writeEnvFile = vi.fn().mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(
      <WebSocketContext.Provider value={makeWs({ writeEnvFile })}>
        <EnvEditorDialog
          isOpen
          onClose={vi.fn()}
          editing={null}
          agents={[agent()]}
          onSaved={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText('New Env File')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('staging.env'), 'noext');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(writeEnvFile).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'noext.env' }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
