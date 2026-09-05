import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardHeader } from '@/components/DashboardHeader';
import type { ServerInfo } from '@/types';

// The header embeds ServerInfoMenu, which fetches through the serverApi
// singleton — no WebSocketService involved.
const { serverInfoMock } = vi.hoisted(() => ({
  serverInfoMock: vi.fn(),
}));
vi.mock('@/features/server', () => ({
  serverApi: { serverInfo: serverInfoMock },
}));

function makeServerInfo(overrides: Partial<ServerInfo> = {}): ServerInfo {
  return {
    version: '1.2.3',
    image_tag: 'sha-abc123',
    uptime_seconds: 61,
    agent_count: 2,
    online_agent_count: 1,
    session_count: 5,
    build_time: '2026-08-22T06:30:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  serverInfoMock.mockReset();
  serverInfoMock.mockResolvedValue(makeServerInfo());
});

function renderHeader(extra?: { onSessionFirst?: () => void }) {
  return render(
    <DashboardHeader
      connectionStatus="connected"
      searchProps={{
        query: '',
        setQuery: vi.fn(),
        statusFilter: 'all',
        setStatusFilter: vi.fn(),
        onlineCount: 1,
        offlineCount: 1,
      }}
      actionsProps={{
        fetchSessions: vi.fn(),
        onOpenEnv: vi.fn(),
        loadingAgents: false,
        clearError: vi.fn(),
      }}
      error={null}
      onSessionFirst={extra?.onSessionFirst}
    />,
  );
}

describe('DashboardHeader', () => {
  describe('server info — mobile collapsed behind icon', () => {
    it('keeps the full inline strip on desktop only (hidden below md)', async () => {
      renderHeader();

      const strip = await screen.findByTestId('server-info-inline');
      expect(strip.className).toContain('hidden');
      expect(strip.className).toContain('md:flex');
      // The desktop strip still shows the version details inline.
      expect(within(strip).getByText(/srv v1\.2\.3/)).toBeInTheDocument();
    });

    it('shows an icon-only trigger on mobile instead of the inline strip', async () => {
      renderHeader();

      await screen.findByTestId('server-info-inline');
      // The mobile block (and its Info trigger) is only visible below md.
      const mobile = screen.getByTestId('server-info-mobile');
      expect(mobile.className).toContain('md:hidden');
      expect(screen.getByRole('button', { name: 'Server info' })).toBeInTheDocument();
    });

    it('expands the version details when the mobile icon is clicked', async () => {
      const user = userEvent.setup();
      renderHeader();

      await user.click(await screen.findByRole('button', { name: 'Server info' }));

      const details = await screen.findByTestId('server-info-details');
      // Server + web versions (image tag repeats on both rows).
      expect(within(details).getByText(/^v1\.2\.3/)).toBeInTheDocument();
      expect(within(details).getAllByText(/\(sha-abc123\)/).length).toBeGreaterThan(0);
      expect(within(details).getByText('Built')).toBeInTheDocument();
      expect(within(details).getByText('Uptime')).toBeInTheDocument();
      expect(within(details).getByText(/1\/2 online/)).toBeInTheDocument();
      expect(within(details).getByText('5')).toBeInTheDocument();
    });

    it('sizes the dropdown wide enough for full version rows', async () => {
      const user = userEvent.setup();
      renderHeader();

      await user.click(await screen.findByRole('button', { name: 'Server info' }));

      const popup = (await screen.findByTestId('server-info-details'))
        .closest('[data-slot="dropdown-menu-content"]');
      expect(popup?.className).toContain('min-w-60');
    });

    it('omits the built row when the server has no build time', async () => {
      const user = userEvent.setup();
      serverInfoMock.mockResolvedValueOnce(
        makeServerInfo({ build_time: '', image_tag: 'dev' }),
      );
      renderHeader();

      await user.click(await screen.findByRole('button', { name: 'Server info' }));

      await screen.findByTestId('server-info-details');
      expect(screen.queryByText('Built')).not.toBeInTheDocument();
    });
  });

  describe('session-first preview', () => {
    it('renders the preview button and clicking calls onSessionFirst', async () => {
      const onSessionFirst = vi.fn();
      const user = userEvent.setup();
      renderHeader({ onSessionFirst });

      const button = screen.getByTestId('use-session-first');
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent('Session-first preview');

      await user.click(button);
      expect(onSessionFirst).toHaveBeenCalledTimes(1);
    });
  });
});
