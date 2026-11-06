import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionMetadataResponse } from '@/product/session/types';
import type { DomainState } from '@/product/session/model/domainState';
import type { Session } from '@/types';

const {
  getMetadataMock,
  updateMetadataMock,
  connectionRevisionMock,
  onConnectionChangeMock,
} = vi.hoisted(() => ({
  getMetadataMock: vi.fn(),
  updateMetadataMock: vi.fn(),
  connectionRevisionMock: vi.fn(() => 1),
  onConnectionChangeMock: vi.fn(() => () => {}),
}));

vi.mock('@/product/session', () => ({
  sessionsApi: {
    getMetadata: getMetadataMock,
    updateMetadata: updateMetadataMock,
    connectionRevision: connectionRevisionMock,
    onConnectionChange: onConnectionChangeMock,
  },
}));

import { SessionDetails } from '@/product/session/components/SessionDetails';
import { resetSessionMetadataCache } from '@/product/session/state/metadata';

const session: Session = {
  session_id: 'devbox-01:fix',
  agent_id: 'devbox-01',
  session_name: 'fix-terminal-reconnect',
  status: 'active',
  window_count: 2,
  attached_clients: 0,
  last_activity: '2026-11-06T00:00:00Z',
};

const domain: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'detached', copy: null },
};

function ok(overrides: Record<string, unknown> = {}): SessionMetadataResponse {
  return {
    success: true,
    metadata: {
      revision: 1,
      title: 'Release triage',
      description: 'Fix the staging run',
      tags: ['release'],
      created_at: 1762300000,
      updated_at: 1762303600,
      ...overrides,
    },
  };
}

beforeEach(() => {
  resetSessionMetadataCache();
  getMetadataMock.mockReset();
  updateMetadataMock.mockReset();
  connectionRevisionMock.mockClear();
  onConnectionChangeMock.mockClear();
});

async function renderLoaded(response: SessionMetadataResponse = ok()) {
  getMetadataMock.mockResolvedValue(response);
  render(<SessionDetails session={session} state={domain} />);
  await waitFor(() => expect(screen.getByTestId('session-metadata-edit')).toBeInTheDocument());
}

describe('SessionDetails metadata', () => {
  it('renders the tmux-name fallback and saves a title through the revision it read', async () => {
    const user = userEvent.setup();
    await renderLoaded({ success: true, metadata: {
      revision: 0, title: null, description: null, tags: [],
      created_at: null, updated_at: null,
    } });
    expect(screen.getByTestId('session-title')).toHaveTextContent('fix-terminal-reconnect');
    expect(screen.getByTestId('session-metadata-description-empty')).toHaveTextContent(
      'no saved details yet',
    );

    await user.click(screen.getByTestId('session-metadata-edit'));
    await user.type(screen.getByTestId('session-metadata-title-input'), 'Release triage');
    updateMetadataMock.mockResolvedValue(ok({ revision: 1 }));

    await user.click(screen.getByTestId('session-metadata-save'));

    await waitFor(() =>
      expect(screen.getByTestId('session-title')).toHaveTextContent('Release triage'),
    );
    expect(updateMetadataMock).toHaveBeenCalledWith(session.session_id, {
      title: 'Release triage',
      description: null,
      tags: [],
      expectedRevision: 0,
    });
    expect(screen.getByTestId('session-metadata-notice')).toHaveTextContent('tmux name');
    expect(screen.getByTestId('session-metadata-view')).toBeInTheDocument();
  });

  it('cancels back to the stored metadata without saving', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByTestId('session-metadata-edit'));
    await user.type(screen.getByTestId('session-metadata-title-input'), ' — discarded');
    await user.click(screen.getByTestId('session-metadata-cancel'));

    expect(updateMetadataMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('session-title')).toHaveTextContent('Release triage');
    await user.click(screen.getByTestId('session-metadata-edit'));
    expect(screen.getByTestId('session-metadata-title-input')).toHaveValue('Release triage');
  });

  it('keeps the draft on a revision conflict until the user discards it', async () => {
    const user = userEvent.setup();
    updateMetadataMock.mockResolvedValue({
      success: false,
      error_kind: 'conflict',
      error: 'expected revision 4, current revision 5',
      metadata: null,
    });
    await renderLoaded(ok({ revision: 4, title: 'Old title' }));

    await user.click(screen.getByTestId('session-metadata-edit'));
    await user.clear(screen.getByTestId('session-metadata-title-input'));
    await user.type(screen.getByTestId('session-metadata-title-input'), 'My draft');
    await user.click(screen.getByTestId('session-metadata-save'));

    const conflict = await screen.findByTestId('session-metadata-conflict');
    expect(within(conflict).getByText(/newer revision/)).toBeInTheDocument();
    expect(screen.getByTestId('session-metadata-title-input')).toHaveValue('My draft');

    getMetadataMock.mockResolvedValue(ok({ revision: 5, title: 'Remote title' }));
    await user.click(screen.getByTestId('session-metadata-reload'));

    await waitFor(() =>
      expect(screen.getByTestId('session-title')).toHaveTextContent('Remote title'),
    );
    expect(screen.queryByTestId('session-metadata-conflict')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-metadata-editor')).not.toBeInTheDocument();
  });

  it('reports an unreachable Agent on save and preserves the draft', async () => {
    const user = userEvent.setup();
    updateMetadataMock.mockResolvedValue({
      success: false,
      error_kind: 'unavailable',
      error: 'Agent is offline',
      metadata: null,
    });
    await renderLoaded();

    await user.click(screen.getByTestId('session-metadata-edit'));
    await user.clear(screen.getByTestId('session-metadata-title-input'));
    await user.type(screen.getByTestId('session-metadata-title-input'), 'Unsaved');
    await user.click(screen.getByTestId('session-metadata-save'));

    const notice = await screen.findByTestId('session-metadata-notice');
    expect(notice).toHaveTextContent('Agent is offline');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('session-metadata-title-input')).toHaveValue('Unsaved');
    expect(screen.getByTestId('session-title')).toHaveTextContent('Release triage');
  });

  it('offers Retry instead of editing when the first read is unreachable', async () => {
    const user = userEvent.setup();
    getMetadataMock.mockRejectedValueOnce(new Error('connection closed'));
    getMetadataMock.mockResolvedValue(ok());
    render(<SessionDetails session={session} state={domain} />);

    const error = await screen.findByTestId('session-metadata-error');
    expect(error).toHaveTextContent('connection closed');
    expect(screen.queryByTestId('session-metadata-edit')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-title')).toHaveTextContent('fix-terminal-reconnect');

    await user.click(screen.getByTestId('session-metadata-retry'));
    await waitFor(() => expect(screen.getByTestId('session-metadata-edit')).toBeInTheDocument());
    expect(screen.getByTestId('session-title')).toHaveTextContent('Release triage');
  });

  it('shows a recorded creation time and never invents one', async () => {
    await renderLoaded();
    expect(screen.getByTestId('session-metadata-created')).toBeInTheDocument();
  });

  it('does not show a creation time when none was recorded', async () => {
    await renderLoaded(ok({ created_at: null }));
    expect(screen.queryByTestId('session-metadata-created')).not.toBeInTheDocument();
  });
});
