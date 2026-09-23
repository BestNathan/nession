import type { ProtocolManifest } from '@/platform/protocol';
import type { Agent, Session } from '@/types';

/**
 * What the fixture's agents advertise (`#678`).
 *
 * The three fixture agents run the same build, so they serve the same set —
 * exactly as three real agents started from one image would. Declared here
 * rather than left off because a fixture agent with no manifest is a **Legacy
 * Peer**: every git and Claude Code request would go out naming no contract
 * version, and the resolution path those capabilities now have would be
 * exercised by nothing on the fixture route.
 *
 * The ids are canonical (`git.status`), not wire strings
 * (`git.status`) — the wire spelling is the projection, and this is
 * the contract.
 */
const FIXTURE_MANIFEST: ProtocolManifest = {
  provider: 'fixture',
  protocols: {
    'git.status': { versions: [1], wire: ['git.status'] },
    'git.diff': { versions: [1], wire: ['git.diff'] },
    'git.root': { versions: [1], wire: ['git.root'] },
    'git.log': { versions: [1], wire: ['git.log'] },
    'git.branches': { versions: [1], wire: ['git.branches'] },
    'git.worktrees': { versions: [1], wire: ['git.worktrees'] },
    'claude-code.list': { versions: [1], wire: ['claude-code.list'] },
    'claude-code.read': { versions: [1], wire: ['claude-code.read'] },
  },
};

/**
 * Deterministic fixture for the canonical screen (/fixture route).
 * Static timestamps — screenshots remain comparable across runs.
 * Doubles as the Phase 6 (#561) golden-baseline data source.
 *
 * Viewport matrix (e2e):
 * - Web Active Terminal 1440×900 — fixture-canonical.spec.ts + fixture-visual.spec.ts
 * - Web Workspace 1440×900 — fixture-workspace.spec.ts + fixture-visual.spec.ts
 * - Web compact 1024×768 — fixture-matrix.spec.ts + fixture-visual.spec.ts
 * - App Terminal / Workspace / Sessions 390×844 — fixture-app.spec.ts + fixture-visual.spec.ts
 *
 * Visual baselines: e2e/specs/__snapshots__/fixture-visual.spec.ts/ (Phase 7 #561).
 * Frozen clock: e2e/helpers/fixtureVisual.ts FIXTURE_FROZEN_TIME (visual regression only).
 *
 * Note: without the frozen clock, relative-time labels (formatRelativeTime) drift with the
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
    protocols: FIXTURE_MANIFEST,
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
    protocols: FIXTURE_MANIFEST,
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
    protocols: FIXTURE_MANIFEST,
  },
];

/**
 * The Session rows.
 *
 * `foreground_command` is the command the agent reports for the pane
 * (`#{pane_current_command}`), which is what the row's workload hint renders.
 * Five rows carry one and the last does not, so the canonical screen shows both
 * the reported hint and the `unknown` fallback the pattern documents — a screen
 * where every row said `unknown` would depict a Session list the agent has
 * never reported on, which is the one state the fixture should not make
 * canonical. These are raw command names rather than product labels because
 * that is what the wire carries; naming the product here would put capability
 * knowledge in the fixture that the product reads from the capability layer.
 */
export const FIXTURE_SESSIONS: Session[] = [
  {
    session_id: 'devbox-01:fix-terminal-reconnect',
    agent_id: 'devbox-01',
    session_name: 'fix-terminal-reconnect',
    status: 'active',
    window_count: 1,
    attached_clients: 1,
    // **The selected Session runs something that is not a capability**, and that
    // is load-bearing rather than incidental.
    //
    // `emergence.ts` emerges the capability a Session is *observed running*, so
    // an `active` foreground command here makes Claude Code emerge on the
    // canonical screen at rest. That is correct product behaviour — and it broke
    // `fixture-app.spec.ts`'s dismissal step, which opens Git, dismisses it, and
    // expects the numbers to return to dormant: a second capability legitimately
    // emerged, so they did not.
    //
    // The spec's own invariant (an emerged capability must not reflow the
    // terminal) still held — that test's geometry assertions passed throughout.
    // What broke was its scaffolding, and the fixture is the right place to fix
    // that: a canonical screen should be at rest, and the spec reaches the
    // capability it tests by *opening* it through the picker anyway.
    foreground_command: 'bash',
    last_activity: '2026-09-01T08:00:00Z',
  },
  {
    session_id: 'devbox-01:design-system',
    agent_id: 'devbox-01',
    session_name: 'design-system',
    status: 'detached',
    window_count: 1,
    attached_clients: 0,
    foreground_command: 'codex',
    last_activity: '2026-09-01T07:40:00Z',
  },
  {
    session_id: 'devbox-01:staging-deploy',
    agent_id: 'devbox-01',
    session_name: 'staging-deploy',
    status: 'zombie',
    window_count: 0,
    attached_clients: 0,
    foreground_command: 'bash',
    last_activity: '2026-09-01T03:30:00Z',
  },
  {
    session_id: 'macbook:review-pr-561',
    agent_id: 'macbook',
    session_name: 'review-pr-561',
    status: 'active',
    window_count: 2,
    attached_clients: 1,
    foreground_command: 'claude',
    last_activity: '2026-09-01T07:20:00Z',
  },
  {
    session_id: 'macbook:dotfiles',
    agent_id: 'macbook',
    session_name: 'dotfiles',
    status: 'detached',
    window_count: 1,
    attached_clients: 0,
    foreground_command: 'zsh',
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
