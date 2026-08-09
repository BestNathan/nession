import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuickCommandsPanel } from '../QuickCommandsPanel';
import { PRESETS } from '../quickCommands';

vi.mock('../../hooks/useQuickCommands', () => ({
  useQuickCommands: vi.fn(),
}));

vi.mock('../../hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

import { useQuickCommands } from '../../hooks/useQuickCommands';

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
  const defaultProps = { sendText: vi.fn(), disabled: false };

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

  it('renders physical key row', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    // Main grid keys (always visible)
    expect(screen.getByText('Esc')).toBeInTheDocument();
    expect(screen.getByText('Tab')).toBeInTheDocument();
    expect(screen.getByText('Ctrl-C')).toBeInTheDocument();
    expect(screen.getByText('Space')).toBeInTheDocument();
    expect(screen.getByText('Enter')).toBeInTheDocument();
    // Overflow keys (Home, Del, etc.) are in a dropdown — not visible until opened
    expect(screen.getByLabelText('More keys')).toBeInTheDocument();
  });

  it('clicking a preset row sends the correct command', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText('Ctrl+C'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('\x03');
  });

  it('non-raw presets append \\r', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText('clear'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('clear\r');
  });

  it('shows add command button', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    expect(screen.getByText(/Add Command/)).toBeInTheDocument();
  });

  it('clicking add shows Combo/Plain toggle', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText(/Add Command/));
    expect(screen.getByText('Combo')).toBeInTheDocument();
    expect(screen.getByText('Plain')).toBeInTheDocument();
  });

  it('switching to Plain shows command input', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText(/Add Command/));
    fireEvent.click(screen.getByText('Plain'));
    expect(screen.getByPlaceholderText('Label')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Command/)).toBeInTheDocument();
  });

  it('Combo mode shows modifier toggles and key input', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    fireEvent.click(screen.getByText(/Add Command/));
    expect(screen.getByText('Ctrl')).toBeInTheDocument();
    expect(screen.getByText('Alt')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('A')).toBeInTheDocument();
  });

  it('presets do not have delete buttons', () => {
    render(<QuickCommandsPanel {...defaultProps} />);
    const ctrlCRow = screen.getByText('Ctrl+C').closest('button')!;
    expect(ctrlCRow.querySelector('[aria-label="Delete"]')).toBeNull();
  });

  it('user commands show delete buttons', () => {
    vi.mocked(useQuickCommands).mockReturnValue({
      userCommands: [{ id: 'user-1', label: 'my-cmd', command: 'echo hi', raw: false }],
      addCommand: mockAddCommand,
      deleteCommand: mockDeleteCommand,
    });
    render(<QuickCommandsPanel {...defaultProps} />);
    const row = screen.getByText('my-cmd').closest('button')!;
    expect(row.querySelector('[aria-label="Delete"]')).not.toBeNull();
  });
});
