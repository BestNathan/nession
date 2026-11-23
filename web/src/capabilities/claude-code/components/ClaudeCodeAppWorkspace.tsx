import { useCallback } from 'react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { conversationLabel } from '@/shared/ai-conversation';
import type { WorkspaceAppViewProps } from '@/app/workspace/workspaceContext';
import { useClaudeCodeWorkspace } from '../hooks/useClaudeCodeWorkspace';
import { transcriptLabel } from '../format';
import { parseTranscriptRecord } from '../model/transcriptRecord';
import { ConversationRootScreen } from './claude-app/ConversationRoutes';
import { ClaudeAppRouteLayer } from './claude-app/ClaudeAppRouteLayer';
import {
  routeKey,
  routeTitle,
  type AppRoute,
  type ClaudeAppData,
} from './claude-app/model';
import { BrowseSheet } from './claude-app/primitives';
import { useClaudeAppNavigation } from './claude-app/useClaudeAppNavigation';
import { useClaudeAppSync } from './claude-app/useClaudeAppSync';
import { McpEditorHost, McpRemoveHost } from './McpView';

/**
 * The App presentation of Claude Code's Workspace (#3829).
 *
 * One hierarchy, three decisions:
 *
 * 1. **The conversation is the root.** No permanent five-tab strip competes
 *    with the current work; the shell header names the depth and owns its one
 *    Back.
 * 2. **One Browse entry** opens an App sheet with the five resources, grouped
 *    by work vs setup. Choosing one replaces the pushed stack with that
 *    resource's root, so Back always returns to the conversation.
 * 3. **Resource depth is pushed.** Collections, a resource, and its details
 *    (a record, Raw, a file, a tool) are layers under the same header. Every
 *    covered layer stays mounted and `inert`, so Back restores the list's
 *    scroll and the reader's place instead of rebuilding them.
 *
 * Web keeps `ClaudeCodeWorkspace` and its master/detail behaviour. Both share
 * `useClaudeCodeWorkspace`, so neither owns a second copy of the transport,
 * the generation guards or the provider's state vocabulary.
 */
export function ClaudeCodeAppWorkspace({ ctx, depth }: WorkspaceAppViewProps) {
  const state = useClaudeCodeWorkspace(ctx);

  // The header's primary title names the resource, not the route kind (#3971):
  // a transcript is its label, a record is its parsed kind, an MCP tool is the
  // tool's own name. Data that has not loaded yet falls back to the stable kind
  // name rather than inventing identity.
  const titleOf = useCallback((route: AppRoute): string => {
    switch (route.kind) {
      case 'conversation': {
        const summary = state.conversation.snapshot.conversations.find(
          (candidate) => candidate.id === route.id,
        );
        return summary ? conversationLabel(summary) : routeTitle(route);
      }
      case 'transcript': {
        const transcript = state.transcripts.list.transcripts.find(
          (candidate) => candidate.id === route.id,
        );
        return transcript ? transcriptLabel(transcript) : routeTitle(route);
      }
      case 'record': {
        const parsed = typeof route.record.raw === 'string'
          ? parseTranscriptRecord(route.record.raw)
          : null;
        return parsed?.label ?? routeTitle(route);
      }
      case 'mcp-server':
        return state.mcp.selection?.name ?? routeTitle(route);
      case 'mcp-tool':
        return route.tool.name;
      case 'config-file':
        return route.path.split('/').pop() ?? routeTitle(route);
      default:
        return routeTitle(route);
    }
  }, [
    state.conversation.snapshot.conversations,
    state.mcp.selection,
    state.transcripts.list.transcripts,
  ]);

  const navigation = useClaudeAppNavigation({
    agentId: state.agentId,
    sessionId: state.sessionId,
    depth,
    titleOf,
  });
  // A selection that disappeared is an invalidation repair, not a leave: it
  // must not become a forward destination the gesture could re-open.
  useClaudeAppSync(state, navigation.top, navigation.retireTop);

  if (!state.agentId || !state.sessionId) {
    return (
      <div
        data-testid="claude-code-app-workspace"
        className="flex h-full min-h-0 items-center justify-center p-6"
      >
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          Select an agent and session to browse Claude Code.
        </p>
      </div>
    );
  }

  const agentOffline =
    ctx.domain !== null
      ? ctx.domain.agent.channel === 'offline' || ctx.domain.agent.channel === 'error'
      : ctx.agent !== undefined && ctx.agent.status !== 'online';

  const data: ClaudeAppData = {
    state,
    agentId: state.agentId,
    sessionId: state.sessionId,
    agentOffline,
    actions: {
      push: navigation.push,
      openCandidate: navigation.openCandidate,
      openTranscript: navigation.openTranscript,
      setMcpEditor: navigation.setMcpEditor,
      setMcpRemoving: navigation.setMcpRemoving,
    },
  };

  const layers: (AppRoute | null)[] = [null, ...navigation.stack];
  const topIndex = layers.length - 1;

  return (
    <div
      data-testid="claude-code-app-workspace"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {layers.map((route, index) => {
        const covered = index !== topIndex;
        return (
          <div
            key={route === null ? 'root' : `${index}:${routeKey(route)}`}
            data-testid={route === null ? 'claude-app-root' : `claude-app-layer-${route.kind}`}
            data-covered={covered ? 'true' : undefined}
            aria-hidden={covered || undefined}
            inert={covered || undefined}
            className="absolute inset-0 flex min-h-0 flex-col bg-workspace-background"
          >
            {route === null ? (
              <ConversationRootScreen data={data} />
            ) : (
              <ClaudeAppRouteLayer route={route} data={data} />
            )}
          </div>
        );
      })}

      <BrowseSheet
        open={navigation.browseOpen}
        onOpenChange={navigation.setBrowseOpen}
        onChoose={navigation.openResource}
      />

      {/* One dialog host for the whole App composition. The list and detail
          layers both draw `McpView`; mounting the editor/remove dialogs once
          here keeps a pending mutation from existing twice. */}
      <McpEditorHost
        mcp={state.mcp}
        experience="app"
        editor={navigation.mcpEditor}
        onClose={() => navigation.setMcpEditor(null)}
      />
      <McpRemoveHost
        mcp={state.mcp}
        experience="app"
        entry={navigation.mcpRemoving}
        onClose={() => navigation.setMcpRemoving(null)}
      />
    </div>
  );
}
