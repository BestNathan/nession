import { useCallback, useReducer, useRef, type Dispatch, type MutableRefObject } from 'react';
import type { EnvFileInfo, EnvFileRef } from '@/types';
import { refKey } from '@/capabilities/env/model/envRef';

/** What the Edit depth is editing. */
export type EditorTarget =
  | { kind: 'existing' }
  | { kind: 'new' }
  | { kind: 'duplicate'; source: EnvFileInfo };

/**
 * Where the Environment capability is:
 *
 * - `root` — Web's default Session overview (when a Session exists) or the
 *   profile-first list; App's list with the compact Session summary;
 * - `session` — the pushed Session Environment view (App), and the target of
 *   Web's "Current Session" link;
 * - `profile` — the read-first Profile Detail;
 * - `draft` — the ordered binding draft.
 *
 * The Edit depth is an overlay on `profile` / `root` and is tracked by
 * `editor`, not a view of its own.
 */
export type EnvironmentView = 'root' | 'session' | 'profile' | 'draft';

/**
 * Remount key for the Edit depth: one target, one draft. Both experiences key
 * the editor by this so switching targets can never inherit a stale draft.
 */
export function editorTargetKey(editor: EditorTarget, selectedKey: string | null): string {
  if (editor.kind === 'duplicate') {
    return `duplicate:${refKey(editor.source)}`;
  }
  if (editor.kind === 'new') {
    return 'new';
  }
  return `existing:${selectedKey ?? ''}`;
}

function sameRefs(a: EnvFileRef[], b: EnvFileRef[]): boolean {
  return a.length === b.length && a.every((ref, i) => refKey(ref) === refKey(b[i]));
}

interface ScreenState {
  view: EnvironmentView;
  selectedKey: string | null;
  editor: EditorTarget | null;
  draft: EnvFileRef[] | null;
  draftBaseline: EnvFileRef[] | null;
  dirty: boolean;
  pending: (() => void) | null;
}

type Action =
  | { type: 'navigate'; view: 'root' | 'profile' | 'session'; key?: string | null }
  | { type: 'start-draft'; refs: EnvFileRef[] }
  | { type: 'set-draft'; refs: EnvFileRef[]; dirty: boolean }
  | { type: 'close-draft' }
  | { type: 'open-editor'; target: EditorTarget; clearSelection?: boolean }
  | { type: 'close-editor' }
  | { type: 'finish-edit'; key?: string | null }
  | { type: 'set-dirty'; value: boolean }
  | { type: 'set-view'; view: EnvironmentView }
  | { type: 'guard'; action: () => void }
  | { type: 'close-guard'; confirm: boolean }
  | { type: 'reset' };

const INITIAL: ScreenState = {
  view: 'root',
  selectedKey: null,
  editor: null,
  draft: null,
  draftBaseline: null,
  dirty: false,
  pending: null,
};

function afterEdit(
  state: ScreenState,
  action: Extract<Action, { type: 'finish-edit' }>,
): ScreenState {
  const changed = 'key' in action;
  const selectedKey = changed ? (action.key ?? null) : state.selectedKey;
  return {
    ...state,
    editor: null,
    dirty: false,
    selectedKey,
    view: changed ? (selectedKey === null ? 'root' : 'profile') : state.view,
  };
}

function reducer(state: ScreenState, action: Action): ScreenState {
  switch (action.type) {
    case 'navigate':
      return {
        ...state,
        view: action.view,
        selectedKey: action.key ?? null,
        editor: null,
        draft: null,
        draftBaseline: null,
        dirty: false,
      };
    case 'start-draft':
      return {
        ...state,
        view: 'draft',
        selectedKey: null,
        editor: null,
        draft: action.refs,
        draftBaseline: action.refs,
        dirty: false,
      };
    case 'set-draft':
      return { ...state, draft: action.refs, dirty: action.dirty };
    case 'close-draft':
      return {
        ...state,
        view: 'session',
        draft: null,
        draftBaseline: null,
        dirty: false,
      };
    case 'open-editor':
      return {
        ...state,
        view: action.clearSelection ? 'root' : state.view,
        selectedKey: action.clearSelection ? null : state.selectedKey,
        editor: action.target,
        dirty: false,
      };
    case 'close-editor':
      return { ...state, editor: null, dirty: false };
    case 'finish-edit':
      return afterEdit(state, action);
    case 'set-dirty':
      return { ...state, dirty: action.value };
    case 'set-view':
      return { ...state, view: action.view };
    case 'guard':
      return { ...state, pending: action.action };
    case 'close-guard':
      return { ...state, pending: null, dirty: action.confirm ? false : state.dirty };
    case 'reset':
      return INITIAL;
    default:
      return state;
  }
}

function useEditorActions(
  dispatch: Dispatch<Action>,
  guarded: (action: () => void) => void,
  dirtyRef: MutableRefObject<boolean>,
) {
  const startEdit = useCallback(() => {
    guarded(() => {
      dirtyRef.current = false;
      dispatch({ type: 'open-editor', target: { kind: 'existing' } });
    });
  }, [dispatch, guarded, dirtyRef]);

  const startNew = useCallback(() => {
    guarded(() => {
      dirtyRef.current = false;
      dispatch({
        type: 'open-editor',
        target: { kind: 'new' },
        clearSelection: true,
      });
    });
  }, [dispatch, guarded, dirtyRef]);

  const startDuplicate = useCallback(
    (source: EnvFileInfo) => {
      guarded(() => {
        dirtyRef.current = false;
        dispatch({ type: 'open-editor', target: { kind: 'duplicate', source } });
      });
    },
    [dispatch, guarded, dirtyRef],
  );

  const cancelEdit = useCallback(() => {
    guarded(() => {
      dirtyRef.current = false;
      dispatch({ type: 'close-editor' });
    });
  }, [dispatch, guarded, dirtyRef]);

  const finishEdit = useCallback(
    (selectKey?: string | null) => {
      dirtyRef.current = false;
      dispatch(
        selectKey === undefined
          ? { type: 'finish-edit' }
          : { type: 'finish-edit', key: selectKey },
      );
    },
    [dispatch, dirtyRef],
  );

  return { startEdit, startNew, startDuplicate, cancelEdit, finishEdit };
}

