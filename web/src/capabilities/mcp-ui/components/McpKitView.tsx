import { useCallback, useEffect, useState } from 'react';

import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';
import { DetailEmpty, DetailNote } from '@/components/ui/resource-detail';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceBoundedScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { cn } from '@/shared/lib/utils';

import { useMcpKit } from '../hooks/useMcpKit';
import type {
  McpServerEntry,
  McpTool,
  McpUiExperience,
  McpUiProvider,
} from '../types';
import { McpServerConfigEditor } from './McpServerConfigEditor';
import { McpServerDetail } from './McpServerDetail';
import { McpServerList } from './McpServerList';
import { McpToolInspector } from './McpToolInspector';
import { McpToolList } from './McpToolList';

type EditorState = 'none' | 'add' | 'edit';
type ToolPanel = 'contract' | 'run';
type AppLevel = 'list' | 'add' | 'edit' | 'server' | 'tool' | 'run';

type McpKitController = ReturnType<typeof useMcpKit>;

interface UiState {
  server: McpServerEntry | null;
  selectedTool: McpTool | null;
  editor: EditorState;
  toolPanel: ToolPanel;
}

interface UiActions {
  selectServer: (server: McpServerEntry) => void;
  selectTool: (tool: McpTool) => void;
  setEditor: (editor: EditorState) => void;
  setToolPanel: (panel: ToolPanel) => void;
}

function appLevelOf(state: UiState): AppLevel {
  if (state.editor === 'add') {
    return 'add';
  }
  if (state.editor === 'edit' && state.server) {
    return 'edit';
  }
  if (!state.server) {
    return 'list';
  }
  if (state.selectedTool) {
    return state.toolPanel === 'run' ? 'run' : 'tool';
  }
  return 'server';
}

/** App navigation is the host's; this only registers the depth it renders. */
function useAppDepthPush({
  experience,
  depth,
  level,
  serverName,
  toolName,
  leave,
}: {
  experience: McpUiExperience;
  depth: WorkspaceDepthControl | undefined;
  level: AppLevel;
  serverName: string | undefined;
  toolName: string | undefined;
  leave: (target: 'list' | 'server' | 'tool') => void;
}) {
  useEffect(() => {
    if (experience !== 'app' || !depth) {
      return;
    }
    if (level === 'list') {
      depth.setPush(null);
    } else if (level === 'add' || level === 'edit') {
      depth.setPush({
        title: level === 'add' ? 'Add MCP server' : 'Edit MCP configuration',
        onLeave: () => leave('server'),
      });
    } else if (level === 'server') {
      depth.setPush({ title: serverName ?? 'MCP Server', onLeave: () => leave('list') });
    } else if (level === 'tool') {
      depth.setPush({ title: toolName ?? 'MCP Tool', onLeave: () => leave('server') });
    } else {
      depth.setPush({
        title: toolName ? `Run ${toolName}` : 'Tool Runner',
        onLeave: () => leave('tool'),
      });
    }
  }, [depth, experience, leave, level, serverName, toolName]);
}

function McpServerEditorPane({
  kit,
  provider,
  state,
  actions,
}: {
  kit: McpKitController;
  provider: McpUiProvider;
  state: UiState;
  actions: UiActions;
}) {
  const editing = state.editor === 'edit' ? (state.server ?? undefined) : undefined;
  return (
    <div className="min-w-0 p-3">
      <McpServerConfigEditor
        key={editing ? `${editing.name}:${editing.scope}` : 'add'}
        server={editing}
        scopes={provider.capabilities.scopes}
        busy={kit.mutationBusy}
        error={kit.mutationError}
        onSave={async (mutation) => {
          const saved = await kit.mutateServer(mutation);
          if (saved) {
            actions.setEditor('none');
          }
          return saved;
        }}
        onCancel={() => actions.setEditor('none')}
      />
    </div>
  );
}

