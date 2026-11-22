import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Session } from '@/types';
import type { Project } from '@/product/project/types';
import { SessionProjectDialog } from '@/product/project/components/SessionProjectDialog';

// Render dialog content and the select trigger directly: these tests read the
// trigger's selected label, not Radix's portal/pointer behavior.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

const PROJECT_ONE = 'project-00000000-0000-4000-8000-000000000001';
const PROJECT_TWO = 'project-00000000-0000-4000-8000-000000000002';

function makeProject(projectId: string, name: string): Project {
  return {
    project_id: projectId,
    name,
    locations: [],
    created_at: 1,
    updated_at: 1,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent-1:s1',
    agent_id: 'agent-1',
    session_name: 's1',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    project_id: PROJECT_ONE,
    project_revision: 1,
    last_activity: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const projects = [
  makeProject(PROJECT_ONE, 'Nession'),
  makeProject(PROJECT_TWO, 'Ops notes'),
];

function renderDialog(session: Session | null) {
  return render(
    <SessionProjectDialog
      session={session}
      projects={projects}
      busy={false}
      error={null}
      conflict={false}
      onSave={() => {}}
      onClose={() => {}}
    />,
  );
}

describe('SessionProjectDialog membership selection', () => {
  it('keeps the user selection when a live membership refresh changes project_id', () => {
    const { rerender } = renderDialog(makeSession());

    expect(screen.getByTestId('session-project-selected')).toHaveTextContent('Nession');

    // A live push (or a conflict-driven token refresh) reports a newer
    // membership for the same Session. The editor must not replace what the
    // user is about to retry (#4234).
    rerender(
      <SessionProjectDialog
        session={makeSession({ project_id: PROJECT_TWO, project_revision: 2 })}
        projects={projects}
        busy={false}
        error={null}
        conflict={false}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId('session-project-selected')).toHaveTextContent('Nession');
    expect(screen.getByTestId('session-project-dialog')).toHaveTextContent(
      'currently Ops notes',
    );
  });

  it('initializes from the newly opened Session', () => {
    const { rerender } = renderDialog(makeSession());

    expect(screen.getByTestId('session-project-selected')).toHaveTextContent('Nession');

    rerender(
      <SessionProjectDialog
        session={makeSession({
          session_id: 'agent-1:s2',
          session_name: 's2',
          project_id: PROJECT_TWO,
        })}
        projects={projects}
        busy={false}
        error={null}
        conflict={false}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId('session-project-selected')).toHaveTextContent('Ops notes');
  });

  it('marks a preserved conflict visibly', () => {
    render(
      <SessionProjectDialog
        session={makeSession()}
        projects={projects}
        busy={false}
        error="Another change was saved first."
        conflict
        onSave={() => {}}
        onClose={() => {}}
      />,
    );

    const message = screen.getByTestId('session-project-error');
    expect(message).toHaveAttribute('data-conflict', 'true');
    expect(message).toHaveTextContent('Another change was saved first.');
  });
});
