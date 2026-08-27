import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionsSection } from '@/components/SessionsSection';
import type { Agent } from '@/types';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'server-01',
    ip_address: '10.0.0.1',
    port: 8080,
    status: 'online',
    session_count: 0,
    last_heartbeat: new Date().toISOString(),
    ...overrides,
  };
}

function renderSection(props: Partial<Parameters<typeof SessionsSection>[0]> = {}) {
  return render(
    <SessionsSection
      agents={[]}
      filteredSessions={[]}
      loadingSessions={false}
      onCreate={vi.fn()}
      fetchSessions={vi.fn()}
      onAttach={vi.fn()}
      onKill={vi.fn()}
      onPreview={vi.fn()}
      sortField="name"
      sortDirection="asc"
      toggleSort={vi.fn()}
      isSearchActive={false}
      {...props}
    />,
  );
}

describe('SessionsSection', () => {
  describe('mobile action buttons', () => {
    it('renders Create as an icon-only button below md, aligned with Refresh', () => {
      renderSection();

      const create = screen.getByRole('button', { name: 'Create session' });
      // Square 36px touch target, matching the session-row actions.
      expect(create.className).toContain('min-h-9');
      expect(create.className).toContain('min-w-9');
      // Text label only above md.
      const label = create.querySelector('span');
      expect(label?.className).toContain('hidden');
      expect(label?.className).toContain('md:inline');

      // Refresh sits next to it at the same size.
      const refresh = screen.getByRole('button', { name: 'Refresh sessions' });
      expect(refresh.className).toContain('min-h-9');
      expect(refresh.className).toContain('min-w-9');
    });

    it('disables Create when every agent is offline', () => {
      renderSection({ agents: [makeAgent({ status: 'offline' })] });

      expect(screen.getByRole('button', { name: 'Create session' })).toBeDisabled();
    });

    it('enables Create when at least one agent is online', () => {
      renderSection({ agents: [makeAgent({ status: 'online' }), makeAgent({ status: 'offline' })] });

      expect(screen.getByRole('button', { name: 'Create session' })).toBeEnabled();
    });

    it('calls onCreate when Create is clicked', async () => {
      const user = userEvent.setup();
      const onCreate = vi.fn();
      renderSection({ agents: [makeAgent()], onCreate });

      await user.click(screen.getByRole('button', { name: 'Create session' }));
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
  });
});
