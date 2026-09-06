# Claude Code Workspace Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Claude Code configuration out of Agent detail and the terminal header into a first-class Workspace App Dock tool that browses global and project configuration for the selected session.

**Architecture:** Keep the existing `claudeCodeApi` capability and wire contract. Add a `claude-code` entry to the registry-driven Workspace tool bar, with a shared full-pane browser component that owns scope/file selection and read state; use that component for both web and App layouts. Remove the old Agent and terminal-header UI slots without changing Rust or WebSocket behavior.

**Tech Stack:** React 18, TypeScript, Jotai-derived session context, Vitest + Testing Library, shadcn Tabs/Button/Separator primitives, Tailwind CSS, existing `claudeCodeApi` capability.

---

## File map

- Create `web/src/extensions/claude-code/components/ClaudeCodeWorkspace.tsx` — shared global/project scope browser and full-pane file reader.
- Modify `web/src/session-first/workspace/toolTypes.ts` — add the `claude-code` tool id.
- Modify `web/src/session-first/workspace/tools/index.ts` — register the new tool after Agent.
- Create `web/src/session-first/workspace/tools/claudeCode.tsx` — Workspace tool metadata and web/App layout adapters.
- Modify `web/src/session-first/patterns/AgentDetail.tsx` — remove the extension slot rendering.
- Modify `web/src/session-first/__tests__/integration/AgentDetail.test.tsx` — assert Agent detail no longer invokes or renders Claude Code.
- Modify `web/src/session-first/workspace/__tests__/integration/WorkspaceShell.test.tsx` — cover the fourth tool and activation.
- Create `web/src/extensions/claude-code/components/__tests__/integration/ClaudeCodeWorkspace.test.tsx` — scope, request, state reset, error, and pagination coverage.
- Modify `web/src/components/AgentDetailPanel.tsx` — remove the legacy Claude Code tab and its imports/state.
- Modify `web/src/components/FileTabs.tsx` and `web/src/extensions/claude-code/index.ts` — ensure the old terminal-header slot is no longer populated.
- Delete `web/src/extensions/claude-code/components/ClaudeCodeSection.tsx`, `ConfigViewer.tsx`, and `TerminalClaudeCodeTab.tsx`, plus `ClaudeCodeSection.test.tsx` and `TerminalClaudeCodeTab.test.tsx`, after their behavior is covered by the new Workspace tests.

## Task 1: Extend the Workspace registry with Claude Code

**Files:**
- Modify: `web/src/session-first/workspace/toolTypes.ts`
- Modify: `web/src/session-first/workspace/tools/index.ts`
- Create: `web/src/session-first/workspace/tools/claudeCode.tsx`
- Create: `web/src/extensions/claude-code/components/ClaudeCodeWorkspace.tsx`
- Test: `web/src/session-first/workspace/__tests__/integration/WorkspaceShell.test.tsx`

- [ ] **Step 1: Write the failing registry test.**

Extend the existing registry test so it requires the exact ordered ids:

```ts
expect(WORKSPACE_TOOLS.map((tool) => tool.id)).toEqual([
  'files', 'session', 'agent', 'claude-code',
]);
expect(WORKSPACE_TOOLS.find((tool) => tool.id === 'claude-code')?.label)
  .toBe('Claude Code');
```

Add an interaction test that renders `WorkspaceShell` with an active
`claude-code` tool and clicks the `Claude Code` tab, expecting
`onToolChange('claude-code')`. Use a context with a selected session and agent
so the tool is not hidden by missing context.

- [ ] **Step 2: Run the focused test and verify it fails.**

Run:

```bash
cd web && npm test -- --run src/session-first/workspace/__tests__/integration/WorkspaceShell.test.tsx
```

Expected: FAIL because the union and registry only contain `files`, `session`,
and `agent`.

- [ ] **Step 3: Implement the registry entry.**

Add the union member:

```ts
export type WorkspaceToolId = 'files' | 'session' | 'agent' | 'claude-code';
```

Create the tool metadata:

