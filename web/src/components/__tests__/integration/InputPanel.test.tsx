import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputPanel } from '@/components/InputPanel';

const mockAddEntry = vi.fn();
const mockFilterHistory = vi.fn().mockReturnValue([]);
const mockClearHistory = vi.fn();

vi.mock( '@/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    history: [
      { id: '1', command: 'git status', timestamp: Date.now() - 60000 },
      { id: '2', command: 'git pull', timestamp: Date.now() - 120000 },
      { id: '3', command: 'npm test', timestamp: Date.now() - 300000 },
    ],
    addEntry: mockAddEntry,
    removeEntry: vi.fn(),
    clearHistory: mockClearHistory,
    filterHistory: mockFilterHistory,
  }),
}));

describe('InputPanel', () => {
  const defaultProps = {
    sendText: vi.fn(),
    disabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFilterHistory.mockReturnValue([]);
  });

  it('renders a textarea', () => {
    render(<InputPanel {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Type to send/)).toBeInTheDocument();
  });

  it('renders action buttons', () => {
    render(<InputPanel {...defaultProps} />);
    expect(screen.getByLabelText('Clear input')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy input')).toBeInTheDocument();
    expect(screen.getByLabelText('Paste to input')).toBeInTheDocument();
    expect(screen.getByLabelText('Send')).toBeInTheDocument();
  });

  it('sends command on Enter and adds to history', () => {
    render(<InputPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Type to send/);
    fireEvent.change(textarea, { target: { value: 'ls -la' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(defaultProps.sendText).toHaveBeenCalledWith('ls -la\r');
    expect(mockAddEntry).toHaveBeenCalledWith('ls -la');
  });

  it('Shift+Enter does not send', () => {
    render(<InputPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Type to send/);
    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(defaultProps.sendText).not.toHaveBeenCalled();
  });

  it('clear button empties the textarea', () => {
    render(<InputPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Type to send/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'some text' } });
    fireEvent.click(screen.getByLabelText('Clear input'));
    expect(textarea.value).toBe('');
  });

  it('send button triggers send', () => {
    render(<InputPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Type to send/);
    fireEvent.change(textarea, { target: { value: 'git status' } });
    fireEvent.click(screen.getByLabelText('Send'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('git status\r');
  });

  it('does nothing on empty input', () => {
    render(<InputPanel {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Send'));
    expect(defaultProps.sendText).not.toHaveBeenCalled();
  });

  it('disables all controls when disabled prop is true', () => {
    render(<InputPanel {...defaultProps} disabled={true} />);
    expect(screen.getByPlaceholderText(/Type to send/)).toBeDisabled();
    expect(screen.getByLabelText('Send')).toBeDisabled();
  });

  it('shows filtered history when input has text', () => {
    mockFilterHistory.mockReturnValue([
      { id: '1', command: 'git status', timestamp: Date.now() - 60000 },
      { id: '2', command: 'git pull', timestamp: Date.now() - 120000 },
    ]);
    render(<InputPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Type to send/);
    fireEvent.change(textarea, { target: { value: 'git' } });
    expect(screen.getByText(/Matching \(2\)/)).toBeInTheDocument();
  });

  it('clicking a history entry fills the input', () => {
    mockFilterHistory.mockReturnValue([
      { id: '1', command: 'git status', timestamp: Date.now() - 60000 },
    ]);
    render(<InputPanel {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Type to send/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'git' } });
    fireEvent.click(screen.getByText('git status'));
    expect(textarea.value).toBe('git status');
  });
});
