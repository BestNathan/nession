import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type {
  ClaudeCodeMemoryFile,
  ClaudeCodeMemoryResponse,
} from '../types';

/** Claude Code's index file. It is auto-opened when a memory directory has one. */
const MEMORY_INDEX = 'MEMORY.md';

/**
 * Everything the Memory view draws.
 *
 * `response` keeps the discovery answer whole — state, disclosure paths and
 * error — because the view switches on the closed state vocabulary rather than
 * collapsing it into a boolean. `selectedPath` and the read fields are a second
 * axis: which file, and how much of it has arrived.
 */
export interface MemoryState {
  response: ClaudeCodeMemoryResponse | null;
  files: ClaudeCodeMemoryFile[];
  loading: boolean;
  /** A transport failure of the discovery request, not a provider state. */
  error: string | null;
  selectedPath: string | null;
  content: string;
  contentType: string;
  totalSize: number;
  hasMore: boolean;
  nextOffset: number;
  readLoading: boolean;
  readError: string | null;
  /** The path whose content is currently loaded. `null` until a read lands. */
  loadedPath: string | null;
}

function createState(loading: boolean): MemoryState {
  return {
    response: null,
    files: [],
    loading,
    error: null,
    selectedPath: null,
    content: '',
    contentType: '',
    totalSize: 0,
    hasMore: false,
    nextOffset: 0,
    readLoading: false,
    readError: null,
    loadedPath: null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to read Claude Code memory';
}

/** The mutable facts one Session's memory screen is guarded by. */
interface MemoryRuntime {
  agentId: string;
  sessionId: string;
  context: MutableRefObject<string | null>;
  generation: MutableRefObject<number>;
  readGeneration: MutableRefObject<number>;
  readId: MutableRefObject<number>;
  /** The memory directory the loaded content belongs to. */
  directory: MutableRefObject<string | null>;
  /** `<directory>:<path>` whose automatic read already ran. */
  attempted: MutableRefObject<string | null>;
  setMemory: Dispatch<SetStateAction<MemoryState>>;
}

async function loadSnapshot(runtime: MemoryRuntime, key: string, id: number) {
  const { setMemory } = runtime;
  setMemory((current) => ({ ...current, loading: true, error: null }));
  try {
    const response = await claudeCodeApi.claudeCodeMemory({
      agent_id: runtime.agentId,
      session_id: runtime.sessionId,
    });
    if (runtime.context.current !== key || runtime.generation.current !== id) {
      return;
    }

    const nextDirectory = response.memory_directory ?? null;
    const directoryChanged = runtime.directory.current !== nextDirectory;
    if (directoryChanged) {
      runtime.directory.current = nextDirectory;
      runtime.readGeneration.current += 1;
      runtime.readId.current += 1;
      runtime.attempted.current = null;
    }

    setMemory((current) => {
      const keepSelection =
        !directoryChanged &&
        current.selectedPath !== null &&
        response.files.some((file) => file.path === current.selectedPath);

      if (keepSelection) {
        return {
          ...current,
          response,
          files: response.files,
          loading: false,
          error: null,
        };
      }

      const selectedPath =
        response.files.find((file) => file.path === MEMORY_INDEX)?.path ??
        response.files[0]?.path ??
        null;
      return {
        ...current,
        response,
        files: response.files,
        loading: false,
        error: null,
        selectedPath,
        content: '',
        contentType: '',
        totalSize: 0,
        hasMore: false,
        nextOffset: 0,
        readLoading: false,
        readError: null,
        loadedPath: null,
      };
    });
  } catch (error) {
    if (runtime.context.current !== key || runtime.generation.current !== id) {
      return;
    }
    setMemory((current) => ({
      ...current,
      loading: false,
      error: message(error),
    }));
  }
}

async function loadFile(
  runtime: MemoryRuntime,
  path: string,
  offset: number,
  append: boolean,
): Promise<'applied' | 'stale' | 'dropped'> {
  const key = runtime.context.current;
  const directory = runtime.directory.current;
  if (!key || !directory) {
    return 'dropped';
  }
  const id = ++runtime.readId.current;
  const generation = runtime.readGeneration.current;
  const { setMemory } = runtime;

  setMemory((current) => ({
    ...current,
    selectedPath: path,
    readLoading: true,
    readError: null,
    ...(append
      ? {}
      : {
          content: '',
          contentType: '',
          totalSize: 0,
          hasMore: false,
          nextOffset: 0,
          loadedPath: null,
        }),
  }));

  try {
    const response = await claudeCodeApi.claudeCodeMemoryRead({
      agent_id: runtime.agentId,
      session_id: runtime.sessionId,
      // The snapshot this page belongs to. The provider compares it with the
      // directory it re-resolves and refuses a mismatch, so a Session that
      // moved repository cannot return the new file under the old list.
      memory_directory: directory,
      path,
      offset,
    });
    if (
      runtime.context.current !== key ||
      generation !== runtime.readGeneration.current ||
      runtime.readId.current !== id ||
      directory !== runtime.directory.current
    ) {
      return 'dropped';
    }

    if ('error' in response) {
      if (response.error === 'stale_memory') {
        // Settle the read before the refresh: the new snapshot normally resets
        // it, but a Session that moved and moved back would otherwise stay on
        // the loading indicator.
        setMemory((current) => ({ ...current, readLoading: false }));
        return 'stale';
      }
      setMemory((current) => ({
        ...current,
        readLoading: false,
        readError: response.error,
      }));
      return 'applied';
    }

    setMemory((current) => ({
      ...current,
      content: append ? current.content + response.content : response.content,
      contentType: append ? current.contentType : response.content_type,
      totalSize: append ? current.totalSize : response.total_size,
      hasMore: response.has_more,
      nextOffset: response.offset + new TextEncoder().encode(response.content).length,
      readLoading: false,
      readError: null,
      loadedPath: path,
    }));
    return 'applied';
  } catch (error) {
    if (
      runtime.context.current !== key ||
      generation !== runtime.readGeneration.current ||
      runtime.readId.current !== id
    ) {
      return 'dropped';
    }
    setMemory((current) => ({
      ...current,
      readLoading: false,
      readError: message(error),
    }));
    return 'applied';
  }
}

/**
 * Auto Memory for the current Session's repository (#2689).
 *
 * ## Why the request names only a Session
 *
 * There is no repository argument, by design. The provider derives the
 * repository from the Session's authoritative cwd, so a client cannot ask for
 * another project's memory even by trying; this hook's only lever is *which*
 * Session is current.
 *
 * ## Staleness
 *
 * Three identifiers guard every answer:
 *
 * - `contextKey` — a different Session is a different screen; old snapshots and
 *   reads are dropped.
 * - `generation` — a newer snapshot request wins over an older one.
 * - `readGeneration` — a snapshot that reports a **different memory directory**
 *   (the Session moved to another repository, or its Claude configuration
 *   changed) invalidates every in-flight read, so a page from the old
 *   repository cannot land under the new one.
 *
 * The view is only loaded while `active`. Entering the Memory tab re-reads the
 * snapshot, which is also how a repository change made while the tab was not
 * looking is discovered before any file is shown.
 */
export function useMemory({
  agentId,
  sessionId,
  active,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  active: boolean;
}) {
  const [memory, setMemory] = useState<MemoryState>(() => createState(false));
  const contextKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;

  const context = useRef<string | null>(contextKey);
  const generation = useRef(0);
  const readGeneration = useRef(0);
  const readId = useRef(0);
  const directory = useRef<string | null>(null);
  const attempted = useRef<string | null>(null);

  const runtime = useRef<MemoryRuntime | null>(null);
  runtime.current = contextKey
    ? {
        agentId: agentId as string,
        sessionId: sessionId as string,
        context,
        generation,
        readGeneration,
        readId,
        directory,
        attempted,
        setMemory,
      }
    : null;

  const fetchSnapshot = useCallback((key: string, id: number) => {
    const current = runtime.current;
    if (current) {
      return loadSnapshot(current, key, id);
    }
    return Promise.resolve();
  }, []);

  const readFile = useCallback(
    async (path: string, offset = 0, append = false) => {
      const current = runtime.current;
      if (!current) {
        return;
      }
      const outcome = await loadFile(current, path, offset, append);
      if (outcome !== 'stale') {
        return;
      }
      // The provider refused because the Session moved repository (or its
      // effective Claude configuration changed) after this snapshot. Re-list;
      // the new snapshot invalidates this page and the selected file is opened
      // from the new directory.
      const key = context.current;
      if (key) {
        void fetchSnapshot(key, ++generation.current);
      }
    },
    [fetchSnapshot],
  );

  // A Session change, or entering/leaving the view, is a fresh screen. The
  // snapshot is fetched only while active: the memory of a repository the user
  // is not looking at costs nothing.
  useEffect(() => {
    context.current = contextKey;
    generation.current += 1;
    readGeneration.current += 1;
    readId.current += 1;
    directory.current = null;
    attempted.current = null;
    setMemory(createState(Boolean(contextKey) && active));
    if (!contextKey || !active) {
      return;
    }
    void fetchSnapshot(contextKey, generation.current);
  }, [contextKey, active, fetchSnapshot]);

  // Open the selected file the first time a snapshot names it. The guard is per
  // `(directory, path)`: a failed automatic read must not retry on every state
  // update, while a directory change resets it so the new index is opened. The
  // directory is a dependency as well as a ref because a snapshot that moves
  // repository keeps the same `selectedPath` (`MEMORY.md`); without it React
  // would see every dependency unchanged and never open the new file.
  useEffect(() => {
    if (!active) {
      return;
    }
    const path = memory.selectedPath;
    if (!path || memory.loadedPath === path || memory.readLoading) {
      return;
    }
    const marker = `${directory.current ?? ''}:${path}`;
    if (attempted.current === marker) {
      return;
    }
    attempted.current = marker;
    void readFile(path);
  }, [
    active,
    memory.selectedPath,
    memory.loadedPath,
    memory.readLoading,
    memory.response?.memory_directory,
    readFile,
  ]);

  /** Re-read the snapshot — the Retry action for a failure or a moved session. */
  const retry = useCallback(() => {
    const key = context.current;
    if (!key) {
      return;
    }
    attempted.current = null;
    void fetchSnapshot(key, ++generation.current);
  }, [fetchSnapshot]);

  /** Read the next chunk of the selected file. */
  const loadMore = useCallback(() => {
    if (!memory.selectedPath || !memory.hasMore || memory.readLoading) {
      return;
    }
    void readFile(memory.selectedPath, memory.nextOffset, true);
  }, [memory.hasMore, memory.nextOffset, memory.readLoading, memory.selectedPath, readFile]);

  return {
    memory,
    openFile: readFile,
    loadMore,
    retry,
  };
}
