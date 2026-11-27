# Web pull/refresh surface inventory (#4602 SC-01)

The contract and its owners are in [web.md](web.md#pullrefresh-lifecycle-4602).
This file is the verifiable per-surface policy inventory: every mounted mutable
remote list, its owner, read context, triggers, cadence, manual entry, error
semantics and proof. A surface is **migrated** only when its reads run through
`platform/refresh`; **owner-retained** means an existing correct owner keeps its
data state and is wired to the lifecycle/trigger without a rewrite; **excluded**
means immutable or non-list by contract.

Status is measured against this branch, not against intent.

## Shell / product lists

| Surface | Owner hook | Context | Triggers | Cadence | Manual entry | Error semantics | Proof |
|---|---|---|---|---|---|---|---|
| Session list (Web sidebar + App Sessions) | `product/session/hooks/useSessionData.ts` | transport generation, agent scope | mount, activate, foreground, reconnect, interval, mutation, push (`acceptExternal`) | 12s; force only on explicit refresh | Web: Sessions disclosure `RefreshButton`; App: header `RefreshButton` + host pull | keeps last list, `stale`, `stale_agents` partial warning on change/manual | `useSessionData.test.ts`, `AppSessionsSurface.test.tsx`, e2e `session-lifecycle` |
| Agent registry (Web sidebar + App disclosure) | `product/agent/hooks/useAgentData.ts` | transport generation | mount, activate, foreground, reconnect, interval, push | 12s | Web: sidebar Agents refresh; App: disclosure `RefreshButton` | keeps registry, `stale`; full-field equality never swallows metadata/addresses/protocols/heartbeat | `useAgentData` tests, `AgentsPlugin` manifest-order fence |
| Session metadata | `product/session/state/metadata.ts` | session incarnation | first use, transport reinstall, incarnation change | demand-only (document read) | "Discard draft and load latest" | editor epoch fence | `SessionDetailsMetadata.test.tsx` |
| Agent processes | `product/agent/hooks/useAgentProcesses.ts` | agent:session, connection revision | mount, reconnect, manual nonce | demand-only | `RefreshButton` (both experiences) | offline-agent stale path | `AgentProcesses.test.tsx` |
| Project list | `product/project/hooks/useProjects.ts` | transport generation (read context) | mount, activate, foreground, reconnect, interval, connection change, post-mutation, manual | 30s | section-head `RefreshButton` (both experiences) + error Retry | keeps list, `stale`; one-in-flight controller fence replaces the hand-written sequence/generation fence | `useProjects` tests (restated for the controller) |
| Server info strip | `platform/server/components/ServerInfoMenu.tsx` | global | mount + 30s interval (legacy) | 30s (pending migration) | none (info menu) | last-write-wins (pending fence) | — |

## Capabilities

| Surface | Owner hook | Context | Triggers | Cadence | Manual entry | Status |
|---|---|---|---|---|---|---|
| Claude conversations list + open thread | `shared/ai-conversation/runtime/ConversationRuntime.ts` | agent:session, conversation, cursor | mount/context, 3s live-tail while active | live-tail (owner-retained) | error/empty guards | owner-retained: streaming thread, not a periodic list |
| Claude transcripts list | `capabilities/claude-code/hooks/useTranscripts.ts` | agent:session | mount, activate, foreground, reconnect, interval, manual | 30s | list toolbar `RefreshButton` (Web master-detail + App route) | **migrated** |
| Claude transcript records | `capabilities/claude-code/hooks/useTranscriptRecords.ts` | agent:session:transcript, lanes | mount, 3s live-tail while live | live-tail (owner-retained) | error reload | excluded from periodic list refresh: immutable append-only rows |
| Claude config list | `capabilities/claude-code/hooks/useClaudeCodeWorkspace.ts` | agent, scope, session | mount/context, retry | 60s (pending) | retry-on-error | owner-retained fence; migration pending |
| Claude memory | `capabilities/claude-code/hooks/useMemory.ts` | context, directory, path | while view active, `stale_memory` re-list | 60s (pending) | retry | owner-retained; migration pending |
| Claude MCP inventory | `capabilities/claude-code/hooks/useMcp.ts` | context, name+scope | while view active, post-mutation reload | 60s (pending) | "Reload MCP configuration" (both) | owner-retained; migration pending |
| Files Explorer (Web) | `capabilities/files/hooks/useExplorerFileBrowser.ts` + `platform/explorer/ExplorerStore.ts` | directory node | lazy expand, post-mutation, manual | demand-only (owner-retained) | toolbar Refresh | owner-retained: Explorer owns cache/generation |
| Files directory (App) | `capabilities/files/hooks/useAppDirectoryList.ts` | path, reload token, reload signal | mount, activate, foreground, reconnect, interval, path/reload change, manual retry | 30s | folder-sheet Refresh + error Retry | **migrated** (extracted from `FileList`'s inline effect onto the controller) |
| Env profiles | `capabilities/env/hooks/useEnvironmentProfiles.ts` | transport generation | mount, activate, foreground, reconnect, interval, manual | 60s | navigator toolbar `RefreshButton` (Web + App) | **migrated** |
| Env session binding | `capabilities/env/hooks/useSessionEnvBinding.ts` | session, desired revision | mount/session, revision conflict | demand-only (CAS) | retry / Reapply | owner-retained |
| Quick commands | `capabilities/commands/hooks/useQuickCommands.ts` | global | mount, activate, foreground, reconnect, interval, push (`invalidate`), reconnect edge, manual | 30s | capsule-header refresh (every state) + error Retry | **migrated** (notification-only push routes through `invalidate`; link-state listener kept for `connected`) |
| Git status/branches/worktrees/history | `capabilities/git/hooks/useGitRequest.ts` | agent+session, section | mount-on-open, invalidation push, reconnect, manual, mutation | **demand-only (#4455)** | header Refresh (status); branches/worktrees/history each a visible toolbar `RefreshButton` (history's was sr-only) | owner-retained: no interval/watcher/focus-only added |
| GitHub repository/issues/PRs/workflows | `capabilities/git/hooks/useGithubRequest.ts`, `useGithubPagedList.ts` | agent+session+remote, filter key | mount/key change, manual | demand-only; externally rate-limited | Refresh per view | owner-retained |
| Image Library page | `capabilities/images/hooks/useImageLibraryPage.ts` | offset/limit/query/repository | mount, context change, foreground, reconnect, interval, manual | 60s | Refresh icon | **migrated** |
| Image Builds page | `capabilities/images/hooks/useImageBuilds.ts` | offset/limit/statuses/sources/query | mount, context change, push (membership re-read), reconnect, interval, manual | 12s | Refresh text button | **migrated** |
| Server image inventory | `capabilities/images/hooks/useImagesPage.ts` | offset/limit/query | mount, activate, foreground, reconnect, interval, context change, manual | 60s | via Distribution Refresh | **migrated** (failure keeps the last known page marked stale) |
| Sandbox context | `capabilities/sandbox/hooks/useSandboxContext.ts` | session, epoch | mount/session/epoch, post-transition | demand-only | Refresh icon | owner-retained |
| Agent Workspaces | `capabilities/sandbox/hooks/useAgentWorkspaces.ts` | session | mount, activate, foreground, reconnect, interval, mutation | 30s | Refresh icon | **migrated** |
| Image-cache observations | `capabilities/sandbox/hooks/useImageCacheObservations.ts` | session + digests | 2s self-reschedule while active | observation loop (owner-retained) | Distribution Refresh | excluded: transient preparation observation, not a durable list |

## Excluded by contract

Immutable history and diffs (`git.log`, `git.commit`, `git.diff`), transcript
record rows and raw record text, conversation message pages (append-only
live-tail), editor drafts, streaming terminal/AI output, MCP call history,
local command history, single-document reads, and the browser-side Agent address
probe. These are not periodic mutable lists; their existing owners keep their
semantics.

## Known limits

- The ordinary Session read is not a force read; server-side registry freshness
  between force refreshes is a documented server limitation, not a frontend claim.
- Hidden cached routes issue no periodic requests; they stay dirty until shown.
- GitHub reads are externally rate-limited and remain demand-only.
- Initial cadence/budget values are policy proposals subject to measured adjustment.
