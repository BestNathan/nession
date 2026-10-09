import { describe, it, expect } from 'vitest';
import { sessionFromCreateAck } from '@/product/session/model/sessionFromCreateAck';

describe('sessionFromCreateAck (#1430)', () => {
  it('mirrors the registry row the server commits before it answers', () => {
    // The values are the create arm's own (`crates/nession-server/src/server/
    // handler.rs`): a fresh tmux session has one window, no clients, and no
    // pane report. A provisional row that disagreed would flicker when the
    // authoritative one arrives.
    expect(sessionFromCreateAck('agent-7:scratch')).toMatchObject({
      session_id: 'agent-7:scratch',
      agent_id: 'agent-7',
      session_name: 'scratch',
      status: 'detached',
      window_count: 1,
      attached_clients: 0,
      foreground_command: null,
      working_dir: null,
    });
  });

  it('keeps a name that contains its own colon', () => {
    // The server formats `{agent_id}:{name}` and the name is free text, so
    // only the FIRST separator belongs to the format.
    const session = sessionFromCreateAck('agent-7:feat:thing');
    expect(session.agent_id).toBe('agent-7');
    expect(session.session_name).toBe('feat:thing');
  });

  it('falls back to the whole id when there is no separator', () => {
    const session = sessionFromCreateAck('bare');
    expect(session.session_id).toBe('bare');
    expect(session.agent_id).toBe('bare');
    expect(session.session_name).toBe('bare');
  });

  it('stamps activity now, so the row sorts as the newest', () => {
    const before = Date.now();
    const session = sessionFromCreateAck('agent-7:scratch');
    const stamped = Date.parse(session.last_activity);
    expect(stamped).toBeGreaterThanOrEqual(before - 1_000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});
