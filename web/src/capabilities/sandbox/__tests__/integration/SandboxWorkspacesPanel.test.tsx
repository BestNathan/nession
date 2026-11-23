import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentWorkspaceDescriptor } from '../../WorkspacePlugin';
import { SandboxWorkspacesPanel } from '../../components/SandboxWorkspacesPanel';

const workspaceApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../WorkspacePlugin', () => ({
  workspaceApi: workspaceApiMock,
  WorkspacePlugin: class WorkspacePlugin {},
}));

function descriptor(
  id: string,
  name: string,
  status: AgentWorkspaceDescriptor['status'],
): AgentWorkspaceDescriptor {
  return {
    workspace_id: id,
    name,
    namespace: 'default',
    kind: 'managed',
    status,
    auto_created: false,
    created_at: 1,
    last_used_at: 2,
  };
}

describe('Sandbox Workspaces panel', () => {
  beforeEach(() => {
    workspaceApiMock.list.mockReset();
    workspaceApiMock.create.mockReset();
    workspaceApiMock.remove.mockReset();
    workspaceApiMock.list.mockResolvedValue([
      descriptor('ws_00000000-0000-4000-8000-000000000001', 'alpha', 'available'),
      descriptor('ws_00000000-0000-4000-8000-000000000002', 'beta', 'in_use'),
    ]);
    workspaceApiMock.remove.mockResolvedValue(undefined);
  });

  it('mounts the delete confirmation only while it is open so a reopen never reuses the portal', async () => {
    render(<SandboxWorkspacesPanel sessionId="a1:s1" />);
    await screen.findByText('alpha');

    // Nothing to confirm while closed: a fresh portal per open, not a
    // controlled reuse that could reorder the scrim above the content.
    expect(screen.queryByTestId('sandbox-workspace-delete-confirm')).toBeNull();

    await screen.getByRole('button', { name: 'Delete Workspace alpha' }).click();
    expect(await screen.findByTestId('sandbox-workspace-delete-confirm')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByTestId('sandbox-workspace-delete-confirm')).toBeNull(),
    );

    // Reopen immediately after the close: this is the order flip the old
    // always-mounted dialog could hit.
    await screen.getByRole('button', { name: 'Delete Workspace alpha' }).click();
    const confirm = await screen.findByTestId('sandbox-workspace-delete-confirm');
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(workspaceApiMock.remove).toHaveBeenCalledWith(
        'a1:s1',
        'ws_00000000-0000-4000-8000-000000000001',
      ),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('sandbox-workspace-delete-confirm')).toBeNull(),
    );

    // A leased Workspace cannot even open the confirmation (#3797 SC-02).
    expect(
      screen.getByRole('button', { name: 'Delete Workspace beta' }),
    ).toBeDisabled();
  });

  it('expands one Workspace detail and never offers delete for a user-owned Project Location', async () => {
    workspaceApiMock.list.mockResolvedValue([
      descriptor('ws_00000000-0000-4000-8000-000000000001', 'alpha', 'available'),
      {
        ...descriptor(
          'project_location:devbox-01:/srv/nession',
          'nession',
          'unobserved',
        ),
        kind: 'project_location',
        path: '/srv/nession',
      },
    ]);
    render(<SandboxWorkspacesPanel sessionId="a1:s1" agentLabel="devbox-01" />);
    await screen.findByText('alpha');

    await userEvent.click(screen.getAllByTestId('sandbox-workspace-row-select')[0]);
    const detail = await screen.findByTestId('sandbox-workspace-detail');
    expect(detail).toHaveTextContent('Agent-managed');
    expect(detail).toHaveTextContent('devbox-01');
    expect(detail).toHaveTextContent('Not measured');

    const locationRow = screen
      .getAllByTestId('sandbox-workspace-row')
      .find((row) => row.getAttribute('data-workspace-kind') === 'project_location');
    expect(locationRow).toBeDefined();
    expect(locationRow).toHaveTextContent('user-owned');
    expect(within(locationRow as HTMLElement).getByTestId('sandbox-workspace-no-delete')).toBeVisible();
    expect(within(locationRow as HTMLElement).queryByTestId('sandbox-workspace-delete')).toBeNull();
  });
});
