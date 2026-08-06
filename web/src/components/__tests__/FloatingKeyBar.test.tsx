import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FloatingKeyBar } from '../FloatingKeyBar';
import { KEY_DEFINITIONS } from '../floatingKeyBarKeys';

describe('FloatingKeyBar', () => {
  const defaultProps = {
    sendText: vi.fn(),
    visible: true,
    dismissed: false,
    onShow: vi.fn(),
    onActivity: vi.fn(),
    onDismiss: vi.fn(),
    onRestore: vi.fn(),
  };

  it('renders all 11 keys when visible', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    expect(screen.getByText('←')).toBeInTheDocument();
    expect(screen.getByText('↑')).toBeInTheDocument();
    expect(screen.getByText('↓')).toBeInTheDocument();
    expect(screen.getByText('→')).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('End')).toBeInTheDocument();
    expect(screen.getByText('PgUp')).toBeInTheDocument();
    expect(screen.getByText('PgDn')).toBeInTheDocument();
    expect(screen.getByText('Tab')).toBeInTheDocument();
    expect(screen.getByText('Esc')).toBeInTheDocument();
    expect(screen.getByText('Del')).toBeInTheDocument();
  });

  it('hides when visible=false', () => {
    render(<FloatingKeyBar {...defaultProps} visible={false} />);
    expect(screen.queryByText('↑')).toBeNull();
  });

  it('shows restore handle when dismissed', () => {
    render(<FloatingKeyBar {...defaultProps} visible={false} dismissed={true} />);
    const handle = screen.getByLabelText('Show keyboard keys');
    expect(handle).toBeInTheDocument();
    expect(handle.textContent).toContain('◉');
  });

  it('clicking restore handle calls onRestore', () => {
    render(<FloatingKeyBar {...defaultProps} visible={false} dismissed={true} />);
    fireEvent.click(screen.getByLabelText('Show keyboard keys'));
    expect(defaultProps.onRestore).toHaveBeenCalledOnce();
  });

  it('clicking a key sends the escape sequence', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    fireEvent.click(screen.getByText('↑'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('\x1b[A');
  });

  it('clicking Tab sends \\t', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    fireEvent.click(screen.getByText('Tab'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('\t');
  });

  it('clicking Esc sends \\x1b', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    fireEvent.click(screen.getByText('Esc'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('\x1b');
  });

  it('clicking Del sends \\x1b[3~', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    fireEvent.click(screen.getByText('Del'));
    expect(defaultProps.sendText).toHaveBeenCalledWith('\x1b[3~');
  });

  it('KEY_DEFINITIONS has exactly 11 entries in 3 groups', () => {
    expect(KEY_DEFINITIONS).toHaveLength(3);
    const allKeys = KEY_DEFINITIONS.flatMap((g) => g.keys);
    expect(allKeys).toHaveLength(11);
  });

  it('buttons have tabIndex -1 to not interfere with terminal focus', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    const button = screen.getByText('Esc').closest('button');
    expect(button?.getAttribute('tabIndex')).toBe('-1');
  });

  it('dismiss button (X) calls onDismiss', () => {
    render(<FloatingKeyBar {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Dismiss key bar'));
    expect(defaultProps.onDismiss).toHaveBeenCalledOnce();
  });
});
