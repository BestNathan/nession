import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@/types';

const { getMetadataMock } = vi.hoisted(() => ({ getMetadataMock: vi.fn() }));

vi.mock('@/product/session', () => ({
  sessionsApi: {
    getMetadata: getMetadataMock,
    connectionRevision: vi.fn(() => 1),
    onConnectionChange: vi.fn(() => () => {}),
  },
}));

import { SessionList } from '@/product/session/patterns/SessionList';
import { resetSessionMetadataCache } from '@/product/session/state/metadata';

const session: Session = {
  session_id: 'devbox-01:fix',
  agent_id: 'devbox-01',
  session_name: 'fix-terminal-reconnect',
  status: 'active',
  window_count: 1,
  attached_clients: 0,
  last_activity: '2026-11-06T00:00:00Z',
};

beforeEach(() => {
  resetSessionMetadataCache();
  getMetadataMock.mockReset();
});

function renderList() {
  render(
    <SessionList
      sessions={[session]}
      agents={[]}
      staleAgentIds={[]}
      selectedId={null}
      clientSessionId=""
      onSelect={vi.fn()}
    />,
  );
}

describe('SessionList display identity', () => {
  it('uses the metadata title when the Agent has one', async () => {
    getMetadataMock.mockResolvedValue({
      success: true,
      metadata: {
        revision: 2,
        title: 'Terminal reconnect reliability',
        description: null,
        tags: ['terminal'],
        created_at: 1762300000,
        updated_at: 1762303600,
      },
    });
    renderList();

    await waitFor(() =>
      expect(screen.getByTestId('session-item-devbox-01:fix')).toHaveTextContent(
        'Terminal reconnect reliability',
      ),
    );
    // Metadata never replaces the tmux identity in navigation.
    expect(screen.getByTestId('session-item-devbox-01:fix')).not.toHaveTextContent(
      'fix-terminal-reconnect',
    );
  });

  it('falls back to the tmux name when metadata is absent or unreachable', async () => {
    getMetadataMock.mockRejectedValue(new Error('connection closed'));
    renderList();

    await waitFor(() => expect(getMetadataMock).toHaveBeenCalled());
    expect(screen.getByTestId('session-item-devbox-01:fix')).toHaveTextContent(
      'fix-terminal-reconnect',
    );
  });
});
