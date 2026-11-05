/**
 * Classify a file-mutation failure into the action the user can take.
 *
 * The wire carries a code in the agent error envelope, but the client request
 * rejects with the message. The agent prefixes the message with the stable
 * `already_exists`/`conflict` token, which is what this reads; it does not
 * parse the human-readable remainder.
 */
export type FileErrorKind = 'already_exists' | 'conflict' | 'unavailable' | 'other';

export function fileErrorKind(error: unknown): FileErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (/already_exists/i.test(message)) {
    return 'already_exists';
  }
  if (/\bconflict\b/i.test(message)) {
    return 'conflict';
  }
  if (/not connected|not available|no file provider|unavailable/i.test(message)) {
    return 'unavailable';
  }
  return 'other';
}

/** A user-facing sentence for a failed file action. */
export function fileErrorMessage(error: unknown, action: string): string {
  switch (fileErrorKind(error)) {
    case 'already_exists':
      return `Could not ${action}: that name already exists.`;
    case 'conflict':
      return `Could not ${action}: the file changed after you opened it. Reload it or save again to overwrite.`;
    case 'unavailable':
      return `Could not ${action}: files are unavailable for this Session or location.`;
    default:
      return error instanceof Error && error.message
        ? `Could not ${action}: ${error.message}`
        : `Could not ${action}.`;
  }
}
