import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebSocketContext } from '../../hooks/useWebSocket';
import { TerminalToolbar, type TerminalToolbarProps } from '../TerminalToolbar';
import type { WebSocketService } from '../../services/websocket';

function createMockWs(overrides: Partial<WebSocketService> = {}): WebSocketService {
  return {
    listCommands: vi.fn().mockResolvedValue({ commands: [] }),
    addCommand: vi.fn().mockResolvedValue({ success: true, id: 'mock-id' }),
    removeCommand: vi.fn().mockResolvedValue({ success: true }),
    updateCommand: vi.fn().mockResolvedValue({ success: true }),
    onCommandsChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as unknown as WebSocketService;
}

function renderToolbar(props: Partial<TerminalToolbarProps> = {}, wsOverrides = {}) {
  const sendText = vi.fn();
  const ws = createMockWs(wsOverrides);
  const utils = render(
    <WebSocketContext.Provider value={ws}>
      <TerminalToolbar sendText={sendText} {...props} />
    </WebSocketContext.Provider>,
  );
  return { sendText, ws, ...utils };
}

describe('TerminalToolbar', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders all preset buttons', () => {
    renderToolbar();
    expect(screen.getByRole('button', { name: 'clear' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ls -la' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'git status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'git pull' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ctrl+C' })).toBeInTheDocument();
  });

  it('calls sendText when a preset button is clicked', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();
    await user.click(screen.getByRole('button', { name: 'clear' }));
    expect(sendText).toHaveBeenCalledWith('clear\r');
  });

  it('calls sendText without CR for raw commands', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();
    await user.click(screen.getByRole('button', { name: 'Ctrl+C' }));
    expect(sendText).toHaveBeenCalledWith('\x03');
  });

  it('adds a custom command', async () => {
    const user = userEvent.setup();
    const { ws } = renderToolbar();
    await user.click(screen.getByRole('button', { name: /Add/ }));
    await user.type(screen.getByPlaceholderText('Label'), 'My Cmd');
    await user.type(screen.getByPlaceholderText('Command'), 'echo hello');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(ws.addCommand).toHaveBeenCalledWith('My Cmd', 'echo hello', false);
    // After add, the list refreshes (the mock returns empty, so no button shown)
    await waitFor(() => {
      expect(ws.listCommands).toHaveBeenCalled();
    });
  });

  it('deletes a custom command via server', async () => {
    const user = userEvent.setup();
    const listCommands = vi.fn().mockResolvedValue({ commands: [
      { id: 'existing', label: 'Delete Me', command: 'rm -rf /', raw: false, sort_order: 0, created_at: 0 },
    ]});
    const removeCommand = vi.fn().mockResolvedValue({ success: true });
    const { ws } = renderToolbar({}, { listCommands, removeCommand });
    // The command is already loaded from server
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Me' })).toBeInTheDocument();
    });
    // Delete it
    const cmdRow = screen.getByRole('button', { name: 'Delete Me' }).closest('div')!;
    const deleteBtn = within(cmdRow).getByTitle('Delete');
    await user.click(deleteBtn);
    expect(ws.removeCommand).toHaveBeenCalledWith('existing');
  });

  it('sends text from textarea on Enter', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();
    const input = screen.getByPlaceholderText(/Type to send/);
    await user.type(input, 'ls -la{Enter}');
    expect(sendText).toHaveBeenCalledWith('ls -la\r');
  });

  it('sends text on Send button click', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();
    const input = screen.getByPlaceholderText(/Type to send/);
    await user.type(input, 'pwd');
    await user.click(screen.getByTitle('Send'));
    expect(sendText).toHaveBeenCalledWith('pwd\r');
  });

  it('Shift+Enter inserts a newline and does not send', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();
    const input = screen.getByPlaceholderText(/Type to send/) as HTMLTextAreaElement;
    await user.type(input, 'line1');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(sendText).not.toHaveBeenCalled();
    expect(input.value).toBe('line1\n');
  });

  it('sends a multi-line block as literal text plus trailing CR', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();
    const input = screen.getByPlaceholderText(/Type to send/);
    await user.type(input, 'cd /tmp{Shift>}{Enter}{/Shift}ls{Enter}');
    expect(sendText).toHaveBeenCalledWith('cd /tmp\nls\r');
  });

  it('disables functional buttons when disabled prop is true', () => {
    renderToolbar({ disabled: true });
    expect(screen.getByRole('button', { name: 'clear' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ls -la' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Add/ })).toBeDisabled();
    expect(screen.getByTitle('Send')).toBeDisabled();
  });

  it('disables textarea when disabled prop is true', () => {
    renderToolbar({ disabled: true });
    const input = screen.getByPlaceholderText(/Type to send/);
    expect(input).toBeDisabled();
  });

  it('cancels add command form', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: /Add/ }));
    expect(screen.getByPlaceholderText('Label')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Label'), 'test');
    // Cancel button has aria-label="Cancel"
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Label')).not.toBeInTheDocument();
  });

  it('does not add empty command', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: /Add/ }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByPlaceholderText('Label')).toBeInTheDocument();
  });

  it('gives preset command buttons a 44px touch target on mobile', () => {
    const ws = createMockWs();
    render(
      <WebSocketContext.Provider value={ws}>
        <TerminalToolbar sendText={vi.fn()} />
      </WebSocketContext.Provider>,
    );
    const buttons = screen.getAllByRole('button');
    const preset = buttons.find((b) => b.className.includes('h-11 md:h-6'));
    expect(preset).toBeDefined();
  });

  it('loads commands from server on mount', async () => {
    const { ws } = renderToolbar();
    await waitFor(() => {
      expect(ws.listCommands).toHaveBeenCalled();
    });
  });

  it('subscribes to server.commands.changed', () => {
    const { ws } = renderToolbar();
    expect(ws.onCommandsChanged).toHaveBeenCalled();
  });

  it('imports legacy localStorage commands on mount', async () => {
    localStorage.setItem(
      'nession_quick_commands',
      JSON.stringify([{ id: 'legacy-1', label: 'old', command: 'old cmd', raw: true }]),
    );
    const { ws } = renderToolbar();
    await waitFor(() => {
      expect(ws.addCommand).toHaveBeenCalledWith('old', 'old cmd', true);
    });
    expect(localStorage.getItem('nession_quick_commands')).toBeNull();
  });
});