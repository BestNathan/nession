import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { claudeCodeApi } from '@/features/claude-code';
import type {
  ClaudeCodeListResponse,
  ClaudeCodeReadResponse,
} from '@/features/claude-code/types';
import { cn } from '@/lib/utils';
import type { WorkspaceContext } from '@/session-first/workspace/toolTypes';

type Scope = 'global' | 'project';
type ConfigCategory = ClaudeCodeListResponse['categories'][number];
type ConfigFile = ConfigCategory['files'][number];

interface ScopeState {
  categories: ConfigCategory[];
  available: boolean | null;
  loading: boolean;
  error: string | null;
  selectedFile: ConfigFile | null;
  content: string;
  contentType: string;
  totalSize: number;
  hasMore: boolean;
  nextOffset: number;
  readLoading: boolean;
  readError: string | null;
}

type ScopeStates = Record<Scope, ScopeState>;

const SCOPES: Scope[] = ['global', 'project'];

function createScopeState(loading: boolean): ScopeState {
  return {
    categories: [],
    available: null,
    loading,
    error: null,
    selectedFile: null,
    content: '',
    contentType: '',
    totalSize: 0,
    hasMore: false,
    nextOffset: 0,
    readLoading: false,
    readError: null,
  };
}

function createScopeStates(loading: boolean): ScopeStates {
  return {
    global: createScopeState(loading),
    project: createScopeState(loading),
  };
}

function updateScope(
  setStates: React.Dispatch<React.SetStateAction<ScopeStates>>,
  scope: Scope,
  update: (state: ScopeState) => ScopeState,
) {
  setStates((current) => ({
    ...current,
    [scope]: update(current[scope]),
  }));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load Claude Code files';
}

function responseNextOffset(response: ClaudeCodeReadResponse): number {
  return response.offset + new TextEncoder().encode(response.content).length;
}

function scopeRequest(
  agentId: string,
  sessionId: string,
  scope: Scope,
): { agent_id: string; scope: Scope; session_id?: string } {
  if (scope === 'project') {
    return { agent_id: agentId, scope, session_id: sessionId };
  }
  return { agent_id: agentId, scope };
}

function scopeReadRequest({
  agentId,
  sessionId,
  scope,
  path,
  offset,
}: {
  agentId: string;
  sessionId: string;
  scope: Scope;
  path: string;
  offset: number;
}) {
  return { ...scopeRequest(agentId, sessionId, scope), path, offset };
}

