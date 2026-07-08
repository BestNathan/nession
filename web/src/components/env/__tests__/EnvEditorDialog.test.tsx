import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvEditorDialog } from '../EnvEditorDialog';
import type { WebSocketService } from '../../../services/websocket';
import type { Agent, EnvFileInfo } from '../../../types';

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
      <EnvEditorDialog
        isOpen
        onClose={vi.fn()}
        wsService={makeWs({ writeEnvFile })}
        editing={null}
        agents={[agent()]}
        onSaved={onSaved}
      />,
    );
    await waitFor(() => expect(screen.getByText('New Env File')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('staging.env'), 'prod.env');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(writeEnvFile).toHaveBeenCalledWith(
        { name: 'prod.env', source: 'server', agent_id: undefined },
        '',
        false,
      );
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it('loads content and shows in-use lock message when editing', async () => {
    const ws = makeWs({
      getEnvFile: vi
        .fn()
        .mockResolvedValue({ success: true, content: 'A=1', in_use_by: ['agent-1:dev'] }),
    });
    render(
      <EnvEditorDialog
        isOpen
        onClose={vi.fn()}
        wsService={ws}
        editing={editingFile}
        agents={[agent()]}
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/in use by session\(s\): agent-1:dev/)).toBeInTheDocument();
    });
  });

  it('appends .env suffix when missing', async () => {
    const writeEnvFile = vi.fn().mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(
      <EnvEditorDialog
        isOpen
        onClose={vi.fn()}
        wsService={makeWs({ writeEnvFile })}
        editing={null}
        agents={[agent()]}
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('New Env File')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('staging.env'), 'noext');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(writeEnvFile).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'noext.env' }),
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
