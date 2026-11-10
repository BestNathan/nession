import type { FileEntry, FileOps } from '@/capabilities/files';
import { normalizeTerminalFilePath } from '@/product/terminal/workspaceFileLinks';

export interface TerminalFileTarget {
  /** Source-canonical path: workspace-relative inside the source root, absolute outside it. */
  path: string;
  name: string;
  size: number;
  line?: number;
  column?: number;
}

export type TerminalFileResolution =
  | { ok: true; target: TerminalFileTarget }
  | { ok: false; reason: string };

/**
 * Join a terminal-relative reference onto the Session's current source CWD.
 *
 * `file.cwd` already speaks the file source's own path convention: relative
 * inside the source root, absolute when the Session's shell sits outside it.
 * The base is used exactly as reported and the reference is normalized after
 * the join, so `../` pops a real segment instead of being string-stripped.
 */
export function joinTerminalFileReference(cwd: string, path: string): string {
  const reference = normalizeTerminalFilePath(path);
  if (reference.startsWith('/')) {
    return reference;
  }
  const base = normalizeTerminalFilePath(cwd);
  if (base === '' || base === '/') {
    return reference;
  }
  return normalizeTerminalFilePath(`${base}/${reference}`);
}

/** Source directory containing `path` (`''` at a relative source root, `/` at filesystem root). */
export function sourceParentDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash < 0) {
    return '';
  }
  if (slash === 0) {
    return '/';
  }
  return path.slice(0, slash);
}

function missingReason(path: string): string {
  return `Could not open ${path} — the file may have been moved or deleted.`;
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not_found|no such file|does not exist/i.test(message);
}

/**
 * Resolve one activated Terminal file reference against the active Session's
 * bound FileOps source.
 *
 * The rules are deliberately narrow (#3187):
 * - a relative reference is resolved against the Session's current CWD at
 *   activation time — never against the workspace root;
 * - an absolute reference keeps its absolute meaning on this same source;
 * - existence is verified by listing the parent and matching the exact
 *   normalized path, so a missing or ambiguous reference never falls back to a
 *   same-basename file elsewhere;
 * - a directory, a missing file or an unavailable source is returned as a
 *   reason, never turned into a different open target.
 */
export async function resolveTerminalFileReference(
  fileOps: FileOps,
  sessionId: string,
  reference: { path: string; line?: number; column?: number },
): Promise<TerminalFileResolution> {
  const normalized = normalizeTerminalFilePath(reference.path);
  if (normalized === '' || normalized === '/' || normalized.endsWith('/')) {
    return { ok: false, reason: missingReason(reference.path) };
  }

  let candidate: string;
  try {
    if (normalized.startsWith('/')) {
      candidate = normalized;
    } else {
      const { path: cwd } = await fileOps.getCwd(sessionId);
      candidate = joinTerminalFileReference(cwd, normalized);
    }
  } catch {
    return {
      ok: false,
      reason: 'Could not determine the Session’s working directory — Files may be unavailable.',
    };
  }

  const parent = sourceParentDirectory(candidate);
  let entries: FileEntry[];
  try {
    ({ entries } = await fileOps.listDir(parent));
  } catch (error) {
    if (isNotFound(error)) {
      return { ok: false, reason: missingReason(candidate) };
    }
    return {
      ok: false,
      reason: 'Could not read the file’s directory — the Files source may be unavailable.',
    };
  }

  const exact = entries.filter(
    (entry) => entry.path === candidate || entry.full_path === candidate,
  );
  let matches = exact;
  if (matches.length === 0 && candidate.startsWith('/')) {
    // The exact parent was listed, but the source reported the entry under
    // another spelling of the same directory (macOS `/tmp` is `/private/tmp`,
    // and a symlinked CWD does the same). The referenced parent is already
    // fixed, so the one child with the referenced name is that exact target —
    // this is not a workspace-wide basename search.
    const name = candidate.slice(candidate.lastIndexOf('/') + 1);
    matches = entries.filter((entry) => entry.name === name);
  }
  if (matches.length === 0) {
    return { ok: false, reason: missingReason(candidate) };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `Could not open ${candidate} — the reference is ambiguous in this source.`,
    };
  }
  const entry = matches[0]!;
  if (entry.is_dir) {
    return {
      ok: false,
      reason: `Could not open ${candidate} — it is a directory, not a file.`,
    };
  }
  return {
    ok: true,
    target: {
      path: entry.path,
      name: entry.name,
      size: entry.size,
      line: reference.line,
      column: reference.column,
    },
  };
}
