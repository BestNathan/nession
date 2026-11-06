import type { FileOps } from '../types';

/**
 * A file identity: which authorized resource view the path belongs to, plus
 * the path inside that view.
 *
 * `sourceId` is the identity of the transport/provider a Session currently
 * supplies. Paths are only meaningful inside their source; changing source
 * invalidates scoped selection and open-document state instead of retargeting
 * an old path at a different Agent/Location.
 */
export interface FileRef {
  sourceId: string;
  path: string;
}

/**
 * The file capability's view of one resource source.
 *
 * `available` is a capability statement, not a Session-health statement: a
 * Session may be alive while its file provider is unavailable, and there is
 * no silent host fallback. #2681 owns Sandbox policy; this model consumes an
 * already-authorized provider and never infers isolation from a Session id.
 */
export interface FileSource {
  id: string;
  label: string;
  available: boolean;
  reason: string | null;
  fileOps: FileOps | null;
}

export interface FileSourceInput {
  sessionId?: string | null;
  agentId?: string | null;
  agentLabel?: string | null;
  fileOps: FileOps | null | undefined;
}

/**
 * Resolve the current Session-derived default source.
 *
 * The id is derived from the Session first, then the Agent, so a reconnect
 * that keeps the Session keeps document identity; a different source produces
 * a different id and therefore invalidates old references.
 */
export function resolveFileSource(input: FileSourceInput): FileSource {
  const id = input.sessionId
    ? `session:${input.sessionId}`
    : input.agentId
      ? `agent:${input.agentId}`
      : 'unbound';
  const label =
    input.agentLabel ??
    (input.sessionId ? `Session ${input.sessionId}` : 'Workspace files');

  if (!input.fileOps) {
    return {
      id,
      label,
      available: false,
      reason: 'No file provider is available for this Session or location.',
      fileOps: null,
    };
  }

  return { id, label, available: true, reason: null, fileOps: input.fileOps };
}

/** The provider's paths are source-relative; strip only the separators the wire does not own. */
export function normalizeFilePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

export function makeFileRef(source: FileSource, path: string): FileRef | null {
  if (!source.available || !source.fileOps) {
    return null;
  }
  return { sourceId: source.id, path: normalizeFilePath(path) };
}

export function fileRefEquals(a: FileRef | null, b: FileRef | null): boolean {
  return a !== null && b !== null && a.sourceId === b.sourceId && a.path === b.path;
}

export function fileRefKey(ref: FileRef): string {
  return `${ref.sourceId}:${ref.path}`;
}

/** A ref from a previous source must never silently retarget a path in the new one. */
export function isRefInSource(ref: FileRef | null, source: FileSource): ref is FileRef {
  return ref !== null && source.available && ref.sourceId === source.id;
}
