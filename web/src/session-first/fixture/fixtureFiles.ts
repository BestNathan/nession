import type { FileEntry } from '@/services/fileOps';

/**
 * Static modified timestamp for the fixture tree — keeps the modified column
 * comparable across runs (screenshot baseline).
 */
export const FIXTURE_MODIFIED_TS = 1_756_000_000;

/**
 * Deterministic project tree for the workspace fixture — mirrors a realistic
 * repo layout (docs/design + web/src flavor).
 */
export const FIXTURE_FILES: FileEntry[] = [
  { path: 'docs/design', name: 'design', full_path: '/docs/design', is_dir: true, size: 0, modified: FIXTURE_MODIFIED_TS },
  { path: 'docs/design/visual-language.md', name: 'visual-language.md', full_path: '/docs/design/visual-language.md', is_dir: false, size: 6124, modified: FIXTURE_MODIFIED_TS },
  { path: 'docs/design/composition.md', name: 'composition.md', full_path: '/docs/design/composition.md', is_dir: false, size: 3988, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src', name: 'src', full_path: '/web/src', is_dir: true, size: 0, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/App.tsx', name: 'App.tsx', full_path: '/web/src/App.tsx', is_dir: false, size: 2210, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/index.css', name: 'index.css', full_path: '/web/src/index.css', is_dir: false, size: 4330, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/session-first', name: 'session-first', full_path: '/web/src/session-first', is_dir: true, size: 0, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/session-first/workspace', name: 'workspace', full_path: '/web/src/session-first/workspace', is_dir: true, size: 0, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/session-first/workspace/WorkspaceShell.tsx', name: 'WorkspaceShell.tsx', full_path: '/web/src/session-first/workspace/WorkspaceShell.tsx', is_dir: false, size: 3145, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/session-first/workspace/tools', name: 'tools', full_path: '/web/src/session-first/workspace/tools', is_dir: true, size: 0, modified: FIXTURE_MODIFIED_TS },
  { path: 'web/src/session-first/workspace/tools/files.tsx', name: 'files.tsx', full_path: '/web/src/session-first/workspace/tools/files.tsx', is_dir: false, size: 812, modified: FIXTURE_MODIFIED_TS },
];

/** Deterministic file contents for the viewer — keyed by path. */
export const FIXTURE_FILE_CONTENTS: Record<string, string> = {
  'docs/design/visual-language.md': '# Visual Language\n\nTerminal dominates. Chrome recedes.\n',
  'docs/design/composition.md': '# Layout / Composition\n\nChrome yields first, the work surface yields last.\n',
  'web/src/App.tsx': "export function App() {\n  return <div>session-first</div>;\n}\n",
  'web/src/index.css': '/* fixture css */\n',
  'web/src/session-first/workspace/WorkspaceShell.tsx': 'export function WorkspaceShell() {\n  return null;\n}\n',
  'web/src/session-first/workspace/tools/files.tsx': 'export const filesTool = { id: "files" };\n',
};
