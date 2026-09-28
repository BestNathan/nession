import { useCallback, useRef, useState } from 'react';
import type { EnvFileInfo } from '@/types';
import { refKey } from '@/capabilities/env/model/envRef';

/** What the Edit depth is editing. */
export type EditorTarget =
  | { kind: 'existing' }
  | { kind: 'new' }
  | { kind: 'duplicate'; source: EnvFileInfo };

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

export interface EnvironmentScreen {
  /** `refKey` of the selected profile; null shows the empty detail (Web) / the list (App). */
  selectedKey: string | null;
  /** Non-null while the Edit depth is open. */
  editor: EditorTarget | null;
  dirty: boolean;
  /** A guarded action is waiting on the discard confirmation. */
  guardOpen: boolean;
  /** Select a profile (or clear with null); a dirty edit guards the switch. */
  selectProfile: (profile: EnvFileInfo | null) => void;
  startEdit: () => void;
  startNew: () => void;
  startDuplicate: (source: EnvFileInfo) => void;
  /** Cancel out of Edit back to the same Profile Detail; dirty guards it. */
  cancelEdit: () => void;
  /**
   * After a successful save or import: close Edit, clear dirty, and select the
   * saved profile unguarded — saving is what made the state safe to leave.
   * Passing `null` explicitly clears the selection (the deleted profile's
   * detail must not linger); omitting the argument keeps it.
   */
  finishEdit: (selectKey?: string | null) => void;
  setDirty: (dirty: boolean) => void;
  /**
   * The App's Back policy (#1051): a dirty edit confirms through the guard, a
   * clean edit returns to the same Profile Detail, and reading pops to the
   * list. The capability owns the guard; the shell owns the Back control.
   */
  leaveDepth: () => void;
  confirmGuard: () => void;
  cancelGuard: () => void;
  /**
   * Unconditional reset for a Session switch: the old Session's selection and
   * any edit in flight belong to that Session and must not reappear (#1202).
   */
  reset: () => void;
}

/**
 * The Environment screen state machine (#1202), shared by both experiences so
 * the dirty-leave policy has exactly one implementation: any navigation that
 * would abandon a dirty edit — another profile, New, Cancel, the App's Back —
 * confirms first. The guard is state, not a browser `window.confirm`.
 */
export function useEnvironmentScreen(): EnvironmentScreen {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);

  /**
   * The guard decision reads a ref, not a render closure: the editor reports
   * dirty from a passive effect, so a `leaveDepth` captured one render ago —
   * the one the shell is still holding between the dirty commit and the
   * effect that re-publishes the pushed entry — would otherwise observe a
   * stale `false` and pop a dirty edit without confirming. Every writer goes
   * through `setDirty`, which updates the ref synchronously.
   */
  const dirtyRef = useRef(false);
  const setDirty = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirtyState(next);
  }, []);

  const openEditor = useCallback(
    (target: EditorTarget | null) => {
      setEditor(target);
      setDirty(false);
    },
    [setDirty],
  );

  const guarded = useCallback((action: () => void) => {
    if (dirtyRef.current) {
      setPending(() => action);
    } else {
      action();
    }
  }, []);

  const confirmGuard = useCallback(() => {
    const action = pending;
    setPending(null);
    setDirty(false);
    action?.();
  }, [pending, setDirty]);

  const cancelGuard = useCallback(() => {
    setPending(null);
  }, []);

  const selectProfile = useCallback(
    (profile: EnvFileInfo | null) => {
      guarded(() => {
        setSelectedKey(profile === null ? null : refKey(profile));
        setEditor(null);
      });
    },
    [guarded],
  );

  const startEdit = useCallback(() => {
    openEditor({ kind: 'existing' });
  }, [openEditor]);

  const startNew = useCallback(() => {
    guarded(() => {
      setSelectedKey(null);
      openEditor({ kind: 'new' });
    });
  }, [guarded, openEditor]);

  const startDuplicate = useCallback(
    (source: EnvFileInfo) => {
      guarded(() => {
        openEditor({ kind: 'duplicate', source });
      });
    },
    [guarded, openEditor],
  );

  const cancelEdit = useCallback(() => {
    guarded(() => {
      openEditor(null);
    });
  }, [guarded, openEditor]);

  const finishEdit = useCallback(
    (selectKey?: string | null) => {
      setEditor(null);
      setDirty(false);
      if (selectKey !== undefined) {
        setSelectedKey(selectKey);
      }
    },
    [setDirty],
  );

  const leaveDepth = useCallback(() => {
    if (!editor) {
      setSelectedKey(null);
      return;
    }
    guarded(() => {
      openEditor(null);
    });
  }, [editor, guarded, openEditor]);

  const reset = useCallback(() => {
    setSelectedKey(null);
    setEditor(null);
    setDirty(false);
    setPending(null);
  }, [setDirty]);

  return {
    selectedKey,
    editor,
    dirty,
    guardOpen: pending !== null,
    selectProfile,
    startEdit,
    startNew,
    startDuplicate,
    cancelEdit,
    finishEdit,
    setDirty,
    leaveDepth,
    confirmGuard,
    cancelGuard,
    reset,
  };
}
