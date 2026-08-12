// web/src/atoms/connection.ts
import { atom } from 'jotai';

// ── Terminal session state machine ─────────────────────────────

/**
 * Drives all protocol decisions for a terminal session.
 *
 *   idle → connecting        socket created (attachToSessionAtom)
 *   connecting → connected   ws.onopen / relay authenticated
 *   connected → attached     client.attach ok received
 *   connected → reconnecting attach timeout (10s)
 *   connected → failed       agent error (session not found)
 *   attached → reconnecting  socket drop
 *   reconnecting → connecting retry timer fires
 *   reconnecting → failed    max retries (10) exceeded
 *   failed → idle            manual disconnect
 *   any → idle               disconnectAtom / attachToSessionAtom
 */
export const terminalSessionStateAtom = atom<
  'idle' | 'connecting' | 'connected' | 'attached' | 'reconnecting' | 'failed'
>('idle');
