import type { IDisposable, ILink, Terminal } from '@xterm/xterm';

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

export function parseWorkspaceFileLink(text: string): { path: string; line?: number } | null {
  WORKSPACE_FILE_PATTERN.lastIndex = 0;
  const match = WORKSPACE_FILE_PATTERN.exec(text);
  if (!match?.[2] || match[2].includes('..')) {
    return null;
  }
  const path = normalizeWorkspaceFilePath(`${match[1] ?? ''}${match[2]}`);
  const line = match[3] ? Number.parseInt(match[3], 10) : undefined;
  if (line !== undefined && (!Number.isFinite(line) || line < 1)) {
    return null;
  }
  return { path, line };
}

export function registerWorkspaceFileLinkProvider(
  terminal: Terminal,
  onOpen: (path: string, line?: number) => void,
): IDisposable {
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links: ILink[] = [];
      WORKSPACE_FILE_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = WORKSPACE_FILE_PATTERN.exec(text)) !== null) {
        const body = match[2];
        if (!body || body.includes('..')) {
          continue;
        }
        const path = normalizeWorkspaceFilePath(`${match[1] ?? ''}${body}`);
        const lineNumber = match[3] ? Number.parseInt(match[3], 10) : undefined;
        if (lineNumber !== undefined && (!Number.isFinite(lineNumber) || lineNumber < 1)) {
          continue;
        }
        const segment = match[0].trim();
        const startX = text.indexOf(segment, match.index);
        if (startX < 0) {
          continue;
        }
        const endX = startX + segment.length;
        links.push({
          text: segment,
          range: {
            start: { x: startX + 1, y: bufferLineNumber },
            end: { x: endX + 1, y: bufferLineNumber },
          },
          activate: () => {
            onOpen(path, lineNumber);
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  });
}
