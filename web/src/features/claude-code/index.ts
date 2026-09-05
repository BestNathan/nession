import { ClaudeCodePlugin } from './ClaudeCodePlugin';
export { ClaudeCodePlugin } from './ClaudeCodePlugin';
export type {
  ClaudeCodeListRequest,
  ClaudeCodeListResponse,
  ClaudeCodeReadRequest,
  ClaudeCodeReadResponse,
} from './types';

/** App-level singleton — one claude-code binding per WebSocketService lifetime. */
export const claudeCodeApi = new ClaudeCodePlugin();
