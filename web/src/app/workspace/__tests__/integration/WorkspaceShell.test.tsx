import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '@/app/workspace/WorkspaceShell';
import type { WorkspaceContext } from '@/app/workspace/toolTypes';

vi.mock('@/app/workspace/tools/files', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/workspace/tools/files')>();
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

function workspaceContext(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    session: {
      session_id: 'agent-1:work',
      agent_id: 'agent-1',
      session_name: 'work',
    } as never,
    agent: { agent_id: 'agent-1' } as never,
    agents: [{ agent_id: 'agent-1' } as never],
    domain: null,
    fileOps: {} as never,
    experience: 'web',
    onToolChange: vi.fn(),
    ...overrides,
  };
}

describe('WorkspaceShell contextual capability presentation', () => {
  it('renders only the opened capability directly and progressively discloses the rest', () => {
    const ctx = workspaceContext();
    render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" />);

    expect(screen.getByTestId('mock-files-web')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tool-files')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tool-session')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: 'More workspace capabilities' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tool-bar')).toHaveAttribute(
      'data-navigation-mode',
      'contextual',
    );
  });

  it('puts available capabilities in More and invokes the selected deeper view', async () => {
    const user = userEvent.setup();
    const onToolChange = vi.fn();
    const ctx = workspaceContext({ onToolChange });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" />);
    await user.click(screen.getByRole('button', { name: 'More workspace capabilities' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Agent' }));

    expect(onToolChange).toHaveBeenCalledWith('agent');
  });

  it('does not advertise unavailable capabilities in direct chrome or More', async () => {
    const user = userEvent.setup();
    const ctx = workspaceContext({ fileOps: null });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="session" />);
    expect(screen.queryByTestId('workspace-tool-files')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More workspace capabilities' }));
    expect(screen.queryByRole('menuitem', { name: 'Files' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Agent' })).toBeInTheDocument();
  });

  it('keeps an unavailable opened capability stable instead of switching arbitrarily', () => {
    const ctx = workspaceContext({ fileOps: null });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="files" />);

    expect(screen.queryByTestId('mock-files-web')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-capability-unavailable')).toHaveTextContent(
      'Files is not available here',
    );
    expect(screen.queryByTestId('workspace-tool-files')).not.toBeInTheDocument();
  });

  it('keeps Claude Code discoverable through its direct capability provider', async () => {
    const user = userEvent.setup();
    const onToolChange = vi.fn();
    const ctx = workspaceContext({ onToolChange });

    render(<WorkspaceShell ctx={ctx} activeCapabilityId="session" />);
    await user.click(screen.getByRole('button', { name: 'More workspace capabilities' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Claude Code' }));

    expect(onToolChange).toHaveBeenCalledWith('claude-code');
  });
});
