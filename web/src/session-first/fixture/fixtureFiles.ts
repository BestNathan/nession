import type { FileEntry } from '@/services/fileOps';

/**
 * Static modified timestamp for the fixture tree — keeps the modified column
 * comparable across runs (screenshot baseline).
 */
export const FIXTURE_MODIFIED_TS = 1_756_000_000;

/**
 * Deterministic file contents for the viewer — keyed by path. File sizes are
 * derived from these at module load, so the size column and readFile's
 * total_size always agree.
 */
export const FIXTURE_FILE_CONTENTS: Record<string, string> = {
  'docs/design/visual-language.md': '# Visual Language\n\nTerminal dominates. Chrome recedes.\n',
  'docs/design/composition.md': '# Layout / Composition\n\nChrome yields first, the work surface yields last.\n',
  'web/src/App.tsx': "export function App() {\n  return <div>session-first</div>;\n}\n",
  'web/src/index.css': '/* fixture css */\n',
  'web/src/session-first/workspace/WorkspaceShell.tsx': 'export function WorkspaceShell() {\n  return null;\n}\n',
  'web/src/session-first/workspace/tools/files.tsx': 'export const filesTool = { id: "files" };\n',
};

/**
 * Deterministic project tree for the workspace fixture — mirrors a realistic
 * repo layout (docs/design + web/src flavor).
 * Note: rendered relative-time labels (formatRelativeTime) drift with the
 * wall clock; the fixture data itself is static.
 */
const FIXTURE_FILE_BASE: Array<Omit<FileEntry, 'size'>> = [
  { path: 'docs/design', name: 'design', full_path: '/docs/design', is_dir: true, modified: FIXTURE_MODIFIED_TS },
  { path: 'docs/design/visual-language.md', name: 'visual-language.md', full_path: '/docs/design/visual-language.md', is_dir: false, modified: FIXTURE_MODIFIED_TS },
  { path: 'docs/design/composition.md', name: 'composition.md', full_path: '/docs/design/composition.md', is_dir: false, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src', name: 'src', full_path: '/web/src', is_dir: true, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/App.tsx', name: 'App.tsx', full_path: '/web/src/App.tsx', is_dir: false, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/index.css', name: 'index.css', full_path: '/web/src/index.css', is_dir: false, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/session-first', name: 'session-first', full_path: '/web/src/session-first', is_dir: true, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/session-first/workspace', name: 'workspace', full_path: '/web/src/session-first/workspace', is_dir: true, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/session-first/workspace/WorkspaceShell.tsx', name: 'WorkspaceShell.tsx', full_path: '/web/src/session-first/workspace/WorkspaceShell.tsx', is_dir: false, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/session-first/workspace/tools', name: 'tools', full_path: '/web/src/session-first/workspace/tools', is_dir: true, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/session-first/workspace/tools/files.tsx', name: 'files.tsx', full_path: '/web/src/session-first/workspace/tools/files.tsx', is_dir: false, modified: FIXTURE_MODIFIED_TS },
];

/**
 * Sizes derive from FIXTURE_FILE_CONTENTS (content length) so the size column
 * and readFile's total_size agree; dirs and content-less entries are 0.
 */
export const FIXTURE_FILES: FileEntry[] = FIXTURE_FILE_BASE.map((entry) => ({
  ...entry,
  size: FIXTURE_FILE_CONTENTS[entry.path]?.length ?? 0,
}));