```tsx
import { Bot } from 'lucide-react';
import { ClaudeCodeWorkspace } from '@/extensions/claude-code/components/ClaudeCodeWorkspace';
import type { WorkspaceTool } from '../toolTypes';

export const claudeCodeTool: WorkspaceTool = {
  id: 'claude-code',
  label: 'Claude Code',
  icon: Bot,
  order: 40,
  availability: () => true,
  layout: {
    web: ({ ctx }) => <ClaudeCodeWorkspace ctx={ctx} />,
    app: ({ ctx }) => <ClaudeCodeWorkspace ctx={ctx} />,
  },
};
```

Import and append `claudeCodeTool` in `WORKSPACE_TOOLS`. Keeping availability
always true ensures the App Dock remains discoverable even when either scope is
unavailable; the layout renders the appropriate state.

Create the initial component boundary used by the registry so this task remains
independently type-checkable. The initial implementation is intentionally a
neutral shell; Task 2 replaces its body with the tested browser:

```tsx
import type { WorkspaceContext } from '@/session-first/workspace/toolTypes';

export function ClaudeCodeWorkspace({ ctx: _ctx }: { ctx: WorkspaceContext }) {
  return <div data-testid="claude-code-workspace" />;
}
```

- [ ] **Step 4: Run the focused test and verify it passes.**

Run the same command from Step 2. Expected: all WorkspaceShell tests pass and
the registry exposes four tools in the specified order.

- [ ] **Step 5: Commit the registry change.**

```bash
git add web/src/session-first/workspace/toolTypes.ts \
  web/src/session-first/workspace/tools/index.ts \
  web/src/session-first/workspace/tools/claudeCode.tsx \
  web/src/extensions/claude-code/components/ClaudeCodeWorkspace.tsx \
  web/src/session-first/workspace/__tests__/integration/WorkspaceShell.test.tsx
git commit -m "feat: add Claude Code workspace tool"
```

## Task 2: Build the shared Claude Code Workspace browser

**Files:**
- Create: `web/src/extensions/claude-code/components/ClaudeCodeWorkspace.tsx`
- Create: `web/src/extensions/claude-code/components/__tests__/integration/ClaudeCodeWorkspace.test.tsx`

- [ ] **Step 1: Write failing behavior tests.**

Mock `@/features/claude-code` with `claudeCodeApi.claudeCodeList` and
`claudeCodeApi.claudeCodeRead`. Render the component with a context shaped like:

```ts
const ctx: WorkspaceContext = {
  session: makeSession('agent-1:work'),
  agent: makeAgent('agent-1'),
  domain: onlineDomain,
  fileOps: null,
  experience: 'web',
  onToolChange: vi.fn(),
};
```

Cover these cases:

1. On mount, it requests both `{ agent_id: 'agent-1', scope: 'global' }` and
   `{ agent_id: 'agent-1', scope: 'project', session_id: 'agent-1:work' }`.
2. It renders `Global` and `Project` scope controls, category names, and file
   names from successful responses.
3. Clicking a file sends `claudeCodeRead` with the selected scope, agent id,
   session id for project scope, and `offset: 0`, then renders content and a
   `Load more` control when `has_more` is true.
4. Clicking `Load more` requests the same file at `offset: content.length` and
   appends the new chunk.
5. A rejected list request renders `Retry`; clicking it calls the list API
   again. An `available: false` response renders `Claude Code not installed`.
6. Changing the context from one session/agent to another clears the selected
   file and previous content before showing the new scope data.
7. A read error renders inline error text without removing the scope/file list.

- [ ] **Step 2: Run the new focused test and verify it fails.**

Run:

```bash
cd web && npm test -- --run src/extensions/claude-code/components/__tests__/integration/ClaudeCodeWorkspace.test.tsx
```

Expected: FAIL because the scaffold does not yet implement scope loading,
file navigation, reads, pagination, or error states.

- [ ] **Step 3: Implement the shared component.**

Use `WorkspaceContext` as the only context input and `claudeCodeApi` for wire
requests. Define these state shapes inside the component:

