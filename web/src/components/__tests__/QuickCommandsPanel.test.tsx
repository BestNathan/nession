import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuickCommandsPanel } from '../QuickCommandsPanel';
import { PRESETS } from '../quickCommands';
import { useQuickCommands } from '../../hooks/useQuickCommands';

// Mock the useQuickCommands hook
vi.mock('../../hooks/useQuickCommands', () => ({
  useQuickCommands: vi.fn(),
}));

const mockAddCommand = vi.fn().mockResolvedValue(undefined);
const mockDeleteCommand = vi.fn().mockResolvedValue(undefined);

function setupMockHook() {
  vi.mocked(useQuickCommands).mockReturnValue({
    userCommands: [],
    addCommand: mockAddCommand,
    deleteCommand: mockDeleteCommand,
  });
}

describe('QuickCommandsPanel', () => {
  const defaultProps = {
    sendText: vi.fn(),
    disabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupMockHook();
  });

  it('renders all 5 preset commands', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    for (const preset of PRESETS) {
      expect(screen.getByText(preset.label)).toBeInTheDocument();
    }
  });

  it('clicking a preset send button sends the correct command', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    // Find the run button in the row containing 'Ctrl+C'
    const rows = screen.getAllByText('Ctrl+C');
    const row = rows[0].closest('div')!;
    const runBtn = row.querySelector('button');
    fireEvent.click(runBtn!);
    expect(defaultProps.sendText).toHaveBeenCalledWith('\x03');
  });

  it('non-raw presets append \\r', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    const rows = screen.getAllByText('clear');
    const row = rows[0].closest('div')!;
    const runBtn = row.querySelector('button');
    fireEvent.click(runBtn!);
    expect(defaultProps.sendText).toHaveBeenCalledWith('clear\r');
  });

  it('shows add command button', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    expect(screen.getByText(/Add Command/)).toBeInTheDocument();
  });

  it('clicking add shows the add form with Plain/Ctrl toggle', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText(/Add Command/));
    expect(screen.getByPlaceholderText('Label')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Command')).toBeInTheDocument();
    expect(screen.getByText('Plain')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+')).toBeInTheDocument();
  });

  it('switching to Ctrl+ mode shows single letter key input', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText(/Add Command/));
    fireEvent.click(screen.getByText('Ctrl+'));
    expect(screen.queryByPlaceholderText('Command')).toBeNull();
    expect(screen.getByPlaceholderText('Key')).toBeInTheDocument();
  });

  it('presets do not have delete buttons', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    // Check that a preset row has no delete button
    const ctrlCRow = screen.getByText('Ctrl+C').closest('div')!;
    const deleteBtns = ctrlCRow.querySelectorAll('button[aria-label="Delete"]');
    expect(deleteBtns.length).toBe(0);
  });

  it('user commands show delete buttons', () => {
    vi.mocked(useQuickCommands).mockReturnValue({
      userCommands: [
        { id: 'user-1', label: 'my-cmd', command: 'echo hi', raw: false },
      ],
      addCommand: mockAddCommand,
      deleteCommand: mockDeleteCommand,
    });
    render(<QuickCommandsPanel {...defaultProps} />);
    // User command row should have a delete button
    const row = screen.getByText('my-cmd').closest('div')!;
    const deleteBtn = row.querySelector('button[aria-label="Delete"]');
    expect(deleteBtn).not.toBeNull();
  });

  it('saving in Plain mode calls addCommand with raw=false', async () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText(/Add Command/));
    fireEvent.change(screen.getByPlaceholderText('Label'), { target: { value: 'My Cmd' } });
    fireEvent.change(screen.getByPlaceholderText('Command'), { target: { value: 'echo test' } });
    fireEvent.click(screen.getByText('Save'));
    expect(mockAddCommand).toHaveBeenCalledWith('My Cmd', 'echo test', false);
  });

  it('saving in Ctrl+ mode calls addCommand with raw=true', async () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText(/Add Command/));
    fireEvent.click(screen.getByText('Ctrl+'));
    fireEvent.change(screen.getByPlaceholderText('Key'), { target: { value: 'k' } });
    fireEvent.click(screen.getByText('Save'));
    expect(mockAddCommand).toHaveBeenCalledWith('Ctrl+K', '\x0b', true);
  });
});
