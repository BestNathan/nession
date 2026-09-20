import { describe, expect, it } from 'vitest';
import {
  FIXTURE_AGENTS,
  FIXTURE_CLIENT_SESSION_ID,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '../../fixtureData';

describe('fixtureData', () => {
  it('defines a deterministic 6-session / 3-agent matrix', () => {
    expect(FIXTURE_SESSIONS).toHaveLength(6);
    expect(FIXTURE_AGENTS).toHaveLength(3);
  });

  it('includes one offline agent to exercise state-driven emphasis', () => {
    expect(FIXTURE_AGENTS.filter((a) => a.status === 'offline')).toHaveLength(1);
  });

  it('gives every agent a manifest, so the fixture resolves contracts rather than falling back', () => {
    // The fixture route is where git and Claude Code are exercised in a
    // browser. An agent here with no manifest is a Legacy Peer, so every
    // request would go out naming no contract version and the resolution path
    // (#678 Phase 4) would be covered by nothing on this route — while the
    // page still looked exactly right.
    for (const agent of FIXTURE_AGENTS) {
      expect(agent.protocols, `${agent.agent_id} advertises nothing`).toBeTruthy();
      expect(Object.keys(agent.protocols?.protocols ?? {})).toContain('git.status');
    }
  });

  it('includes an exited (zombie) session and a session on the offline agent', () => {
    expect(FIXTURE_SESSIONS.some((s) => s.status === 'zombie')).toBe(true);
    expect(FIXTURE_SESSIONS.some((s) => s.agent_id === 'sg-prod')).toBe(true);
  });

  it('selected session exists and is the attached client session', () => {
    expect(FIXTURE_SESSIONS.some((s) => s.session_id === FIXTURE_SELECTED_ID)).toBe(true);
    expect(FIXTURE_CLIENT_SESSION_ID).toBe(FIXTURE_SELECTED_ID);
  });

  it('session ids follow the agent_id:session_name convention', () => {
    for (const s of FIXTURE_SESSIONS) {
      expect(s.session_id).toBe(`${s.agent_id}:${s.session_name}`);
    }
  });
});