```ts
type Scope = 'global' | 'project';
interface ScopeState {
  categories: ConfigCategory[];
  available: boolean | null;
  loading: boolean;
  error: string | null;
}
```

On `ctx.agent?.agent_id` or `ctx.session?.session_id` changes, reset the active
scope, selected file, content, pagination, and per-scope state. If either
context value is missing, render a concise session/agent context message and do
not issue requests. Otherwise request both scopes. For global requests omit
`session_id`; for project requests pass the selected session id. Ignore stale
async results by capturing the request key (`agent_id:session_id`) before
awaiting.

Render the page as a full-height two-column surface:

- Header row with `Claude Code` and scope `Tabs` containing `Global` and
  `Project`.
- Left column with category headings and keyboard-accessible file buttons.
- Right column with selected path, formatted byte size, `Load more`, and a
  monospace `<pre>` preview.
- Empty state prompting the user to select a file.
- Scope-local loading, retry, error, and not-installed states.

Use the existing semantic Tailwind/shadcn tokens. Do not use emoji icons or
raw color values. Keep each interactive file row a native `<button>` with a
visible focus ring and an `aria-pressed`/selected style.

The read handler resets offset/content before requesting a file. The pagination
handler appends content and updates `hasMore`; on failure it leaves existing
content intact and shows the inline error. Format sizes as B, KB, or MB so the
label is never undefined for large files.

- [ ] **Step 4: Run the focused test and verify it passes.**

Run the same command from Step 2. Expected: all ClaudeCodeWorkspace tests pass.

- [ ] **Step 5: Commit the browser.**

```bash
git add web/src/extensions/claude-code/components/ClaudeCodeWorkspace.tsx \
  web/src/extensions/claude-code/components/__tests__/integration/ClaudeCodeWorkspace.test.tsx
git commit -m "feat: browse Claude Code config in workspace"
```

## Task 3: Remove Claude Code from Agent detail and terminal header

**Files:**
- Modify: `web/src/session-first/patterns/AgentDetail.tsx`
- Modify: `web/src/session-first/__tests__/integration/AgentDetail.test.tsx`
- Modify: `web/src/components/AgentDetailPanel.tsx`
- Modify: `web/src/components/FileTabs.tsx`
- Modify: `web/src/extensions/claude-code/index.ts`
- Delete: `web/src/extensions/claude-code/components/ClaudeCodeSection.tsx`
- Delete: `web/src/extensions/claude-code/components/ConfigViewer.tsx`
- Delete: `web/src/extensions/claude-code/components/TerminalClaudeCodeTab.tsx`
- Delete: `web/src/extensions/claude-code/components/__tests__/integration/ClaudeCodeSection.test.tsx`
- Delete: `web/src/extensions/claude-code/components/__tests__/integration/TerminalClaudeCodeTab.test.tsx`

- [ ] **Step 1: Update tests to assert the old entry points are gone.**

Replace the Agent detail extension-slot test with an assertion that an Agent
with Nession metadata renders its normal details but does not call
`renderSlot('agent-detail', ...)` and does not render a Claude Code extension.
Add a FileTabs assertion that the terminal tab bar contains `Terminal` and
normal file tabs but no `CC` extension tab when the extension registry has been
initialized.

- [ ] **Step 2: Run the focused regression tests and verify they fail.**

Run:

```bash
cd web && npm test -- --run \
  src/session-first/__tests__/integration/AgentDetail.test.tsx \
  src/components/__tests__/integration/FileTabs.test.tsx
```

Expected: FAIL because both old UI entry points still render or invoke the
Claude Code extension.

- [ ] **Step 3: Remove the old composition points.**

In `AgentDetail.tsx`, remove the `useMemo`, `renderSlot`, and `Separator`
extension block; keep the normal Agent facts and connection status. In the
legacy `AgentDetailPanel.tsx`, remove `ClaudeCodeSection`, the Claude Code tab
definition, `hasClaudeCode`, and the conditional content; leave only Overview.

