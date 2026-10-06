import type { Session } from '@/types';

/**
 * The Session a create ACK describes (#1430).
 *
 * `session_id` is `<agent_id>:<session_name>` by construction: the server
 * builds it from the create request and commits the registry row *before* it
 * answers, so the ACK is already an authoritative handoff. Waiting for the
 * next `sessions` projection to echo the id back adds a list-barrier to the
 * create → attach critical path with no correctness value — under a VPN/LAN
 * address set that wait compounds with the P2P probe (see `useAddressPlan`).
 *
 * The fields mirror the row the server writes at that same moment
 * (`crates/nession-server/src/server/handler.rs`, the create arm): a fresh tmux
 * session has one window, no attached clients, and no pane report yet. So when
 * the authoritative row arrives the projection replaces this one without
 * anything on screen changing.
 *
 * Identity, not guessing: the id is the dialog's own answer, never a name
 * match against the list — `#1082`'s condition holds, and `useShellState`
 * still never selects a same-named Session that is not this id.
 */
export function sessionFromCreateAck(sessionId: string): Session {
  const separator = sessionId.indexOf(':');
  const agentId = separator === -1 ? sessionId : sessionId.slice(0, separator);
  const sessionName = separator === -1 ? sessionId : sessionId.slice(separator + 1);
  return {
    session_id: sessionId,
    agent_id: agentId,
    session_name: sessionName,
    status: 'detached',
    window_count: 1,
    attached_clients: 0,
    foreground_command: null,
    working_dir: null,
    last_activity: new Date().toISOString(),
  };
}
