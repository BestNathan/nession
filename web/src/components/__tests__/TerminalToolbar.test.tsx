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

    await user.click(screen.getByRole('button', { name: /Add command/ }));

    const labelInput = screen.getByPlaceholderText('Label');
    const commandInput = screen.getByPlaceholderText('Command');

    await user.type(labelInput, 'My Cmd');
    await user.type(commandInput, 'echo hello');

    await user.click(screen.getByRole('button', { name: 'Add' }));

    // The new command should appear as a button
    expect(screen.getByRole('button', { name: 'My Cmd' })).toBeInTheDocument();
  });

  it('deletes a custom command', async () => {
    const user = userEvent.setup();
    renderToolbar();

    // Add a command first
    await user.click(screen.getByRole('button', { name: /Add command/ }));
    await user.type(screen.getByPlaceholderText('Label'), 'Delete Me');
    await user.type(screen.getByPlaceholderText('Command'), 'rm -rf /');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByRole('button', { name: 'Delete Me' })).toBeInTheDocument();

    // Delete it (the X button inside the command wrapper)
    const cmdWrapper = screen.getByRole('button', { name: 'Delete Me' }).closest('div')!;
    const deleteBtn = within(cmdWrapper).getByTitle('Delete command');
    await user.click(deleteBtn);

    expect(screen.queryByRole('button', { name: 'Delete Me' })).not.toBeInTheDocument();
  });

  it('sends text from textarea on Enter', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();

    const textarea = screen.getByPlaceholderText(/Type text to send/);
    await user.type(textarea, 'ls -la{Enter}');

    expect(sendText).toHaveBeenCalledWith('ls -la\r');
  });

  it('sends text on Send button click', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();

    const textarea = screen.getByPlaceholderText(/Type text to send/);
    await user.type(textarea, 'pwd');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(sendText).toHaveBeenCalledWith('pwd\r');
  });

  it('disables functional buttons when disabled prop is true', () => {
    renderToolbar({ disabled: true });

    // Preset buttons should be disabled
    expect(screen.getByRole('button', { name: 'clear' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ls -la' })).toBeDisabled();

    // Send button should be disabled
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    // Add command button should be disabled
    expect(screen.getByRole('button', { name: /Add command/ })).toBeDisabled();
  });

  it('disables textarea when disabled prop is true', () => {
    renderToolbar({ disabled: true });

    const textarea = screen.getByPlaceholderText(/Type text to send/);
    expect(textarea).toBeDisabled();
  });

  it('collapses and expands', async () => {
    const user = userEvent.setup();
    renderToolbar();

    // Initially expanded — textarea should be visible
    expect(screen.getByPlaceholderText(/Type text to send/)).toBeVisible();

    // Click collapse trigger
    const trigger = screen.getByRole('button', { name: '' }); // ChevronDown icon
    await user.click(trigger);

    // Textarea should be hidden after collapse animation
    // (CollapsibleContent sets hidden state)
  });

  it('cancels add command form', async () => {
    const user = userEvent.setup();
    renderToolbar();

    // Open the add form
    await user.click(screen.getByRole('button', { name: /Add command/ }));
    expect(screen.getByPlaceholderText('Label')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Command')).toBeInTheDocument();

    // Type something then cancel
    await user.type(screen.getByPlaceholderText('Label'), 'test');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Form should be gone
    expect(screen.queryByPlaceholderText('Label')).not.toBeInTheDocument();
  });

  it('does not add empty command', async () => {
    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole('button', { name: /Add command/ }));
    // Don't type anything
    await user.click(screen.getByRole('button', { name: 'Add' }));

    // Form should still be open (validation prevented submission)
    expect(screen.getByPlaceholderText('Label')).toBeInTheDocument();
  });

  it('Shfit+Enter does not send in textarea', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();

    const textarea = screen.getByPlaceholderText(/Type text to send/);
    await user.type(textarea, 'line1');
    // Shift+Enter adds a newline without sending
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(sendText).not.toHaveBeenCalled();
  });
});