In `extensions/claude-code/index.ts`, register no UI slots:

```ts
const extension: UIExtension = { name: 'claude-code', slots: {} };
```

This keeps dynamic extension discovery stable while preventing legacy
`renderSlot` callers from adding UI. `FileTabs.tsx` may continue calling
`renderSlot('terminal-header', ...)`; it will now receive an empty list.

Delete the three obsolete sheet/header components and their direct tests after
the new Workspace test suite covers list/read behavior. The feature capability
files under `web/src/features/claude-code/` remain unchanged.

- [ ] **Step 4: Run the focused regression tests and verify they pass.**

Run the same command from Step 2. Expected: Agent detail has no Claude Code
extension and the terminal tab bar has no `CC` tab.

- [ ] **Step 5: Commit the removal.**

```bash
git add -A web/src/session-first/patterns/AgentDetail.tsx \
  web/src/session-first/__tests__/integration/AgentDetail.test.tsx \
  web/src/components/AgentDetailPanel.tsx \
  web/src/components/FileTabs.tsx \
  web/src/extensions/claude-code
git commit -m "refactor: remove Claude Code from agent surfaces"
```

## Task 4: Verify the complete Workspace interaction

**Files:**
- Modify: `web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx`
- Modify: `web/src/session-first/__tests__/integration/SessionFirstWorkspace.test.tsx`

- [ ] **Step 1: Add App Dock activation coverage.**

Extend the existing Workspace navigation test so it selects a session, opens
Workspace, clicks the `Claude Code` tab, and asserts the Claude Code full-pane
test id. In App experience, click the existing `app-tool-back` control and
assert that the terminal surface returns. Keep the existing Files/Session/Agent
navigation assertions unchanged.

- [ ] **Step 2: Run the focused shell/workspace tests.**

```bash
cd web && npm test -- --run \
  src/session-first/__tests__/integration/SessionFirstShell.test.tsx \
  src/session-first/__tests__/integration/SessionFirstWorkspace.test.tsx \
  src/session-first/workspace/__tests__/integration/WorkspaceShell.test.tsx \
  src/extensions/claude-code/components/__tests__/integration/ClaudeCodeWorkspace.test.tsx
```

Expected: all selected tests pass with the fourth tool available in the App
Dock and no legacy Claude Code entry point.

- [ ] **Step 3: Commit integration coverage.**

```bash
git add web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx \
  web/src/session-first/__tests__/integration/SessionFirstWorkspace.test.tsx
git commit -m "test: cover Claude Code workspace navigation"
```

## Task 5: Run quality gates and browser verification

- [ ] **Step 1: Run TypeScript and lint checks.**

```bash
cd web && npx tsc --noEmit && npm run lint
```

Expected: exit 0, with no TypeScript errors and no ESLint warnings.

- [ ] **Step 2: Run the complete web test suite and production build.**

```bash
cd web && npm test && npm run build
```

Expected: all Vitest tests pass and Vite produces `web/dist/` successfully.

- [ ] **Step 3: Start the isolated local stack.**

From the worktree root, use the documented isolated HOME:

```bash
HOME=/tmp/nession-claude-code-workspace cargo run -p nession-server
HOME=/tmp/nession-claude-code-workspace cargo run -p nession-agent -- agent-config.toml
cd web && npm run dev
```

Use Playwright against `http://localhost:13000`, log in, select a session,
open Workspace, activate Claude Code, and capture a screenshot under
`.playwright-mcp/screenshots/claude-code-workspace.png`. Verify the App Dock
labels, scope controls, loading/unavailable state, and the App back button.

- [ ] **Step 4: Run the final diff/branch checks.**

```bash
git branch --show-current
git status --short
git diff --check origin/staging...HEAD
```

Expected: branch is `feat/claude-code-workspace`, only intended files are
changed, and `git diff --check` is clean.

- [ ] **Step 5: Commit final test-only adjustments if the verification exposed a regression.**

```bash
git add web docs/superpowers
git commit -m "test: verify Claude Code workspace UI"
```
