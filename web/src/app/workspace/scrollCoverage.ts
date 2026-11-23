import type { CapabilityId } from '@/product/capability';

/**
 * The App Workspace scroll-coverage contract (#4222 SC-03).
 *
 * Every capability that the App Workspace can open declares every reachable
 * route/depth/tab/section variant it can draw, together with the scroll
 * contract that variant must honour:
 *
 * - `document` — the view contributes ordinary block content and the App host
 *   owns the one page scrollport (`AppWorkspaceScrollRegion`);
 * - `bounded` — the view owns an internal scroll surface and *every* listed
 *   owner must reach its endpoint above the Capsule (`WorkspaceBoundedScrollport`
 *   or an equivalent declared adapter).
 *
 * `scrollers` and `fixed` are stable identifiers: a test id where the surface
 * publishes one, otherwise the name of the marker the Case selects. They are
 * not a second layout registry — they name the observable endpoint a browser
 * Case must exercise for that route.
 *
 * This file is the inventory the design Gate and the `scrollCoverage` unit test
 * consume. The unit test proves, at the type level, that the Claude route union
 * and the Environment/Sandbox/Git section unions are fully represented and that
 * every `WORKSPACE_VIEW_BINDINGS` entry has an entry here. The Gate proves the
 * structural rules (see `design/scripts/layout-ownership.mjs`).
 */
export interface WorkspaceScrollRouteCoverage {
  /** Stable route/depth/tab/section name from the capability's own union. */
  route: string;
  /** Which App scroll surface the variant needs. */
  mode: 'document' | 'bounded';
  /**
   * Identifiers of the scroll owners that must reach their last painted and
   * actionable content above the Capsule. `document` routes name the host
   * scrollport.
   */
  scrollers: readonly string[];
  /**
   * Identifiers of intentionally persistent siblings outside the scroll area.
   * They must be declared, measured by the host and clear the Capsule; they are
   * never an implicit footer.
   */
  fixed?: readonly string[];
  /** The browser scenario that exercises this route's endpoint. */
  scenario: string;
}

export interface WorkspaceScrollCoverageEntry {
  capability: CapabilityId;
  routes: readonly WorkspaceScrollRouteCoverage[];
}

const PAGE: readonly string[] = ['app-workspace-scrollport'];