function useDraftActions(
  dispatch: Dispatch<Action>,
  guarded: (action: () => void) => void,
  dirtyRef: MutableRefObject<boolean>,
  draftBaseline: EnvFileRef[] | null,
) {
  const startBindingDraft = useCallback(
    (refs: EnvFileRef[]) => {
      guarded(() => {
        dirtyRef.current = false;
        dispatch({ type: 'start-draft', refs });
      });
    },
    [dispatch, guarded, dirtyRef],
  );

  const setDraftRefs = useCallback(
    (refs: EnvFileRef[]) => {
      const dirty = !sameRefs(refs, draftBaseline ?? []);
      dirtyRef.current = dirty;
      dispatch({ type: 'set-draft', refs, dirty });
    },
    [dispatch, dirtyRef, draftBaseline],
  );

  const cancelBindingDraft = useCallback(() => {
    dirtyRef.current = false;
    dispatch({ type: 'close-draft' });
  }, [dispatch, dirtyRef]);

  const finishBindingDraft = useCallback(() => {
    dirtyRef.current = false;
    dispatch({ type: 'close-draft' });
  }, [dispatch, dirtyRef]);

  return { startBindingDraft, setDraftRefs, cancelBindingDraft, finishBindingDraft };
}

export interface EnvironmentScreen {
  view: EnvironmentView;
  selectedKey: string | null;
  editor: EditorTarget | null;
  draft: EnvFileRef[] | null;
  draftBaseline: EnvFileRef[] | null;
  dirty: boolean;
  guardOpen: boolean;
  selectProfile: (profile: EnvFileInfo | null) => void;
  showSession: () => void;
  startBindingDraft: (refs: EnvFileRef[]) => void;
  setDraftRefs: (refs: EnvFileRef[]) => void;
  cancelBindingDraft: () => void;
  finishBindingDraft: () => void;
  startEdit: () => void;
  startNew: () => void;
  startDuplicate: (source: EnvFileInfo) => void;
  cancelEdit: () => void;
  finishEdit: (selectKey?: string | null) => void;
  setDirty: (dirty: boolean) => void;
  leaveDepth: () => void;
  confirmGuard: () => void;
  cancelGuard: () => void;
  reset: () => void;
}

/**
 * The Environment screen state machine (#1202, extended by #2654).
 *
 * One dirty flag covers the profile editor and the binding draft, so every
 * navigation that would abandon either confirms first. Transitions live in a
 * pure reducer; the dirty ref is the synchronous guard input.
 */
export function useEnvironmentScreen(): EnvironmentScreen {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const dirtyRef = useRef(false);

  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
    dispatch({ type: 'set-dirty', value: dirty });
  }, []);

  const guarded = useCallback((action: () => void) => {
    if (dirtyRef.current) {
      dispatch({ type: 'guard', action });
    } else {
      action();
    }
  }, []);

  const confirmGuard = useCallback(() => {
    const action = state.pending;
    dirtyRef.current = false;
    dispatch({ type: 'close-guard', confirm: true });
    action?.();
  }, [state.pending]);

  const cancelGuard = useCallback(() => {
    dispatch({ type: 'close-guard', confirm: false });
  }, []);

  const selectProfile = useCallback(
    (profile: EnvFileInfo | null) => {
      guarded(() =>
        dispatch({
          type: 'navigate',
          view: profile === null ? 'root' : 'profile',
          key: profile === null ? null : refKey(profile),
        }),
      );
    },
    [guarded],
  );

  const showSession = useCallback(() => {
    guarded(() => dispatch({ type: 'navigate', view: 'session' }));
  }, [guarded]);

  const editorActions = useEditorActions(dispatch, guarded, dirtyRef);
  const draftActions = useDraftActions(dispatch, guarded, dirtyRef, state.draftBaseline);

  const leaveDepth = useCallback(() => {
    if (state.editor) {
      guarded(() => {
        dirtyRef.current = false;
        dispatch({ type: 'close-editor' });
      });
      return;
    }
    if (state.view === 'draft') {
      guarded(() => {
        dirtyRef.current = false;
        dispatch({ type: 'close-draft' });
      });
      return;
    }
    if (state.view === 'profile') {
      guarded(() => dispatch({ type: 'navigate', view: 'root' }));
      return;
    }
    if (state.view === 'session') {
      dispatch({ type: 'set-view', view: 'root' });
    }
  }, [state.editor, state.view, guarded]);

  const reset = useCallback(() => {
    dirtyRef.current = false;
    dispatch({ type: 'reset' });
  }, []);

  return {
    view: state.view,
    selectedKey: state.selectedKey,
    editor: state.editor,
    draft: state.draft,
    draftBaseline: state.draftBaseline,
    dirty: state.dirty,
    guardOpen: state.pending !== null,
    selectProfile,
    showSession,
    setDirty,
    leaveDepth,
    confirmGuard,
    cancelGuard,
    reset,
    ...editorActions,
    ...draftActions,
  };
}
