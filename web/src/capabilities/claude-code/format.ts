import type { ClaudeCodeTranscriptItem } from './types';

/** A byte count the capability's file views print. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What to call a transcript in a list.
 *
 * Claude titles a session but never a subagent — `ai-title` is a session-level
 * record — so the fallback is what sidechains actually get. The provider's id
 * for one is path-shaped, `<session-uuid>/agent-<id>`, and behind `truncate`
 * the tail that distinguishes one subagent from another is the first thing
 * lost, leaving rows that read alike. `agent_id` is on the contract for
 * precisely that job, so it is the fallback before the id.
 */
export function transcriptLabel(transcript: ClaudeCodeTranscriptItem): string {
  return transcript.title ?? transcript.agent_id ?? transcript.id;
}

/**
 * Pretty-print an advertised JSON schema; a value that is not JSON is shown
 * exactly as the server sent it rather than replaced with a parse error.
 */
export function formatSchema(schema: string): string {
  try {
    return JSON.stringify(JSON.parse(schema) as unknown, null, 2);
  } catch {
    return schema;
  }
}
