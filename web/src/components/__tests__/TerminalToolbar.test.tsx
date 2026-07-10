import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalToolbar, type TerminalToolbarProps } from '../TerminalToolbar';

function renderToolbar(props: Partial<TerminalToolbarProps> = {}) {
  const sendText = vi.fn();
  const utils = render(<TerminalToolbar sendText={sendText} {...props} />);
  return { sendText, ...utils };
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
    renderToolbar();
    await user.click(screen.getByRole('button', { name: /Add/ }));
    await user.type(screen.getByPlaceholderText('Label'), 'My Cmd');
    await user.type(screen.getByPlaceholderText('Command'), 'echo hello');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'My Cmd' })).toBeInTheDocument();
  });

  it('deletes a custom command', async () => {
    const user = userEvent.setup();
    renderToolbar();
    // Add a command first
    await user.click(screen.getByRole('button', { name: /Add/ }));
    await user.type(screen.getByPlaceholderText('Label'), 'Delete Me');
    await user.type(screen.getByPlaceholderText('Command'), 'rm -rf /');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'Delete Me' })).toBeInTheDocument();
    // Delete it
    const cmdWrapper = screen.getByRole('button', { name: 'Delete Me' }).closest('div')!;
    const deleteBtn = within(cmdWrapper).getByTitle('Delete');
    await user.click(deleteBtn);
    expect(screen.queryByRole('button', { name: 'Delete Me' })).not.toBeInTheDocument();
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
    // Cancel button is "✕"
    await user.click(screen.getByRole('button', { name: '✕' }));
    expect(screen.queryByPlaceholderText('Label')).not.toBeInTheDocument();
  });

  it('does not add empty command', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: /Add/ }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByPlaceholderText('Label')).toBeInTheDocument();
  });

});