function McpDetailPane({
  kit,
  provider,
  state,
  actions,
  experience,
}: {
  kit: McpKitController;
  provider: McpUiProvider;
  state: UiState;
  actions: UiActions;
  experience: McpUiExperience;
}) {
  if (state.editor !== 'none') {
    return <McpServerEditorPane kit={kit} provider={provider} state={state} actions={actions} />;
  }
  if (state.selectedTool) {
    return (
      <McpToolInspector
        key={state.selectedTool.name}
        serverName={state.server?.name ?? ''}
        tool={state.selectedTool}
        discovered={kit.probe?.status === 'ok'}
        invocationSupported={provider.capabilities.invocation}
        status={kit.runStatus}
        error={kit.runError}
        result={kit.result}
        history={kit.history}
        onRun={kit.runTool}
        onCancelRun={kit.cancelRun}
        onSelectHistory={kit.selectHistory}
        onResetDraft={kit.resetDraft}
        panel={experience === 'app' ? state.toolPanel : undefined}
        onPanelChange={experience === 'app' ? actions.setToolPanel : undefined}
      />
    );
  }
  if (state.server) {
    return (
      <McpServerDetail
        server={state.server}
        capabilities={provider.capabilities}
        inventoryState={kit.inventory?.state}
        probe={kit.probe}
        probing={kit.probing}
        probeError={kit.probeError}
        mutationBusy={kit.mutationBusy}
        mutationError={kit.mutationError}
        mutationNotice={kit.mutationNotice}
        onTest={(options) => {
          void kit.probeConnection(options);
        }}
        onEdit={() => actions.setEditor('edit')}
        onRemove={async (target) =>
          kit.mutateServer({
            action: 'remove',
            name: target.name,
            scope: target.scope,
            expectedFingerprint: target.fingerprint,
          })
        }
      />
    );
  }
  return (
    <div className="min-w-0 p-3" data-testid="mcp-detail-empty">
      <DetailEmpty>Select a configured server to inspect its connection and Tools.</DetailEmpty>
    </div>
  );
}

function McpServerNavigation({
  kit,
  provider,
  state,
  actions,
}: {
  kit: McpKitController;
  provider: McpUiProvider;
  state: UiState;
  actions: UiActions;
}) {
  return (
    <McpServerList
      inventory={kit.inventory}
      loading={kit.inventoryLoading}
      error={kit.inventoryError}
      selected={state.server}
      canConfigure={provider.capabilities.configuration}
      onSelect={actions.selectServer}
      onAdd={() => actions.setEditor('add')}
    />
  );
}

function McpToolNavigation({
  kit,
  provider,
  state,
  actions,
}: {
  kit: McpKitController;
  provider: McpUiProvider;
  state: UiState;
  actions: UiActions;
}) {
  return (
    <McpToolList
      tools={kit.probe?.status === 'ok' ? (kit.probe.tools ?? []) : []}
      selected={state.selectedTool}
      probe={kit.probe}
      probing={kit.probing}
      discoverySupported={provider.capabilities.discovery}
      hasServer={state.server !== null}
      onSelect={actions.selectTool}
    />
  );
}

function McpKitWebBody({
  kit,
  provider,
  state,
  actions,
}: {
  kit: McpKitController;
  provider: McpUiProvider;
  state: UiState;
  actions: UiActions;
}) {
  return (
    <div
      data-testid="mcp-kit"
      data-experience="web"
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[minmax(11rem,15rem)_minmax(11rem,17rem)_minmax(0,1fr)] lg:overflow-hidden">
        <div className={cn('max-h-[45%] min-h-0 shrink-0 overflow-y-auto border-b border-border lg:max-h-none lg:shrink lg:border-b-0', workspaceBoundedScrollClearanceClass)}>
          <McpServerNavigation kit={kit} provider={provider} state={state} actions={actions} />
        </div>
        <div className={cn('max-h-[45%] min-h-0 shrink-0 overflow-y-auto border-b border-border lg:max-h-none lg:shrink lg:border-b-0', workspaceBoundedScrollClearanceClass)}>
          <McpToolNavigation kit={kit} provider={provider} state={state} actions={actions} />
        </div>
        <div className={cn('min-h-0 overflow-y-auto', workspaceBoundedScrollClearanceClass)}>
          <McpDetailPane
            kit={kit}
            provider={provider}
            state={state}
            actions={actions}
            experience="web"
          />
        </div>
      </div>
      {kit.inventory?.state === 'ready' && kit.inventory.servers.length === 0 ? (
        <p
          className={cn(
            'border-t border-border px-3 py-2 text-muted-foreground',
            chromeSansRole('caption'),
          )}
          data-testid="mcp-kit-empty"
        >
          No MCP servers are configured for the current Session Agent.
        </p>
      ) : null}
    </div>
  );
}

