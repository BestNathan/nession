import { useCallback, useEffect, useRef, useState } from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type {
  ClaudeCodeListResponse,
  ClaudeCodeReadOk,
  ClaudeCodeReadResponse,
} from '../types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { useAIConversation } from '@/shared/ai-conversation';
import { claudeCodeConversationAdapter } from '../conversation/adapter';
import { useTranscripts } from './useTranscripts';
import { useTranscriptRecords } from './useTranscriptRecords';
import { useMemory } from './useMemory';
import { useMcp } from './useMcp';

/**
 * The Claude resources a Workspace surface can show.
 *
 * The type deliberately does **not** contain a config scope (#1120 item 7):
 * `Project` and `Global` are scopes *of configuration*, not siblings of the
 * conversation or the transcript. A surface that needs the scope finds it
 * inside Configuration, which is what makes the old flattened
 * `Conversation | Global | Project` row unrepresentable rather than merely
 * fixed.
 *
 * `memory` is a sibling of `configuration`, not a scope inside it (#2689): its
 * subject is the current Session's repository, resolved agent-side, so it has
 * no Global/Project axis and no repository picker.
 */
export type ClaudeCodeResourceView =
  | 'conversations'
  | 'transcripts'
  | 'memory'
  | 'mcp'
  | 'configuration';

/** The two scopes Configuration owns. */
export type ClaudeCodeConfigScope = 'global' | 'project';

export type ClaudeCodeConfigCategory = ClaudeCodeListResponse['categories'][number];
export type ClaudeCodeConfigFile = ClaudeCodeConfigCategory['files'][number];

export interface ScopeState {
  categories: ClaudeCodeConfigCategory[];
  available: boolean | null;
  loading: boolean;
  error: string | null;
  selectedFile: ClaudeCodeConfigFile | null;
  content: string;
  contentType: string;
  totalSize: number;
  hasMore: boolean;
  nextOffset: number;
  readLoading: boolean;
  readError: string | null;
}

export type ScopeStates = Record<ClaudeCodeConfigScope, ScopeState>;
type ScopeRequestIds = Record<ClaudeCodeConfigScope, number>;

