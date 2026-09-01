import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '@/session-first/workspace/WorkspaceShell';
import { WORKSPACE_TOOLS } from '@/session-first/workspace/tools';
import type { WorkspaceContext } from '@/session-first/workspace/toolTypes';

// Swap only the files tool's layouts for a deterministic stub; the registry
// entries (label/icon/availability) must stay intact so the bar renders all
// three labels and availability logic still runs.
vi.mock('@/session-first/workspace/tools/files', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/session-first/workspace/tools/files')>();
  return {
    filesTool: {
      ...actual.filesTool,
      layout: {
        web: () => <div data-testid="mock-files-web" />,
        app: () => <div />,
      },
    },
  };
});

const ctx: WorkspaceContext = {
  session: null,
  agent: undefined,
  domain: null,
  fileOps: null,
  experience: 'web',
  onToolChange: vi.fn(),
};

describe('WorkspaceShell', () => {
  it('renders the bottom floating tool bar from the registry', () => {
    render(<WorkspaceShell ctx={ctx} activeTool="files" />);
    expect(screen.getByTestId('workspace-tool-bar')).toBeInTheDocument();
    for (const tool of WORKSPACE_TOOLS) {
      expect(screen.getByText(tool.label)).toBeInTheDocument();
    }
  });

  it('renders the active tool web layout', () => {
    render(<WorkspaceShell ctx={ctx} activeTool="files" />);
    expect(screen.getByTestId('mock-files-web')).toBeInTheDocument();
  });

  it('marks unavailable tools disabled in the bar', () => {
    render(<WorkspaceShell ctx={ctx} activeTool="session" />);
    const filesTab = screen.getByRole('tab', { name: 'Files' });
    expect(filesTab).toBeDisabled();
  });

  it('calls onToolChange when a bar item is clicked', async () => {
    const user = userEvent.setup();
    render(<WorkspaceShell ctx={{ ...ctx, fileOps: {} as never }} activeTool="files" />);
    await user.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(ctx.onToolChange).toHaveBeenCalledWith('agent');
  });
});
