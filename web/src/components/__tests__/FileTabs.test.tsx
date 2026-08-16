import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTabs } from '../FileTabs';
import type { FileOps, FileEntry } from '../../services/fileOps';

// Minimal fileOps mock: FileBrowser calls listDir on mount, and opening a file
// tab needs readFile for FileViewer.
function makeFileOps(entries: FileEntry[]): FileOps {
  return {
    listDir: vi.fn().mockResolvedValue({ entries }),
    readFile: vi.fn().mockResolvedValue({ path: '/f.txt', content: btoa('hello'), mime_type: 'text/plain' }),
    writeFile: vi.fn().mockResolvedValue({ path: '/f.txt', written: 5 }),
    deleteFile: vi.fn().mockResolvedValue({ path: '/f.txt', success: true }),
    createDir: vi.fn().mockResolvedValue({ path: '/d', success: true }),
    renameFile: vi.fn().mockResolvedValue({ from: '/a', to: '/b', success: true }),
    uploadFile: vi.fn().mockResolvedValue({ path: '/f.txt', written: 5 }),
    base64Decode: (b64: string) => atob(b64),
    base64Encode: (s: string) => btoa(s),
  } as unknown as FileOps;
}

const FILE: FileEntry = { name: 'f.txt', path: 'f.txt', full_path: '/root/f.txt', is_dir: false, size: 5, modified: 0 };

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

// Bottom-bar props are required by FileTabs; tests don't exercise them here.
const bottomBarProps = {
  bottomTab: 'commands' as const,
  onBottomTabChange: vi.fn(),
  sheetOpen: false,
  onSheetToggle: vi.fn(),
  envPanel: null,
  commandsPanel: null,
};

describe('FileTabs', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it('keeps the terminal mounted (not unmounted) when a file tab is active', async () => {
    mockMatchMedia(false);
    const fileOps = makeFileOps([FILE]);
    render(
      <FileTabs
        fileOps={fileOps}
        terminalElement={<div data-testid="terminal-marker">TERMINAL</div>}
        {...bottomBarProps}
      />,
    );

    // Terminal is visible initially.
    expect(screen.getByTestId('terminal-marker')).toBeInTheDocument();

    // Open the side panel and click the file to open a file tab.
    fireEvent.click(screen.getByTitle('Open panel'));
    const fileButton = await screen.findByText('f.txt');
    fireEvent.click(fileButton);

    // A file tab is now active — but the terminal element must STILL be in the
    // DOM (hidden), so its xterm instance and scrollback survive.
    await waitFor(() => {
      const tabs = screen.getAllByRole('tab', { name: /f\.txt/i });
      expect(tabs.length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('terminal-marker')).toBeInTheDocument();
  });

  it('calls onTerminalReveal when switching back to the terminal tab', async () => {
    mockMatchMedia(false);
    const fileOps = makeFileOps([FILE]);
    const onTerminalReveal = vi.fn();
    render(
      <FileTabs
        fileOps={fileOps}
        onTerminalReveal={onTerminalReveal}
        terminalElement={<div data-testid="terminal-marker">TERMINAL</div>}
        {...bottomBarProps}
      />,
    );

    // Open a file tab.
    fireEvent.click(screen.getByTitle('Open panel'));
    fireEvent.click(await screen.findByText('f.txt'));
    await waitFor(() => expect(screen.getAllByRole('tab', { name: /f\.txt/i }).length).toBeGreaterThan(0));

    // Not called yet (terminal was already visible on mount).
    expect(onTerminalReveal).not.toHaveBeenCalled();

    // Switch back to the Terminal tab.
    const tabBar = screen.getByRole('tab', { name: /Terminal/i });
    fireEvent.click(tabBar);

    await waitFor(() => expect(onTerminalReveal).toHaveBeenCalledTimes(1));
  });

  it('on desktop renders the SidePanel and no Files tab', () => {
    mockMatchMedia(false);
    render(
      <FileTabs
        fileOps={makeFileOps([FILE])}
        terminalElement={<div data-testid="terminal-marker">TERMINAL</div>}
        {...bottomBarProps}
      />,
    );
    expect(screen.getByTitle('Open panel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Files/ })).toBeNull();
  });

  it('on mobile hides the SidePanel and shows a Files tab', () => {
    mockMatchMedia(true);
    render(
      <FileTabs
        fileOps={makeFileOps([FILE])}
        terminalElement={<div data-testid="terminal-marker">TERMINAL</div>}
        {...bottomBarProps}
      />,
    );
    expect(screen.queryByTitle('Open panel')).toBeNull();
    expect(screen.getByRole('tab', { name: /Files/ })).toBeInTheDocument();
  });

  it('on mobile, opening a file from the Files panel collapses the sheet', async () => {
    mockMatchMedia(true);
    const onSheetToggle = vi.fn();
    render(
      <FileTabs
        fileOps={makeFileOps([FILE])}
        terminalElement={<div data-testid="terminal-marker">TERMINAL</div>}
        {...bottomBarProps}
        bottomTab={'files'}
        sheetOpen={true}
        onSheetToggle={onSheetToggle}
      />,
    );
    // With bottomTab='files' the Files panel (FileBrowser) is the active content.
    const fileButton = await screen.findByText('f.txt');
    fireEvent.click(fileButton);
    await waitFor(() => expect(onSheetToggle).toHaveBeenCalledWith(false));
  });
});
