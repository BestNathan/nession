// Terminal capability plugins — pure TypeScript, no React/xterm chain.
// Runtime code (SessionRuntime, relayServerConnection) imports from this
// entry point; keep React components out so module-level xterm evaluation
// never leaks into runtime consumers.
export { ATTACH_TIMEOUT_MS } from './agent';
export { createTerminalAgentApi } from './agent';
export type { AgentError, TerminalAgentApi } from './agent';
export { TerminalServerPlugin } from './server';
export { decodeTerminalData } from './base64';
export { terminalServerApi } from './server';
export type { TerminalServerApi } from './server';
export type { AttachResult } from './types';
export type { TerminalSize } from './types';
