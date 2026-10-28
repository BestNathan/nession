import type { TerminalLinkMatcher } from '@/platform/terminal-runtime/emulator';

/**
 * Match `src/foo.rs`, `./crates/bar.rs:42`, or quoted paths with an optional line.
 * Workspace-relative only — no leading `/` or `~`.
 */
const WORKSPACE_FILE_PATTERN =
  /(?:^|[\s('"[,])(\.{0,2}\/)?([A-Za-z0-9][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)(?::(\d{1,7}))?(?=$|[\s'"[\]},:;])/g;

export function normalizeWorkspaceFilePath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith('./')) {
    path = path.slice(2);
  }
  while (path.startsWith('/')) {
    path = path.slice(1);
  }
  return path;
}

export interface WorkspaceFileLinkMatch {
  /** The precise text the link should underline, e.g. `src/foo.rs:42`. */
  text: string;
  path: string;
  line?: number;
  /** UTF-16 offsets into the logical line handed to the matcher. */
  startIndex: number;
  endIndex: number;
}

/** Every workspace-file link in one logical line, with text offsets. */
export function findWorkspaceFileLinks(text: string): WorkspaceFileLinkMatch[] {
  const links: WorkspaceFileLinkMatch[] = [];
  WORKSPACE_FILE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORKSPACE_FILE_PATTERN.exec(text)) !== null) {
    const body = match[2];
    if (!body) { continue; }
    const rawPath = `${match[1] ?? ''}${body}`;
    // Workspace-relative only: a `../` prefix is not a workspace path, and the
    // navigation action must never resolve one.
    if (rawPath.includes('..')) { continue; }
    const path = normalizeWorkspaceFilePath(rawPath);
    const line = match[3] ? Number.parseInt(match[3], 10) : undefined;
    if (line !== undefined && (!Number.isFinite(line) || line < 1)) {
      continue;
    }
    const segment = match[0].trim();
    const startIndex = text.indexOf(segment, match.index);
    if (startIndex < 0) {
      continue;
    }
    links.push({
      text: segment,
      path,
      line,
      startIndex,
      endIndex: startIndex + segment.length,
    });
  }
  return links;
}

export function parseWorkspaceFileLink(text: string): { path: string; line?: number } | null {
  const match = findWorkspaceFileLinks(text)[0];
  return match ? { path: match.path, line: match.line } : null;
}

/**
 * Product link recognition, expressed as an emulator matcher (#2581 SC-05).
 *
 * Recognition and the navigation action are the Product's; the engine owns
 * buffer-line reading, wrap joining and the UTF-16-offset → cell mapping, so
 * wide and combining characters and wrapped paths underline the right cells
 * without this module knowing a terminal exists.
 */
export function workspaceFileLinkMatcher(
  onOpen: (path: string, line?: number) => void,
): TerminalLinkMatcher {
  return (line) => findWorkspaceFileLinks(line.text).map((link) => ({
    startIndex: link.startIndex,
    endIndex: link.endIndex,
    activate: () => onOpen(link.path, link.line),
  }));
}
