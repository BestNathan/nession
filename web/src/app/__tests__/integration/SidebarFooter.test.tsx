import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SidebarFooter } from '@/app/SidebarFooter';
import type { ConnectionState } from '@/platform/socket/types';

vi.mock('@/platform/server/components/ServerInfoMenu', () => ({
  ServerInfoMenu: () => <div data-testid="server-info-menu" />,
}));

function renderFooter(overrides: Partial<{ connectionStatus: ConnectionState; nodeCount: number }> = {}) {
  return render(
    <SidebarFooter
      domain={null}
      connectionStatus={overrides.connectionStatus ?? 'connected'}
      nodeCount={overrides.nodeCount ?? 3}
    />,
  );
}

describe('SidebarFooter', () => {
  it('shows the server info row directly (no overflow menu, no legacy switch)', () => {
    renderFooter();
    expect(screen.getByTestId('server-info-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('shell-overflow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('use-legacy-dashboard')).not.toBeInTheDocument();
  });

  it('reports the service state and node count while healthy', () => {
    renderFooter();
    // The mockup's foot reads "Connected · 3 nodes", and it draws that line in
    // the steady state. The gate this replaced rendered nothing at all when
    // healthy, which left the foot a 17px empty strip.
    expect(screen.getByText('Connected · 3 nodes')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-foot-dot')).toBeInTheDocument();
  });

  it('singularises one node and names a degraded link', () => {
    renderFooter({ connectionStatus: 'reconnecting', nodeCount: 1 });
    expect(screen.getByText('Reconnecting · 1 node')).toBeInTheDocument();
  });
});