export const APP_WORKSPACE_SCROLL_COVERAGE: readonly WorkspaceScrollCoverageEntry[] = [
  {
    capability: 'files',
    routes: [
      {
        route: 'directory',
        mode: 'bounded',
        scrollers: ['files-app-list'],
        fixed: ['files-app-selection-bottom'],
        scenario: 'fixture-app/files-directory',
      },
      {
        route: 'search',
        mode: 'bounded',
        scrollers: ['files-search-scroll'],
        scenario: 'fixture-app/files-search',
      },
      {
        route: 'viewer',
        mode: 'bounded',
        scrollers: ['codemirror-editor', 'jsonl-preview-scroll'],
        fixed: ['file-viewer-dirty-preview'],
        scenario: 'fixture-app/files-viewer',
      },
    ],
  },
  {
    capability: 'session',
    routes: [
      { route: 'details', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/session' },
    ],
  },
  {
    capability: 'agent',
    routes: [
      { route: 'detail', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/agent' },
    ],
  },
  {
    capability: 'env',
    routes: [
      {
        route: 'root',
        mode: 'bounded',
        scrollers: ['env-navigator-list'],
        scenario: 'fixture-app/env-root',
      },
      {
        route: 'session',
        mode: 'bounded',
        scrollers: ['env-session-environment'],
        scenario: 'fixture-app/env-session',
      },
      {
        route: 'profile',
        mode: 'bounded',
        scrollers: ['env-variable-list-scroll', 'env-var-warnings'],
        scenario: 'fixture-app/env-profile',
      },
      {
        route: 'profile-editor',
        mode: 'bounded',
        scrollers: ['codemirror-editor', 'env-editor-feedback'],
        fixed: ['env-editor-error-note', 'env-editor-name-note'],
        scenario: 'fixture-app/env-editor',
      },
      {
        route: 'draft',
        mode: 'bounded',
        scrollers: ['env-binding-draft'],
        scenario: 'fixture-app/env-draft',
      },
    ],
  },
  {
    capability: 'sandbox',
    routes: [
      { route: 'overview', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/sandbox-overview' },
      { route: 'images', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/sandbox-images' },
      { route: 'workspaces', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/sandbox-workspaces' },
      { route: 'policies', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/sandbox-policies' },
      { route: 'policy-filesystem', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/sandbox-policy-filesystem' },
      { route: 'policy-network', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/sandbox-policy-network' },
      { route: 'policy-process', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/sandbox-policy-process' },
      { route: 'policy-resource', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/sandbox-policy-resource' },
      { route: 'policy-syscall', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/sandbox-policy-syscall' },
      { route: 'enter', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/sandbox-enter' },
    ],
  },
  {
    capability: 'claude-code',
    routes: [
      {
        route: 'conversations',
        mode: 'bounded',
        scrollers: ['claude-app-conversations-scroll'],
        scenario: 'fixture-app/claude-conversations',
      },
      {
        route: 'conversation',
        mode: 'bounded',
        scrollers: ['conversation-transcript-scroll'],
        fixed: ['claude-app-read-only-note'],
        scenario: 'fixture-app/claude-conversation',
      },
      {
        route: 'transcripts',
        mode: 'bounded',
        scrollers: ['transcript-list-scroll'],
        scenario: 'fixture-app/claude-transcripts',
      },
      {
        route: 'transcript',
        mode: 'bounded',
        scrollers: ['transcript-timeline-scroll'],
        fixed: ['transcript-partial'],
        scenario: 'fixture-app/claude-transcript',
      },
      {
        route: 'record',
        mode: 'bounded',
        scrollers: ['claude-app-record-scroll'],
        scenario: 'fixture-app/claude-record',
      },
      {
        route: 'raw',
        mode: 'bounded',
        scrollers: ['transcript-raw-scroll'],
        scenario: 'fixture-app/claude-raw',
      },
      {
        route: 'memory',
        mode: 'bounded',
        scrollers: ['claude-code-memory-list'],
        scenario: 'fixture-app/claude-memory',
      },
      {
        route: 'memory-file',
        mode: 'bounded',
        scrollers: ['claude-code-memory-content'],
        scenario: 'fixture-app/claude-memory-file',
      },
      {
        route: 'mcp',
        mode: 'bounded',
        scrollers: ['claude-code-mcp-list'],
        scenario: 'fixture-app/claude-mcp',
      },
      {
        route: 'mcp-server',
        mode: 'bounded',
        scrollers: ['claude-code-mcp-detail'],
        scenario: 'fixture-app/claude-mcp-server',
      },
      {
        route: 'mcp-tool',
        mode: 'bounded',
        scrollers: ['claude-app-mcp-tool-scroll'],
        scenario: 'fixture-app/claude-mcp-tool',
      },
      {
        route: 'configuration',
        mode: 'bounded',
        scrollers: ['claude-code-scope'],
        fixed: ['claude-app-configuration-note'],
        scenario: 'fixture-app/claude-configuration',
      },
      {
        route: 'config-file',
        mode: 'bounded',
        scrollers: ['claude-code-content'],
        scenario: 'fixture-app/claude-config-file',
      },
    ],
  },
  {
    capability: 'git',
    routes: [
      {
        route: 'changes',
        mode: 'bounded',
        scrollers: ['git-diff-body', 'git-file-preview-body'],
        scenario: 'fixture-git/changes',
      },
      {
        route: 'history',
        mode: 'bounded',
        scrollers: ['git-commit-list', 'git-commit-detail', 'git-diff-body'],
        scenario: 'fixture-git/history',
      },
      {
        route: 'history-branches',
        mode: 'bounded',
        scrollers: ['git-branch-list'],
        scenario: 'fixture-git/branches',
      },
      {
        route: 'history-worktrees',
        mode: 'bounded',
        scrollers: ['git-worktree-list'],
        scenario: 'fixture-git/worktrees',
      },
      {
        route: 'github-issues',
        mode: 'bounded',
        scrollers: ['github-issue-list-scroll'],
        scenario: 'fixture-git/github-issues',
      },
      {
        route: 'github-pull-requests',
        mode: 'bounded',
        scrollers: ['github-pr-list-scroll'],
        scenario: 'fixture-git/github-pull-requests',
      },
      {
        route: 'github-actions',
        mode: 'bounded',
        scrollers: ['github-actions-scroll'],
        scenario: 'fixture-git/github-actions',
      },
    ],
  },
  {
    capability: 'project',
    routes: [
      { route: 'detail', mode: 'document', scrollers: PAGE, scenario: 'fixture-app/project' },
    ],
  },
];

/**
 * Rules the canonical Gate applies to a coverage inventory (#4222 SC-03/SC-06).
 *
 * Kept as a pure function so the design source tests can prove both the reject
 * and the accept side without mutating the repository.
 */
export function checkScrollCoverage(
  entries: readonly WorkspaceScrollCoverageEntry[],
): string[] {
  const problems: string[] = [];
  const seenCapabilities = new Set<string>();
  for (const entry of entries) {
    if (seenCapabilities.has(entry.capability)) {
      problems.push(`duplicate capability coverage: ${entry.capability}`);
    }
    seenCapabilities.add(entry.capability);
    if (entry.routes.length === 0) {
      problems.push(`capability has no route coverage: ${entry.capability}`);
    }
    const seenRoutes = new Set<string>();
    for (const route of entry.routes) {
      const key = `${entry.capability}/${route.route}`;
      if (seenRoutes.has(route.route)) {
        problems.push(`duplicate route coverage: ${key}`);
      }
      seenRoutes.add(route.route);
      if (route.mode !== 'document' && route.mode !== 'bounded') {
        problems.push(`unknown scroll mode: ${key}`);
      }
      if (route.scenario.trim() === '') {
        problems.push(`route has no executable scenario: ${key}`);
      }
      if (route.mode === 'bounded' && route.scrollers.length === 0) {
        problems.push(`bounded route has no scroll owner: ${key}`);
      }
      if (route.mode === 'document' && route.scrollers.some((owner) => !PAGE.includes(owner))) {
        problems.push(`document route names a non-page scroll owner: ${key}`);
      }
      for (const fixed of route.fixed ?? []) {
        if (fixed.trim() === '') {
          problems.push(`empty fixed role: ${key}`);
        }
      }
    }
  }
  return problems;
}
