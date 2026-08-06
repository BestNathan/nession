import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BottomSheet } from '../BottomSheet';
import type { FontSizeManager } from '@/terminal/FontSizeManager';

describe('BottomSheet', () => {
  const defaultProps = {
    activeTab: 'input' as const,
    onTabChange: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    showFilesTab: false,
    fontSizeManager: null,
    inputPanel: <div data-testid="input-panel">Input</div>,
    commandsPanel: <div data-testid="commands-panel">Commands</div>,
    envPanel: <div data-testid="env-panel">Env</div>,
  };

  it('renders tab bar with Input, Commands, Env tabs', () => {
    render(<BottomSheet {...defaultProps} />);
    expect(screen.getByRole('tab', { name: /Input/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Commands/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Env/ })).toBeInTheDocument();
  });

  it('renders Files tab when showFilesTab is true', () => {
    render(<BottomSheet {...defaultProps} showFilesTab={true} />);
    expect(screen.getByRole('tab', { name: /Files/ })).toBeInTheDocument();
  });

  it('does not render Files tab when showFilesTab is false', () => {
    render(<BottomSheet {...defaultProps} showFilesTab={false} />);
    expect(screen.queryByRole('tab', { name: /Files/ })).toBeNull();
  });

  it('hides content area when collapsed', () => {
    render(<BottomSheet {...defaultProps} collapsed={true} />);
    expect(screen.queryByTestId('input-panel')).toBeNull();
  });

  it('shows active tab content', () => {
    render(<BottomSheet {...defaultProps} activeTab="commands" />);
    expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('input-panel')).toBeNull();
  });

  it('calls onTabChange when clicking a tab', () => {
    render(<BottomSheet {...defaultProps} />);
    fireEvent.click(screen.getByRole('tab', { name: /Commands/ }));
    expect(defaultProps.onTabChange).toHaveBeenCalledWith('commands');
  });

  it('calls onToggleCollapse when clicking toggle button', () => {
    render(<BottomSheet {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Collapse'));
    expect(defaultProps.onToggleCollapse).toHaveBeenCalledOnce();
  });

  it('shows Expand label when collapsed', () => {
    render(<BottomSheet {...defaultProps} collapsed={true} />);
    expect(screen.getByLabelText('Expand')).toBeInTheDocument();
  });

  it('renders zoom controls when fontSizeManager is provided', () => {
    const mockManager = {
      getSize: vi.fn().mockReturnValue(14),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      reset: vi.fn(),
    };
    render(<BottomSheet {...defaultProps} fontSizeManager={mockManager as unknown as FontSizeManager} />);
    expect(screen.getByText('14px')).toBeInTheDocument();
  });

  it('has fixed height class when expanded', () => {
    const { container } = render(<BottomSheet {...defaultProps} />);
    const sheet = container.firstElementChild as HTMLElement;
    expect(sheet.className).toContain('h-[40vh]');
  });

  it('falls back to input tab when files tab selected but hidden', () => {
    render(<BottomSheet {...defaultProps} showFilesTab={false} activeTab="files" />);
    // Should show input panel (fallback), not files
    expect(screen.getByTestId('input-panel')).toBeInTheDocument();
  });
});
