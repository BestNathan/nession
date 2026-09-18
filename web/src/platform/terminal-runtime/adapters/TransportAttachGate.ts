import type { TerminalStatus } from '../types';

/** Returns true when outbound terminal I/O may be sent to the agent. */
export function createAttachGate(getPhase: () => TerminalStatus): () => boolean {
  return () => getPhase() === 'attached';
}