function McpKitAppBody({
  kit,
  provider,
  state,
  actions,
}: {
  kit: McpKitController;
  provider: McpUiProvider;
  state: UiState;
  actions: UiActions;
}) {
  const level = appLevelOf(state);
  return (
    <div
      data-testid="mcp-kit"
      data-experience="app"
      className={cn('flex h-full min-h-0 flex-col overflow-y-auto', workspaceBoundedScrollClearanceClass)}
    >
      {level === 'list' ? (
        <McpServerNavigation kit={kit} provider={provider} state={state} actions={actions} />
      ) : level === 'add' || level === 'edit' ? (
        <McpServerEditorPane kit={kit} provider={provider} state={state} actions={actions} />
      ) : level === 'server' ? (
        <>
          <McpDetailPane kit={kit} provider={provider} state={state} actions={actions} experience="app" />
          <McpToolNavigation kit={kit} provider={provider} state={state} actions={actions} />
        </>
      ) : (
        <McpDetailPane kit={kit} provider={provider} state={state} actions={actions} experience="app" />
      )}
    </div>
  );
}

/**
 * The shared MCP kit composition (#3772).
 *
 * The host supplies the provider, the authoritative Session/Agent context and
 * — on App — its depth control. This view owns no shell: no Sidebar, no App
 * Back/header, no capability picker and no global navigation. Web is a
 * capability-local master/detail; App is list → server → Tool → Run depth,
 * with the host's one Back as the only leave.
 */
export function McpKitView({
  provider,
  agentId,
  sessionId,
  experience,
  depth,
  timeoutMs,
}: {
  provider: McpUiProvider;
  agentId: string | undefined;
  sessionId: string | undefined;
  experience: McpUiExperience;
  depth?: WorkspaceDepthControl;
  timeoutMs?: number;
}) {
  const kit = useMcpKit({ provider, agentId, sessionId, timeoutMs });
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [editor, setEditor] = useState<EditorState>('none');
  const [toolPanel, setToolPanel] = useState<ToolPanel>('contract');
  const contextKey = `${agentId ?? ''}\u0000${sessionId ?? ''}`;

  // The Session owns the context: a move clears local depth that belonged to
  // the previous Agent. The hook already dropped the answers themselves.
  useEffect(() => {
    setSelectedTool(null);
    setEditor('none');
    setToolPanel('contract');
  }, [contextKey]);

  const selectServer = useCallback(
    (server: McpServerEntry) => {
      setSelectedTool(null);
      setEditor('none');
      setToolPanel('contract');
      kit.selectServer(server);
    },
    [kit],
  );

  const selectTool = useCallback((tool: McpTool) => {
    setSelectedTool(tool);
    setToolPanel('contract');
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedTool(null);
    setEditor('none');
    setToolPanel('contract');
    kit.selectServer(null);
  }, [kit]);

  const leave = useCallback(
    (target: 'list' | 'server' | 'tool') => {
      if (target === 'list') {
        clearSelection();
        return;
      }
      setSelectedTool(null);
      setToolPanel('contract');
      setEditor('none');
    },
    [clearSelection],
  );

  const state: UiState = {
    server: kit.selection,
    selectedTool,
    editor,
    toolPanel,
  };
  const actions: UiActions = {
    selectServer,
    selectTool,
    setEditor,
    setToolPanel,
  };

  useAppDepthPush({
    experience,
    depth,
    level: appLevelOf(state),
    serverName: kit.selection?.name,
    toolName: selectedTool?.name,
    leave,
  });

  if (!kit.contextMatches) {
    return (
      <div className="min-w-0 p-3" data-testid="mcp-kit-stale">
        <DetailNote>
          The Session changed while this MCP view was open. Its configuration and any
          in-flight result belong to the previous Session and are not shown.
        </DetailNote>
      </div>
    );
  }

  return experience === 'app' ? (
    <McpKitAppBody kit={kit} provider={provider} state={state} actions={actions} />
  ) : (
    <McpKitWebBody kit={kit} provider={provider} state={state} actions={actions} />
  );
}
