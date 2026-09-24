import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type {
  ClaudeCodeListResponse,
  ClaudeCodeReadOk,
  ClaudeCodeReadResponse,
} from '../types';
import { cn } from '@/shared/lib/utils';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { ConversationView } from './ConversationView';
import { useConversation } from '../hooks/useConversation';

type Scope = 'global' | 'project';

/**
 * What the Workspace is showing.
 *
 * `conversation` is first and is where a Session change lands, because `#1005`
 * decision 3 makes the current work the entry point and the config browser the
 * thing you go looking for. Both remain reachable; neither is a fallback for
 * the other.
 */
type View = 'conversation' | Scope;
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
type ScopeRequestIds = Record<Scope, number>;

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

/**
 * Where the next chunk starts.
 *
 * Takes the ok half, not the union: `offset` and `content` exist on the success
 * shape alone, and the union has no discriminator to narrow on — which is
 * precisely what the flattened mirror hid by declaring both optional on one
 * interface.
 */
function responseNextOffset(response: ClaudeCodeReadOk): number {
  return response.offset + new TextEncoder().encode(response.content).length;
}

/**
 * A read response, folded into the scope state it belongs to.
 *
 * `append` is the whole difference between opening a file and continuing one:
 * everything else — which half of the union this is, what the offsets become,
 * whether more remains — is the same question. The failure half is handled first
 * and leaves the content alone, so a failed continuation keeps what was already
 * readable rather than blanking it.
 */
