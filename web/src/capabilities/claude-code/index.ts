export { ClaudeCodePlugin, claudeCodeApi } from './ClaudeCodePlugin';
export type {
  ClaudeCodeListRequest,
  ClaudeCodeListResponse,
  ClaudeCodeReadRequest,
  ClaudeCodeReadResponse,
} from './types';

/** What this capability contributes to the shell: its presence state and view. */
export {
  CLAUDE_CODE_ID,
  CLAUDE_CODE_TITLE,
  claudeCodeProjection,
  claudeCodeView,
  resolveClaudeCodeState,
} from './contribution';
