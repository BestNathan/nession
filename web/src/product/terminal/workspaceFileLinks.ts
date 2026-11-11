import type { TerminalLinkMatcher } from '@/platform/terminal-runtime/emulator';

/**
 * A path-shaped token in terminal output: `src/foo.rs`, `./crates/bar.rs:42`,
 * `/var/log/app.log:9:3`, or a quoted/stack-trace form of the same.
 *
 * The token must contain a dot-separated extension, which keeps ordinary prose
 * and URL schemes (`https://…`, `ws://…`) out: a scheme's `//` cannot begin a
 * token because the leading boundary never consumes a second slash. A path
 * may be absolute; the resolver keeps that meaning rather than stripping it.
 */
const PATH_BODY = String.raw`[A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z][A-Za-z0-9_+-]*`;
const PATH_PREFIX = String.raw`(?:\.{0,2}\/|\/)?`;
const FILE_REFERENCE_PATTERN = new RegExp(
  String.raw`(?:^|[\s('"\`\[<])(` +
    PATH_PREFIX + PATH_BODY + String.raw`(?::\d{1,7}(?::\d{1,7})?)?)` +
    String.raw`(?=$|[\s'"\`\]>},;:])`,
  'g',
);
const PATH_AND_LOCATION_PATTERN = new RegExp(
  String.raw`^(` + PATH_PREFIX + PATH_BODY + String.raw`)(?::(\d{1,7})(?::(\d{1,7}))?)?$`,
);

export interface TerminalFileReference {
  /** The path exactly as printed, before normalization (`./`, `../`, `/`). */
  rawPath: string;
  /** `.`/`..` segments normalized; a leading `/` stays absolute. */
  path: string;
  /** 1-based line, when the reference carried one. */
  line?: number;
  /** 1-based column, when the reference carried one. */
  column?: number;
}

/**
 * Normalize `.` and `..` segments without changing the path's meaning.
 *
 * A leading `/` is preserved: an absolute reference is absolute on the file
 * source it was activated against, never reinterpreted under the workspace
 * root. Unresolvable leading `..` segments in a relative path are kept so the
 * later join against the Session CWD can resolve them.
 */
export function normalizeTerminalFilePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return '';
  }
  const absolute = trimmed.startsWith('/');
  const segments = trimmed.split('/');
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== '..') {
        normalized.pop();
      } else if (!absolute) {
        normalized.push('..');
      }
      continue;
    }
    normalized.push(segment);
  }
  if (absolute) {
    return '/' + normalized.join('/');
  }
  return normalized.join('/');
}

/**
 * Strip only the leading `./` spelling. Kept for callers that want the
 * workspace-relative form; absolute paths are not reinterpreted here.
 */
export function normalizeWorkspaceFilePath(raw: string): string {
  let path = raw.trim();
  while (path.startsWith('./')) {
    path = path.slice(2);
  }
  return normalizeTerminalFilePath(path);
}

export interface WorkspaceFileLinkMatch extends TerminalFileReference {
  /** The precise text the link should underline, e.g. `src/foo.rs:42:9`. */
  text: string;
  /** UTF-16 offsets into the logical line handed to the matcher. */
  startIndex: number;
  endIndex: number;
}

/** Every terminal file reference in one logical line, with text offsets. */
export function findWorkspaceFileLinks(text: string): WorkspaceFileLinkMatch[] {
  const links: WorkspaceFileLinkMatch[] = [];
  FILE_REFERENCE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_REFERENCE_PATTERN.exec(text)) !== null) {
    const segment = match[1];
    if (!segment) {
      continue;
    }
    const parsed = PATH_AND_LOCATION_PATTERN.exec(segment);
    if (!parsed) {
      continue;
    }
    const rawPath = parsed[1] ?? '';
    const path = normalizeTerminalFilePath(rawPath);
    if (path === '' || path === '/' || path.endsWith('/')) {
      continue;
    }
    const line = parsed[2] ? Number.parseInt(parsed[2], 10) : undefined;
    const column = parsed[3] ? Number.parseInt(parsed[3], 10) : undefined;
    if (line !== undefined && (!Number.isFinite(line) || line < 1)) {
      continue;
    }
    if (column !== undefined && (!Number.isFinite(column) || column < 1)) {
      continue;
    }
    const startIndex = match.index + match[0].indexOf(segment);
    if (startIndex < 0) {
      continue;
    }
    links.push({
      text: segment,
      rawPath,
      path,
      line,
      column,
      startIndex,
      endIndex: startIndex + segment.length,
    });
  }
  return links;
}

export function parseWorkspaceFileLink(text: string): TerminalFileReference | null {
  const match = findWorkspaceFileLinks(text)[0];
  return match
    ? { rawPath: match.rawPath, path: match.path, line: match.line, column: match.column }
    : null;
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
  onOpen: (path: string, line?: number, column?: number) => void,
): TerminalLinkMatcher {
  return (line) => findWorkspaceFileLinks(line.text).map((link) => ({
    startIndex: link.startIndex,
    endIndex: link.endIndex,
    activate: () => onOpen(link.path, link.line, link.column),
  }));
}