function readInto(
  state: ScopeState,
  response: ClaudeCodeReadResponse,
  append: boolean,
): ScopeState {
  if ('error' in response) {
    return { ...state, readLoading: false, readError: response.error };
  }
  return {
    ...state,
    content: append ? state.content + response.content : response.content,
    contentType: append ? state.contentType : response.content_type,
    totalSize: append ? state.totalSize : response.total_size,
    hasMore: response.has_more,
    nextOffset: responseNextOffset(response),
    readLoading: false,
    readError: null,
  };
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
          <h2 className="mb-1 px-2 text-xs font-semibold text-muted-foreground">
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
  setScopeStates,
  readRequestIds,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  requestKey: string | null;
  setScopeStates: React.Dispatch<React.SetStateAction<ScopeStates>>;
  readRequestIds: React.MutableRefObject<ScopeRequestIds>;
}) {
  const currentRequestKey = useRef<string | null>(null);
  const contextGeneration = useRef(0);
  const listRequestIds = useRef<ScopeRequestIds>({ global: 0, project: 0 });
  const loadScope = useCallback(async (scope: Scope, key: string, generation: number) => {
    if (!agentId || !sessionId || currentRequestKey.current !== key) {
      return;
    }
    const requestId = ++listRequestIds.current[scope];
    const isCurrentRequest = () => (
      currentRequestKey.current === key
      && contextGeneration.current === generation
      && listRequestIds.current[scope] === requestId
    );
    updateScope(setScopeStates, scope, (state) => ({ ...state, loading: true, error: null }));
    try {
      const response: ClaudeCodeListResponse = await claudeCodeApi.claudeCodeList(
        scopeRequest(agentId, sessionId, scope),
      );
      if (!isCurrentRequest()) {
        return;
      }
      updateScope(setScopeStates, scope, (state) => ({
        ...state,
        categories: response.categories,
        available: response.available,
        loading: false,
        // No `error` to read: `claude-code.list` reports "that directory does
        // not exist" as `available: false` with an empty list, which is an
        // answer rather than an error. The field this used to read was invented
        // by the hand-written mirror.
        error: null,
      }));
    } catch (error) {
      if (!isCurrentRequest()) {
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
    contextGeneration.current += 1;
    const generation = contextGeneration.current;
    currentRequestKey.current = requestKey;
    readRequestIds.current.global += 1;
    readRequestIds.current.project += 1;
    setScopeStates(createScopeStates(Boolean(requestKey)));
    if (!requestKey) {
      return;
    }
    void loadScope('global', requestKey, generation);
    void loadScope('project', requestKey, generation);
  }, [loadScope, readRequestIds, requestKey, setScopeStates]);

  return { contextGeneration, currentRequestKey, loadScope };
}

/**
 * Reading a config file: open one, and continue one.
 *
 * The two are the same request with a different offset, and they share the one
 * thing worth getting right — a response that arrives after the user changed
 * Session, or picked another file, must be **dropped rather than rendered**.
 * Written twice that comparison would be two places to get subtly wrong, and a
 * wrong one here shows another Session's file contents under this Session's
 * name. So the guard lives in one place and both callers use it.
 */
function useFileReader({
  agentId,
  sessionId,
  currentRequestKey,
  readRequestIds,
  setScopeStates,
  scopeStates,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  currentRequestKey: { current: string | null };
  readRequestIds: { current: ScopeRequestIds };
  setScopeStates: React.Dispatch<React.SetStateAction<ScopeStates>>;
  scopeStates: ScopeStates;
}) {
  /** Whether an answer that just arrived is still the one being waited for. */
  const wanted = useCallback(
    (key: string, scope: Scope, requestId: number) =>
      currentRequestKey.current === key && readRequestIds.current[scope] === requestId,
    [currentRequestKey, readRequestIds],
  );

  const fail = useCallback(
    (key: string, scope: Scope, requestId: number, error: unknown) => {
      if (!wanted(key, scope, requestId)) {
        return;
      }
      updateScope(setScopeStates, scope, (state) => ({
        ...state,
        readLoading: false,
        readError: errorMessage(error),
      }));
    },
    [setScopeStates, wanted],
  );

  const handleFileClick = useCallback(
    async (scope: Scope, file: ConfigFile) => {
      if (!agentId || !sessionId || !currentRequestKey.current) {
        return;
      }
      const key = currentRequestKey.current;
      const requestId = ++readRequestIds.current[scope];
      // Only the read half is reset. `createScopeState` would also clear
      // `categories` and `available`, which is the *list* — and clearing the
      // list on a file click makes the file you just clicked disappear.
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
        const response = await claudeCodeApi.claudeCodeRead(
          scopeReadRequest({ agentId, sessionId, scope, path: file.path, offset: 0 }),
        );
        if (!wanted(key, scope, requestId)) {
          return;
        }
        updateScope(setScopeStates, scope, (state) => readInto(state, response, false));
      } catch (error) {
        fail(key, scope, requestId, error);
      }
    },
    [agentId, currentRequestKey, fail, readRequestIds, sessionId, setScopeStates, wanted],
  );

  const handleLoadMore = useCallback(
    async (scope: Scope) => {
      if (!agentId || !sessionId || !currentRequestKey.current) {
        return;
      }
      const state = scopeStates[scope];
      if (!state.selectedFile || !state.hasMore) {
        return;
      }
      const key = currentRequestKey.current;
      const requestId = ++readRequestIds.current[scope];
      updateScope(setScopeStates, scope, (current) => ({
        ...current,
        readLoading: true,
        readError: null,
      }));
      try {
        const response = await claudeCodeApi.claudeCodeRead(
          scopeReadRequest({
            agentId,
            sessionId,
            scope,
            path: state.selectedFile.path,
            offset: state.nextOffset,
          }),
        );
        if (!wanted(key, scope, requestId)) {
          return;
        }
        updateScope(setScopeStates, scope, (current) => readInto(current, response, true));
      } catch (error) {
        fail(key, scope, requestId, error);
      }
    },
    [agentId, currentRequestKey, fail, readRequestIds, scopeStates, sessionId, setScopeStates, wanted],
  );

  return { handleFileClick, handleLoadMore };
}

function useClaudeCodeWorkspace(ctx: WorkspaceContext) {
  const agentId = ctx.agent?.agent_id;
  const sessionId = ctx.session?.session_id;
  const requestKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;
  const readRequestIds = useRef<ScopeRequestIds>({ global: 0, project: 0 });
  const [scopeStates, setScopeStates] = useState<ScopeStates>(() => createScopeStates(true));
  // The conversation is where a Session lands (`#1005` decision 3: the current
  // work is the entry point). Not re-forced on a Session change, though — the
  // hook drops the old Session's answers on its own, and throwing someone out of
  // the config browser mid-read would be a view decision they did not make.
  const [activeView, setActiveView] = useState<View>('conversation');
  // Derived, not a second piece of state: the tab already says which scope is
  // showing, and two sources for that is how the Project tab came to render the
  // Global panel.
  const activeScope: Scope = activeView === 'project' ? 'project' : 'global';
  const conversation = useConversation({ agentId, sessionId });

  const { contextGeneration, currentRequestKey, loadScope } = useScopeLoader({
    agentId,
    sessionId,
    requestKey,
    setScopeStates,
    readRequestIds,
  });

  const handleRetry = useCallback((scope: Scope) => {
    if (currentRequestKey.current) {
      void loadScope(scope, currentRequestKey.current, contextGeneration.current);
    }
  }, [contextGeneration, currentRequestKey, loadScope]);

  const { handleFileClick, handleLoadMore } = useFileReader({
    agentId,
    sessionId,
    currentRequestKey,
    readRequestIds,
    setScopeStates,
    scopeStates,
  });

  return {
    agentId,
    sessionId,
    activeScope,
    activeView,
    setActiveView,
    scopeStates,
    handleRetry,
    handleFileClick,
    handleLoadMore,
    conversation,
  };
}

export function ClaudeCodeWorkspace({ ctx }: { ctx: WorkspaceContext }) {
  const {
    agentId,
    sessionId,
    activeScope,
    activeView,
    setActiveView,
    scopeStates,
    handleRetry,
    handleFileClick,
    handleLoadMore,
    conversation,
  } = useClaudeCodeWorkspace(ctx);

  if (!agentId || !sessionId) {
    return (
      <div data-testid="claude-code-workspace" className="flex h-full min-h-0 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Select an agent and session to browse Claude Code files.</p>
      </div>
    );
  }

  const activeState = scopeStates[activeScope];
  const showHeading = ctx.experience !== 'app';
  return (
    <div data-testid="claude-code-workspace" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3">
        {showHeading ? (
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Claude Code</h1>
          </div>
        ) : null}
        <Tabs value={activeView} onValueChange={(value) => setActiveView(value as View)}>
          <TabsList>
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
            <TabsTrigger value="global">Global</TabsTrigger>
            <TabsTrigger value="project">Project</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>
      {activeView === 'conversation' ? (
        <main className="flex min-h-0 flex-1 flex-col">
          <ConversationView
            view={conversation.view}
            onSelect={conversation.select}
            onLoadOlder={() => void conversation.loadOlder()}
            onReload={conversation.reload}
          />
        </main>
      ) : (
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
      )}
    </div>
  );
}
