/**
 * The claude-code extension UI consumes the canonical capability types from
 * `@/features/claude-code` (single source of truth for the wire contract).
 * The re-exports below keep the extension-local import path stable while the
 * UI migrates onto the feature module singleton (`claudeCodeApi`).
 */
import type { ClaudeCodeListResponse } from '@/features/claude-code';

export type {
  ClaudeCodeListRequest,
  ClaudeCodeListResponse,
  ClaudeCodeReadRequest,
  ClaudeCodeReadResponse,
} from '@/features/claude-code';

/** Presentation aliases over the canonical claude-code list response. */
export type ConfigCategory = ClaudeCodeListResponse['categories'][number];
export type ConfigFile = ConfigCategory['files'][number];