export const SCOPES: ClaudeCodeConfigScope[] = ['global', 'project'];

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
  scope: ClaudeCodeConfigScope,
  update: (state: ScopeState) => ScopeState,
) {
  setStates((current) => ({
    ...current,
    [scope]: update(current[scope]),
  }));
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
  scope: ClaudeCodeConfigScope,
): { agent_id: string; scope: ClaudeCodeConfigScope; session_id?: string } {
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
  scope: ClaudeCodeConfigScope;
  path: string;
  offset: number;
}) {
  return { ...scopeRequest(agentId, sessionId, scope), path, offset };
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
  const loadScope = useCallback(
    async (scope: ClaudeCodeConfigScope, key: string, generation: number) => {
      if (!agentId || !sessionId || currentRequestKey.current !== key) {
        return;
      }
      const requestId = ++listRequestIds.current[scope];
      const isCurrentRequest = () =>
        currentRequestKey.current === key &&
        contextGeneration.current === generation &&
        listRequestIds.current[scope] === requestId;
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
    },
    [agentId, sessionId, setScopeStates],
  );

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
    (key: string, scope: ClaudeCodeConfigScope, requestId: number) =>
      currentRequestKey.current === key && readRequestIds.current[scope] === requestId,
    [currentRequestKey, readRequestIds],
  );

  const fail = useCallback(
    (key: string, scope: ClaudeCodeConfigScope, requestId: number, error: unknown) => {
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
    async (scope: ClaudeCodeConfigScope, file: ClaudeCodeConfigFile) => {
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
    async (scope: ClaudeCodeConfigScope) => {
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
    [
      agentId,
      currentRequestKey,
      fail,
      readRequestIds,
      scopeStates,
      sessionId,
      setScopeStates,
      wanted,
    ],
  );

  return { handleFileClick, handleLoadMore };
}

/**
 * The state every Claude Workspace surface shares.
 *
 * One hook, two compositions: Web draws it as tabs and master/detail, App as a
 * conversation-first stack. The transport, the generation guards, the lazy
 * activation and the config reader stay here so the two presentations cannot
 * disagree about what the Session answered.
 *
 * `activeView` is both the visible resource and the fetch trigger for Memory
 * and MCP: a Session that never opens one of them pays nothing, and entering it
 * re-resolves the provider's answer (#2689, #3600).
 */
export function useClaudeCodeWorkspace(ctx: WorkspaceContext) {
  const agentId = ctx.agent?.agent_id;
  const sessionId = ctx.session?.session_id;
  const requestKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;
  const readRequestIds = useRef<ScopeRequestIds>({ global: 0, project: 0 });
  const [scopeStates, setScopeStates] = useState<ScopeStates>(() => createScopeStates(true));
  // The conversation is where a Session lands (`#1005` decision 3: the current
  // work is the entry point). Not re-forced on a Session change, though — the
  // hook drops the old Session's answers on its own, and throwing someone out of
  // the config browser mid-read would be a view decision they did not make.
  const [activeView, setActiveView] = useState<ClaudeCodeResourceView>('conversations');
  // Its own state now that the top-level tabs no longer name a scope (#1120
  // item 7). It used to be *derived* from the tab, with a comment warning that
  // two sources for the scope is how the Project tab came to render the Global
  // panel — so the hazard is worth answering rather than ignoring.
  //
  // It does not come back: this is now the only source. It drives both the
  // scope selector's value and the panel that renders, so the two cannot
  // disagree, which is a stronger guarantee than the derivation gave — that one
  // was correct but only because the tab and the scope were the same value.
  //
  // `project` by default: the more specific scope is the more likely one to
  // want, and it is the order `#1120` writes the pair in.
  const [activeScope, setActiveScope] = useState<ClaudeCodeConfigScope>('project');
  // The conversation comes from the shared framework (#1363). What is
  // Claude-specific is the adapter; the runtime, the paging, the refresh and
  // every state below it are Nession's, and the same ones the capsule Peek
  // draws in the Terminal.
  const conversation = useAIConversation(
    claudeCodeConversationAdapter,
    agentId && sessionId ? { agentId, sessionId } : null,
  );

  // `#1234`. The transcript projection is a second first-class view over the
  // same upstream sessions, not a debug switch on the conversation one.
  //
  // Which transcript is open is the caller's state rather than the hook's,
  // because the list outlives the selection: switching resources must not
  // forget where the reader was, and the list does not depend on what is open.
  const [openTranscript, setOpenTranscript] = useState<string | null>(null);
  const transcripts = useTranscripts({ agentId, sessionId });
  const transcriptRecords = useTranscriptRecords({
    agentId,
    sessionId,
    transcriptId: openTranscript,
  });

  // A different Session or Agent is a different transcript scope. The open
  // transcript and any raw inspector from the previous scope must not remain
  // readable under the new one (#3726).
  useEffect(() => {
    setOpenTranscript(null);
  }, [agentId, sessionId]);
  // Memory is fetched only while its view is active, so a Session that never
  // opens it pays nothing. `active` is also the refresh trigger: entering the
  // view re-resolves the Session's repository before any file is shown (#2689).
  const memory = useMemory({ agentId, sessionId, active: activeView === 'memory' });
  // MCP is a resource view of the same Session (#3600). It reads configuration
  // only while the view is active; the explicit Inspect action is what contacts
  // a server, and it lives behind the same generation guard as every other answer.
  const mcp = useMcp({ agentId, sessionId, active: activeView === 'mcp' });

  const { contextGeneration, currentRequestKey, loadScope } = useScopeLoader({
    agentId,
    sessionId,
    requestKey,
    setScopeStates,
    readRequestIds,
  });

  const handleRetry = useCallback(
    (scope: ClaudeCodeConfigScope) => {
      if (currentRequestKey.current) {
        void loadScope(scope, currentRequestKey.current, contextGeneration.current);
      }
    },
    [contextGeneration, currentRequestKey, loadScope],
  );

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
    setActiveScope,
    activeView,
    setActiveView,
    scopeStates,
    handleRetry,
    handleFileClick,
    handleLoadMore,
    conversation,
    transcripts,
    transcriptRecords,
    openTranscript,
    setOpenTranscript,
    memory,
    mcp,
  };
}

/** What a Claude Workspace surface receives from the shared hook. */
export type ClaudeCodeWorkspaceState = ReturnType<typeof useClaudeCodeWorkspace>;
