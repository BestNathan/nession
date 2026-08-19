import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BottomBar } from '@/components/BottomBar';

function setup(overrides: Partial<React.ComponentProps<typeof BottomBar>> = {}) {
  const props = {
    activeTab: 'commands' as const,
    onTabChange: vi.fn(),
    envPanel: <div data-testid="env-panel">ENV</div>,
    commandsPanel: <div data-testid="commands-panel">CMD</div>,
    inputPanel: <div data-testid="input-panel">INPUT</div>,
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
  it('shows Input, Commands and Env tabs but not Files when showFilesTab is false', () => {
    setup({ showFilesTab: false });
    expect(screen.getByRole('tab', { name: /Input/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Commands/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Env/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Files/ })).toBeNull();
  });

  it('shows the Files tab when showFilesTab is true', () => {
    setup({ showFilesTab: true });
    expect(screen.getByRole('tab', { name: /Files/ })).toBeInTheDocument();
  });

  it('renders the input panel when activeTab is input', () => {
    setup({ activeTab: 'input' });
    expect(screen.getByTestId('input-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('commands-panel')).toBeNull();
  });

  it('renders commands panel when activeTab is commands', () => {
    setup({ activeTab: 'commands' });
    expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('input-panel')).toBeNull();
  });

  it('selecting the Files tab activates it and opens the sheet', () => {
    const { props } = setup({ showFilesTab: true, activeTab: 'commands' });
    fireEvent.click(screen.getByRole('tab', { name: /Files/ }));
    expect(props.onTabChange).toHaveBeenCalledWith('files');
    expect(props.onSheetToggle).toHaveBeenCalledWith(true);
  });

  it('does not render Input tab when inputPanel is not provided', () => {
    setup({ inputPanel: undefined });
    expect(screen.queryByRole('tab', { name: /Input/ })).toBeNull();
  });
});
