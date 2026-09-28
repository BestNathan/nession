import { useCallback, useState } from 'react';
import type { EnvFileInfo } from '@/types';
import { refKey } from '@/capabilities/env/model/envRef';

/** What the Edit depth is editing. */
export type EditorTarget =
  | { kind: 'existing' }
  | { kind: 'new' }
  | { kind: 'duplicate'; source: EnvFileInfo };

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
   */
  finishEdit: (selectKey?: string) => void;
  setDirty: (dirty: boolean) => void;
  /**
   * The App's Back policy (#1051): a dirty edit confirms through the guard, a
   * clean edit returns to the same Profile Detail, and reading pops to the
   * list. The capability owns the guard; the shell owns the Back control.
   */
  leaveDepth: () => void;
  confirmGuard: () => void;
  cancelGuard: () => void;
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
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);

  const openEditor = useCallback((target: EditorTarget | null) => {
    setEditor(target);
    setDirty(false);
  }, []);

  const guarded = useCallback(
    (action: () => void) => {
      if (dirty) {
        setPending(() => action);
      } else {
        action();
      }
    },
    [dirty],
  );

  const confirmGuard = useCallback(() => {
    const action = pending;
    setPending(null);
    setDirty(false);
    action?.();
  }, [pending]);

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

  const finishEdit = useCallback((selectKey?: string) => {
    setEditor(null);
    setDirty(false);
    if (selectKey !== undefined) {
      setSelectedKey(selectKey);
    }
  }, []);

  const leaveDepth = useCallback(() => {
    if (!editor) {
      setSelectedKey(null);
      return;
    }
    guarded(() => {
      openEditor(null);
    });
  }, [editor, guarded, openEditor]);

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
  };
}
