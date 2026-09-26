import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppLayout } from '@/app/experiences/app/AppLayout';
import type { DomainState } from '@/product/session/model/domainState';
import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';
import type { Agent, Session } from '@/types';

/**
 * The depth control the Workspace layer hands its capability. Captured through a
 * stubbed shell so a test can declare a push the way `FilesAppLayout` does.
 */
const captured = vi.hoisted(() => ({ depth: null as WorkspaceDepthControl | null }));

vi.mock('@/app/workspace/WorkspaceShell', () => ({
  WorkspaceShell: ({ depth }: { depth?: WorkspaceDepthControl }) => {
    captured.depth = depth ?? null;
    // Shell chrome, deliberately: the suppression is not about work surfaces —
    // it holds for chrome too, which is where the pre-#1081 route lived.
    return <div data-testid="stub-page-header" />;
  },
}));

vi.mock('@/app/TerminalRegion', () => ({
  TerminalRegion: () => <div data-testid="terminal" />,
}));

const agent: Agent = {
  agent_id: 'a1',
  hostname: 'devbox-01',
  display_name: 'devbox-01',
  ip_address: '10.0.0.1',
  port: 19091,
  status: 'online',
  session_count: 1,
  last_heartbeat: '2026-09-01T08:00:00Z',
};

const sess: Session = {
  session_id: 'a1:fix',
  agent_id: 'a1',
  session_name: 'Fix terminal reconnect',
  status: 'active',
  window_count: 1,
  attached_clients: 0,
  last_activity: '2026-09-01T08:00:00Z',
};

const domain: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'attached', copy: null },
};

function renderLayout(onLayerChange = vi.fn()) {
  render(
    <AppLayout
      layer="workspace"
      onLayerChange={onLayerChange}
      sidebarProps={{
        agents: [agent],
        filteredSessions: [sess],
        staleAgents: [],
        selectedId: sess.session_id,
        clientSessionId: 'client-1',
        connectionStatus: 'connected',
        domain,
        loadingSessions: false,
        searchQuery: '',
        setSearchQuery: vi.fn(),
        statusFilter: 'all',
        setStatusFilter: vi.fn(),
        sortField: 'name',
        sortDirection: 'desc',
        toggleSort: vi.fn(),
        isSearchActive: false,
        onCreate: vi.fn(),
        onRefresh: vi.fn(),
        onConfigure: vi.fn(),
        onKill: vi.fn(),
      }}
      onLayerSelect={vi.fn()}
      mainShared={{
        selectedSession: sess,
        selectedAgent: agent,
        agents: [agent],
        domain,
        tool: 'files',
        fileOps: null,
        onSurfaceChange: vi.fn(),
        onToolChange: vi.fn(),
      }}
      workspaceAvailable
    />,
  );
  return onLayerChange;
}

/** A rightward drag on the Workspace layer's chrome — the page back to Terminal. */
function swipeRight(target: HTMLElement) {
  fireEvent.touchStart(target, { touches: [{ clientX: 20, clientY: 300 }] });
  fireEvent.touchMove(target, { touches: [{ clientX: 100, clientY: 300 }] });
  fireEvent.touchMove(target, { touches: [{ clientX: 180, clientY: 300 }] });
  fireEvent.touchEnd(target);
}

function declarePush() {
  act(() => {
    captured.depth?.setPush({ title: 'App.tsx', onLeave: vi.fn() });
  });
}

describe('AppLayout — a pushed Workspace detail silences the shell pager (#1081)', () => {
  it('pages the Workspace layer back to the Terminal from its root', () => {
    const onLayerChange = renderLayout();

    swipeRight(screen.getByTestId('stub-page-header'));

    expect(onLayerChange).toHaveBeenCalledWith('terminal');
  });

  it('stops paging once a capability pushes a detail', () => {
    // The whole chain, in one test — the panel reports, AppLayout carries the
    // report to AppLayers, and the pager stands down. Breaking any single link
    // leaves every other test in the suite green, which is why this one exists
    // rather than three narrower ones.
    const onLayerChange = renderLayout();
    swipeRight(screen.getByTestId('stub-page-header'));
    expect(onLayerChange).toHaveBeenCalledTimes(1);

    declarePush();
    swipeRight(screen.getByTestId('stub-page-header'));

    // Still once: the shell's leave would have discarded whatever the
    // capability's Back is guarding.
    expect(onLayerChange).toHaveBeenCalledTimes(1);
  });

  it('pages again after the capability pops back to its root', () => {
    const onLayerChange = renderLayout();
    declarePush();

    act(() => {
      captured.depth?.setPush(null);
    });
    swipeRight(screen.getByTestId('stub-page-header'));

    expect(onLayerChange).toHaveBeenCalledWith('terminal');
  });
});
