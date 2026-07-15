import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BottomBar } from '../BottomBar';

function setup(overrides: Partial<React.ComponentProps<typeof BottomBar>> = {}) {
  const props = {
    activeTab: 'commands' as const,
    onTabChange: vi.fn(),
    envPanel: <div data-testid="env-panel">ENV</div>,
    commandsPanel: <div data-testid="commands-panel">CMD</div>,
    filesPanel: <div data-testid="files-panel">FILES</div>,
    showFilesTab: false,
    sheetOpen: true,
    onSheetToggle: vi.fn(),
    ...overrides,
  };
  const utils = render(<BottomBar {...props} />);
  return { props, ...utils };
}

describe('BottomBar', () => {
  it('shows Commands and Env tabs but not Files when showFilesTab is false', () => {
    setup({ showFilesTab: false });
    expect(screen.getByRole('button', { name: /Commands/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Env/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Files/ })).toBeNull();
  });

  it('shows the Files tab when showFilesTab is true', () => {
    setup({ showFilesTab: true });
    expect(screen.getByRole('button', { name: /Files/ })).toBeInTheDocument();
  });

  it('renders the files panel when activeTab is files', () => {
    setup({ showFilesTab: true, activeTab: 'files' });
    expect(screen.getByTestId('files-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('commands-panel')).toBeNull();
  });

  it('renders commands panel by default', () => {
    setup({ activeTab: 'commands' });
    expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('files-panel')).toBeNull();
  });

  it('selecting the Files tab activates it and opens the sheet', () => {
    const { props } = setup({ showFilesTab: true, activeTab: 'commands' });
    fireEvent.click(screen.getByRole('button', { name: /Files/ }));
    expect(props.onTabChange).toHaveBeenCalledWith('files');
    expect(props.onSheetToggle).toHaveBeenCalledWith(true);
  });

  it('uses a taller max-height when the Files tab is active', () => {
    const { container } = setup({ showFilesTab: true, activeTab: 'files' });
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('max-h-[85dvh]');
  });

  it('uses the standard max-height for commands/env', () => {
    const { container } = setup({ activeTab: 'commands' });
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('max-h-[70dvh]');
    expect(root.className).not.toContain('max-h-[85dvh]');
  });

  it('does not render the files panel when files is active but the tab is hidden', () => {
    setup({ showFilesTab: false, activeTab: 'files' });
    // Stale 'files' with the tab hidden falls back to commands — no files panel.
    expect(screen.queryByTestId('files-panel')).toBeNull();
    expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
  });
});