function FileList({
  state,
  scope,
  onFileClick,
  active,
}: {
  state: ScopeState;
  scope: Scope;
  onFileClick: (scope: Scope, file: ConfigFile) => void;
  active: boolean;
}) {
  return (
    <div className="space-y-4 p-3" data-testid={active ? 'claude-code-file-list' : undefined}>
      {state.categories.map((category) => (
        <section key={category.name}>
          <h2 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {category.name}
          </h2>
          <div className="space-y-0.5">
            {category.files.map((file) => (
              <button
                key={file.path}
                type="button"
                aria-label={file.path}
                aria-current={state.selectedFile?.path === file.path ? 'true' : undefined}
                onClick={() => onFileClick(scope, file)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  state.selectedFile?.path === file.path && 'bg-accent text-accent-foreground',
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{file.path}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ScopePanel({
  state,
  scope,
  onFileClick,
  onRetry,
  active,
}: {
  state: ScopeState;
  scope: Scope;
  onFileClick: (scope: Scope, file: ConfigFile) => void;
  onRetry: (scope: Scope) => void;
  active: boolean;
}) {
  if (state.loading) {
    return (
      <div className="p-4" data-testid={`claude-code-scope-${scope}`} data-scope={scope}>
        <p className="text-sm text-muted-foreground">Loading Claude Code files...</p>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="space-y-3 p-4" data-testid={`claude-code-scope-${scope}`} data-scope={scope}>
        <p className="text-sm text-destructive" role="alert">{state.error}</p>
        <Button
          data-testid={`claude-code-retry-${scope}`}
          variant="outline"
          size="sm"
          onClick={() => onRetry(scope)}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (state.available === false) {
    return (
      <div className="p-4" data-testid={`claude-code-scope-${scope}`} data-scope={scope}>
        <p className="text-sm text-muted-foreground">Claude Code not installed</p>
      </div>
    );
  }
  if (state.categories.length === 0) {
    return (
      <div className="p-4" data-testid={`claude-code-scope-${scope}`} data-scope={scope}>
        <p className="text-sm text-muted-foreground">No Claude Code files found.</p>
      </div>
    );
  }
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid={`claude-code-scope-${scope}`}
      data-scope={scope}
    >
      <FileList state={state} scope={scope} onFileClick={onFileClick} active={active} />
    </div>
  );
}

function ContentPanel({
  state,
  scope,
  onLoadMore,
}: {
  state: ScopeState;
  scope: Scope;
  onLoadMore: (scope: Scope) => void;
}) {
  if (!state.selectedFile) {
    return <p className="p-6 text-sm text-muted-foreground">Select a file to view its content.</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={state.selectedFile.path}>{state.selectedFile.path}</p>
          <p className="text-xs text-muted-foreground">
            {state.contentType || state.selectedFile.content_type} · {formatSize(state.totalSize || state.selectedFile.size)}
          </p>
        </div>
        {state.hasMore && (
          <Button
            data-testid="claude-code-load-more"
            variant="outline"
            size="sm"
            disabled={state.readLoading}
            onClick={() => onLoadMore(scope)}
          >
            Load more
          </Button>
        )}
      </div>
      {state.readLoading && <p className="py-3 text-sm text-muted-foreground">Loading content...</p>}
      {state.readError && <p className="py-3 text-sm text-destructive" role="alert">{state.readError}</p>}
      <pre data-testid="claude-code-content" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap py-4 font-mono text-xs">
        {state.content || (state.readLoading ? '' : '(empty)')}
      </pre>
    </div>
  );
}

function useScopeLoader({
  agentId,
  sessionId,
  requestKey,
  setActiveScope,
  setScopeStates,
  readRequestId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  requestKey: string | null;
  setActiveScope: React.Dispatch<React.SetStateAction<Scope>>;
  setScopeStates: React.Dispatch<React.SetStateAction<ScopeStates>>;
  readRequestId: React.MutableRefObject<number>;
}) {
  const currentRequestKey = useRef<string | null>(null);
  const loadScope = useCallback(async (scope: Scope, key: string) => {
    if (!agentId || !sessionId || currentRequestKey.current !== key) {
      return;
    }
    updateScope(setScopeStates, scope, (state) => ({ ...state, loading: true, error: null }));
    try {
      const response: ClaudeCodeListResponse = await claudeCodeApi.claudeCodeList(
        scopeRequest(agentId, sessionId, scope),
      );
      if (currentRequestKey.current !== key) {
        return;
      }
      updateScope(setScopeStates, scope, (state) => ({
        ...state,
        categories: response.categories,
        available: response.available,
        loading: false,
        error: response.error ?? null,
      }));
    } catch (error) {
      if (currentRequestKey.current !== key) {
        return;
      }
      updateScope(setScopeStates, scope, (state) => ({
        ...state,
        loading: false,
        error: errorMessage(error),
      }));
    }
  }, [agentId, sessionId, setScopeStates]);

  useEffect(() => {
    currentRequestKey.current = requestKey;
    readRequestId.current += 1;
    setActiveScope('global');
    setScopeStates(createScopeStates(Boolean(requestKey)));
    if (!requestKey) {
      return;
    }
    void loadScope('global', requestKey);
    void loadScope('project', requestKey);
  }, [loadScope, requestKey, readRequestId, setActiveScope, setScopeStates]);

  return { currentRequestKey, loadScope };
}

function useClaudeCodeWorkspace(ctx: WorkspaceContext) {
  const agentId = ctx.agent?.agent_id;
  const sessionId = ctx.session?.session_id;
  const requestKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;
  const readRequestId = useRef(0);
  const [activeScope, setActiveScope] = useState<Scope>('global');
  const [scopeStates, setScopeStates] = useState<ScopeStates>(() => createScopeStates(true));

  const { currentRequestKey, loadScope } = useScopeLoader({
    agentId,
    sessionId,
    requestKey,
    setActiveScope,
    setScopeStates,
    readRequestId,
  });

  const handleRetry = useCallback((scope: Scope) => {
    if (currentRequestKey.current) {
      void loadScope(scope, currentRequestKey.current);
    }
  }, [currentRequestKey, loadScope]);

  const handleFileClick = useCallback(async (scope: Scope, file: ConfigFile) => {
    if (!agentId || !sessionId || !currentRequestKey.current) {
      return;
    }
    const key = currentRequestKey.current;
    const requestId = ++readRequestId.current;
    updateScope(setScopeStates, scope, (state) => ({
      ...state,
      selectedFile: file,
      content: '',
      contentType: '',
      totalSize: 0,
      hasMore: false,
      nextOffset: 0,
      readLoading: true,
      readError: null,
    }));
    try {
      const response: ClaudeCodeReadResponse = await claudeCodeApi.claudeCodeRead(
        scopeReadRequest({ agentId, sessionId, scope, path: file.path, offset: 0 }),
      );
      if (currentRequestKey.current !== key || readRequestId.current !== requestId) {
        return;
      }
      updateScope(setScopeStates, scope, (state) => ({
        ...state,
        content: response.error ? '' : response.content,
        contentType: response.error ? '' : response.content_type,
        totalSize: response.error ? 0 : response.total_size,
        hasMore: response.error ? false : response.has_more,
        nextOffset: response.error ? state.nextOffset : responseNextOffset(response),
        readLoading: false,
        readError: response.error ?? null,
      }));
    } catch (error) {
      if (currentRequestKey.current !== key || readRequestId.current !== requestId) {
        return;
      }
      updateScope(setScopeStates, scope, (state) => ({
        ...state,
        readLoading: false,
        readError: errorMessage(error),
      }));
    }
  }, [agentId, currentRequestKey, sessionId]);

  const handleLoadMore = useCallback(async (scope: Scope) => {
    if (!agentId || !sessionId || !currentRequestKey.current) {
      return;
    }
    const state = scopeStates[scope];
    if (!state.selectedFile || !state.hasMore) {
      return;
    }
    const key = currentRequestKey.current;
    const requestId = ++readRequestId.current;
    const offset = state.nextOffset;
    updateScope(setScopeStates, scope, (current) => ({ ...current, readLoading: true, readError: null }));
    try {
      const response: ClaudeCodeReadResponse = await claudeCodeApi.claudeCodeRead(
        scopeReadRequest({ agentId, sessionId, scope, path: state.selectedFile.path, offset }),
      );
      if (currentRequestKey.current !== key || readRequestId.current !== requestId) {
        return;
      }
      updateScope(setScopeStates, scope, (current) => ({
        ...current,
        content: response.error ? current.content : current.content + response.content,
        hasMore: response.error ? current.hasMore : response.has_more,
        nextOffset: response.error ? current.nextOffset : responseNextOffset(response),
        readLoading: false,
        readError: response.error ?? null,
      }));
    } catch (error) {
      if (currentRequestKey.current !== key || readRequestId.current !== requestId) {
        return;
      }
      updateScope(setScopeStates, scope, (current) => ({
        ...current,
        readLoading: false,
        readError: errorMessage(error),
      }));
    }
  }, [agentId, currentRequestKey, scopeStates, sessionId]);

  return {
    agentId,
    sessionId,
    activeScope,
    setActiveScope,
    scopeStates,
    handleRetry,
    handleFileClick,
    handleLoadMore,
  };
}

export function ClaudeCodeWorkspace({ ctx }: { ctx: WorkspaceContext }) {
  const {
    agentId,
    sessionId,
    activeScope,
    setActiveScope,
    scopeStates,
    handleRetry,
    handleFileClick,
    handleLoadMore,
  } = useClaudeCodeWorkspace(ctx);

  if (!agentId || !sessionId) {
    return (
      <div data-testid="claude-code-workspace" className="flex h-full min-h-0 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Select an agent and session to browse Claude Code files.</p>
      </div>
    );
  }

  const activeState = scopeStates[activeScope];
  return (
    <div data-testid="claude-code-workspace" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Claude Code</h1>
        </div>
        <Tabs value={activeScope} onValueChange={(value) => setActiveScope(value as Scope)}>
          <TabsList>
            <TabsTrigger value="global">Global</TabsTrigger>
            <TabsTrigger value="project">Project</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
        <aside className="min-h-0 border-r">
          {SCOPES.map((scope) => (
            <div key={scope} className={activeScope === scope ? 'flex h-full min-h-0' : 'hidden'}>
              <ScopePanel
                state={scopeStates[scope]}
                scope={scope}
                onFileClick={handleFileClick}
                onRetry={handleRetry}
                active={activeScope === scope}
              />
            </div>
          ))}
        </aside>
        <main className="flex min-h-0 flex-col">
          <ContentPanel state={activeState} scope={activeScope} onLoadMore={handleLoadMore} />
        </main>
      </div>
    </div>
  );
}
