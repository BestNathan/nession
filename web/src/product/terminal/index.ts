// Terminal transport plugins — pure TypeScript, no React/xterm chain.
// Platform code (`platform/session-runtime`, `platform/attach`) imports from
// this entry point; keep React components out so module-level xterm evaluation
// never leaks into those consumers.
export { ATTACH_TIMEOUT_MS } from './agent';
export { createTerminalAgentApi } from './agent';
export { TERMINAL_PROGRESS_NOTIFICATIONS_V1, readReconcileNotice } from './agent';
export type {
  AgentError,
  TerminalAgentApi,
  TerminalInputAck,
  TerminalOutputAppliedAck,
  TerminalInputSequence,
  TerminalReconcileAction,
  TerminalReconcileNotice,
  TerminalReconcileReason,
  TerminalResizeFrame,
} from './agent';
export { TerminalServerPlugin } from './server';
export { decodeTerminalData } from './base64';
export { terminalServerApi } from './server';
export type { TerminalServerApi, RelaySubscriptionProof } from './server';
export type { AttachResult } from './types';
export type { TerminalSize } from './types';
