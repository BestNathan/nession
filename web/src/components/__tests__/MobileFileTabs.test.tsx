import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobileFileTabs } from '../MobileFileTabs';
import type { FileOps, FileEntry } from '../../services/fileOps';

// Mock useFileTabs to return controlled state for rendering tests.
// The hook's internal logic is tested via FileTabs.test.tsx.
const mockUseFileTabs = vi.fn();
vi.mock('../../hooks/useFileTabs', () => ({
  useFileTabs: (...args: unknown[]) => mockUseFileTabs(...args),
  MAX_TABS: 10,
}));

function makeFileOps(): FileOps {
  return {
    listDir: vi.fn().mockResolvedValue({ entries: [] }),
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

function defaultHookReturn(overrides: Record<string, unknown> = {}) {
  return {
    openFiles: [],
    activeTabId: 'terminal',
    setActiveTabId: vi.fn(),
    dirtyFiles: new Set<string>(),
    activeFile: undefined,
    showTerminal: true,
    handleFileClick: vi.fn(),
    handleCloseFile: vi.fn(),
    handleDirtyChange: vi.fn(),
    handleFileDeleted: vi.fn(),
    handleFileRenamed: vi.fn(),
    ...overrides,
  };
}

describe('MobileFileTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFileTabs.mockImplementation(() => defaultHookReturn());
  });

  const TERMINAL = <div data-testid="terminal-marker">TERMINAL</div>;
  const baseProps = {
    fileOps: makeFileOps(),
    terminalElement: TERMINAL,
    onFileClickRef: { current: null },
  };

  it('renders terminal when no files are open, no tab strip', () => {
    render(<MobileFileTabs {...baseProps} />);

    expect(screen.getByTestId('terminal-marker')).toBeInTheDocument();
    // No tab strip — no "Terminal" button should be visible
    expect(screen.queryByRole('button', { name: /Terminal/ })).toBeNull();
  });

  it('shows tab strip with Terminal + file tabs when files are open', () => {
    mockUseFileTabs.mockImplementation(() =>
      defaultHookReturn({
        openFiles: [{ id: 'f1', path: '/config.ts', filename: 'config.ts' }],
        activeTabId: 'f1',
        activeFile: { id: 'f1', path: '/config.ts', filename: 'config.ts' },
        showTerminal: false,
      }),
    );

    render(<MobileFileTabs {...baseProps} />);

    // Tab strip visible — Terminal button + file tab button
    expect(screen.getByRole('button', { name: /Terminal/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /config\.ts/i })).toBeInTheDocument();

    // Terminal element still in DOM (hidden)
    expect(screen.getByTestId('terminal-marker')).toBeInTheDocument();
  });

  it('hides tab strip when last file is closed', () => {
    const { rerender } = render(<MobileFileTabs {...baseProps} />);

    // No tab strip initially
    expect(screen.queryByRole('button', { name: /Terminal/ })).toBeNull();

    // Simulate opening a file
    mockUseFileTabs.mockImplementation(() =>
      defaultHookReturn({
        openFiles: [{ id: 'f1', path: '/a.ts', filename: 'a.ts' }],
        activeTabId: 'f1',
        activeFile: { id: 'f1', path: '/a.ts', filename: 'a.ts' },
        showTerminal: false,
      }),
    );
    rerender(<MobileFileTabs {...baseProps} />);
    expect(screen.getByRole('button', { name: /Terminal/ })).toBeInTheDocument();

    // Simulate closing the file
    mockUseFileTabs.mockImplementation(() => defaultHookReturn());
    rerender(<MobileFileTabs {...baseProps} />);
    expect(screen.queryByRole('button', { name: /Terminal/ })).toBeNull();
  });

  it('exposes handleFileClick via onFileClickRef', () => {
    const ref = { current: null } as React.MutableRefObject<((entry: FileEntry) => void) | null>;
    const handleClick = vi.fn();
    mockUseFileTabs.mockImplementation(() =>
      defaultHookReturn({ handleFileClick: handleClick }),
    );

    render(<MobileFileTabs {...baseProps} onFileClickRef={ref} />);

    expect(ref.current).toBe(handleClick);
  });

  it('terminal element stays mounted when file tab is active', () => {
    mockUseFileTabs.mockImplementation(() =>
      defaultHookReturn({
        openFiles: [{ id: 'f1', path: '/f.ts', filename: 'f.ts' }],
        activeTabId: 'f1',
        activeFile: { id: 'f1', path: '/f.ts', filename: 'f.ts' },
        showTerminal: false,
      }),
    );

    render(<MobileFileTabs {...baseProps} />);

    // Terminal is in DOM (hidden via CSS) so xterm instance survives
    expect(screen.getByTestId('terminal-marker')).toBeInTheDocument();
  });
});
