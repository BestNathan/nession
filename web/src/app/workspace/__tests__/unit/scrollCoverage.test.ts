import { describe, expect, it } from 'vitest';

import type { AppRoute } from '@/capabilities/claude-code/components/claude-app/model';
import type { EnvironmentView } from '@/capabilities/env';
import type { GitSection, GithubSection } from '@/capabilities/git';
import type { SandboxSectionId } from '@/capabilities/sandbox';
import type { SandboxPolicyId } from '@/capabilities/sandbox/components/SandboxPolicyTabs';
import { WORKSPACE_VIEW_BINDINGS } from '@/app/workspace/viewBindings';
import {
  APP_WORKSPACE_SCROLL_COVERAGE,
  checkScrollCoverage,
  type WorkspaceScrollRouteCoverage,
} from '@/app/workspace/scrollCoverage';

/**
 * The scroll-coverage inventory is exhaustive against the unions that actually
 * create reachable App Workspace routes (#4222 SC-03).
 *
 * The Gate owns the structural rules; this test owns the type-level proof that
 * no union member is missing — adding a route without a scroll contract is a
 * compile error here, not a silent uncovered depth.
 */
const coverageFor = (capability: string) => {
  const entry = APP_WORKSPACE_SCROLL_COVERAGE.find((item) => item.capability === capability);
  if (!entry) {
    throw new Error(`missing coverage for ${capability}`);
  }
  return entry;
};

const routeIndex = (capability: string) =>
  new Map<string, WorkspaceScrollRouteCoverage>(
    coverageFor(capability).routes.map((route) => [route.route, route]),
  );

describe('App Workspace scroll coverage', () => {
  it('covers every view binding exactly once', () => {
    const covered = new Set(APP_WORKSPACE_SCROLL_COVERAGE.map((entry) => entry.capability));
    for (const view of WORKSPACE_VIEW_BINDINGS) {
      expect(covered.has(view.id), `binding ${view.id} has a scroll contract`).toBe(true);
    }
    expect(covered.size).toBe(WORKSPACE_VIEW_BINDINGS.length);
  });

  it('declares the same surface mode the binding declares', () => {
    for (const view of WORKSPACE_VIEW_BINDINGS) {
      const expected = view.appScroll ?? 'document';
      for (const route of coverageFor(view.id).routes) {
        expect(route.mode, `${view.id}/${route.route}`).toBe(expected);
      }
    }
  });

  it('contains no structural problems', () => {
    expect(checkScrollCoverage(APP_WORKSPACE_SCROLL_COVERAGE)).toEqual([]);
  });

  it('covers every reachable Claude App route kind', () => {
    const routes = routeIndex('claude-code');
    // Written out so a new AppRoute member fails this object's type, not just
    // an assertion at runtime.
    const exhaustive: Record<AppRoute['kind'], WorkspaceScrollRouteCoverage | undefined> = {
      conversations: routes.get('conversations'),
      conversation: routes.get('conversation'),
      transcripts: routes.get('transcripts'),
      transcript: routes.get('transcript'),
      record: routes.get('record'),
      raw: routes.get('raw'),
      memory: routes.get('memory'),
      'memory-file': routes.get('memory-file'),
      mcp: routes.get('mcp'),
      'mcp-server': routes.get('mcp-server'),
      'mcp-tool': routes.get('mcp-tool'),
      configuration: routes.get('configuration'),
      'config-file': routes.get('config-file'),
    };
    for (const [kind, route] of Object.entries(exhaustive)) {
      expect(route, `Claude route ${kind}`).toBeDefined();
    }
  });

  it('covers every Environment view depth', () => {
    const routes = routeIndex('env');
    const exhaustive: Record<EnvironmentView, WorkspaceScrollRouteCoverage | undefined> = {
      root: routes.get('root'),
      session: routes.get('session'),
      profile: routes.get('profile'),
      draft: routes.get('draft'),
    };
    for (const [view, route] of Object.entries(exhaustive)) {
      expect(route, `Environment view ${view}`).toBeDefined();
    }
    expect(routes.get('profile-editor'), 'Environment profile editor depth').toBeDefined();
  });

  it('covers every Sandbox section and policy tab', () => {
    const routes = routeIndex('sandbox');
    const sections: Record<SandboxSectionId, WorkspaceScrollRouteCoverage | undefined> = {
      overview: routes.get('overview'),
      images: routes.get('images'),
      workspaces: routes.get('workspaces'),
      policies: routes.get('policies'),
    };
    const policies: Record<SandboxPolicyId, WorkspaceScrollRouteCoverage | undefined> = {
      filesystem: routes.get('policy-filesystem'),
      network: routes.get('policy-network'),
      process: routes.get('policy-process'),
      resource: routes.get('policy-resource'),
      syscall: routes.get('policy-syscall'),
    };
    for (const [section, route] of Object.entries(sections)) {
      expect(route, `Sandbox section ${section}`).toBeDefined();
    }
    for (const [policy, route] of Object.entries(policies)) {
      expect(route, `Sandbox policy ${policy}`).toBeDefined();
    }
    expect(routes.get('enter'), 'Sandbox Enter preflight').toBeDefined();
  });

  it('covers every Git repository and GitHub section', () => {
    const routes = routeIndex('git');
    const repository: Record<GitSection, WorkspaceScrollRouteCoverage | undefined> = {
      changes: routes.get('changes'),
      history: routes.get('history'),
      branches: routes.get('history-branches'),
      worktrees: routes.get('history-worktrees'),
    };
    const github: Record<GithubSection, WorkspaceScrollRouteCoverage | undefined> = {
      issues: routes.get('github-issues'),
      'pull-requests': routes.get('github-pull-requests'),
      actions: routes.get('github-actions'),
    };
    for (const [section, route] of Object.entries(repository)) {
      expect(route, `Git section ${section}`).toBeDefined();
    }
    for (const [section, route] of Object.entries(github)) {
      expect(route, `GitHub section ${section}`).toBeDefined();
    }
  });
});
