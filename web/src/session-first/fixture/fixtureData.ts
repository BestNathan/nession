import type { Agent, Session } from '@/types';

/**
 * Deterministic fixture for the canonical screen (/fixture route).
 * Static timestamps — screenshots remain comparable across runs.
 * Doubles as the Phase 6 (#561) golden-baseline data source.
 *
 * Viewport matrix (e2e):
 * - Web Active Terminal 1440×900 — fixture-canonical.spec.ts
 * - Web Workspace 1440×900 — fixture-workspace.spec.ts
 * - Web compact 1024×768 — fixture-matrix.spec.ts
 * - App Terminal / Workspace 390×844 — fixture-app.spec.ts
 * - App Sessions 390×844 — fixture-matrix.spec.ts
 *
 * Note: rendered relative-time labels (formatRelativeTime) drift with the
 * wall clock; the fixture data itself is static.
 */
export const FIXTURE_AGENTS: Agent[] = [
  {
    agent_id: 'devbox-01',
    hostname: 'devbox-01',
    display_name: 'devbox-01',
    ip_address: '10.0.0.11',
    port: 19091,
    status: 'online',
    session_count: 3,
    last_heartbeat: '2026-09-01T08:00:00Z',
    registered_at: '2026-08-01T00:00:00Z',
  },
  {
    agent_id: 'macbook',
    hostname: 'macbook',
    display_name: 'macbook',
    ip_address: '10.0.0.12',
    port: 19091,
    status: 'online',
    session_count: 2,
    last_heartbeat: '2026-09-01T08:00:00Z',
    registered_at: '2026-08-15T00:00:00Z',
  },
  {
    agent_id: 'sg-prod',
    hostname: 'sg-prod',
    display_name: 'sg-prod',
    ip_address: '10.0.0.21',
    port: 19091,
    status: 'offline',
    session_count: 1,
    last_heartbeat: '2026-09-01T07:30:00Z',
    registered_at: '2026-08-20T00:00:00Z',
  },
];

export const FIXTURE_SESSIONS: Session[] = [
  {
    session_id: 'devbox-01:fix-terminal-reconnect',
    agent_id: 'devbox-01',
    session_name: 'fix-terminal-reconnect',
    status: 'active',
    window_count: 1,
    attached_clients: 1,
    last_activity: '2026-09-01T08:00:00Z',
  },
  {
    session_id: 'devbox-01:design-system',
    agent_id: 'devbox-01',
    session_name: 'design-system',
    status: 'detached',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-09-01T07:40:00Z',
  },
  {
    session_id: 'devbox-01:staging-deploy',
    agent_id: 'devbox-01',
    session_name: 'staging-deploy',
    status: 'zombie',
    window_count: 0,
    attached_clients: 0,
    last_activity: '2026-09-01T03:30:00Z',
  },
  {
    session_id: 'macbook:review-pr-561',
    agent_id: 'macbook',
    session_name: 'review-pr-561',
    status: 'active',
    window_count: 2,
    attached_clients: 1,
    last_activity: '2026-09-01T07:20:00Z',
  },
  {
    session_id: 'macbook:dotfiles',
    agent_id: 'macbook',
    session_name: 'dotfiles',
    status: 'detached',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-09-01T06:10:00Z',
  },
  {
    session_id: 'sg-prod:prod-shell',
    agent_id: 'sg-prod',
    session_name: 'prod-shell',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-09-01T05:00:00Z',
  },
];

export const FIXTURE_SELECTED_ID = 'devbox-01:fix-terminal-reconnect';
export const FIXTURE_CLIENT_SESSION_ID = FIXTURE_SELECTED_ID;
