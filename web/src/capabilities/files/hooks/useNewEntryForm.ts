import { useCallback, useMemo, useState } from 'react';
import {
  joinPath,
  validateEntryName,
  type CreateKind,
} from '../model/createTarget';

export interface NewEntryTarget {
  kind: CreateKind;
  /** Captured when the form opens; later selection changes cannot redirect it. */
  parentPath: string;
}

/**
 * Group new file/folder form state.
 *
 * The target is part of the form, not re-derived at submit time: opening
 * "New file" captures the destination the user is looking at, and a later
 * selection or browse change cannot redirect the create. The name is validated
 * against a single path segment before submit.
 */
export function useNewEntryForm() {
  const [target, setTarget] = useState<NewEntryTarget | null>(null);
  const [newName, setNewName] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const open = useCallback((kind: CreateKind, parentPath: string) => {
    setTarget({ kind, parentPath });
    setNewName('');
    setSubmitError(null);
  }, []);

  const reset = useCallback(() => {
    setTarget(null);
    setNewName('');
    setSubmitError(null);
  }, []);

  const changeName = useCallback((value: string) => {
    setNewName(value);
    setSubmitError(null);
  }, []);

  const validationError = useMemo(
    () => (target ? validateEntryName(newName) : null),
    [newName, target],
  );

  const destinationPath = useMemo(() => {
    if (!target) {
      return '';
    }
    return joinPath(target.parentPath, newName.trim());
  }, [newName, target]);

  return {
    target,
    kind: target?.kind ?? null,
    parentPath: target?.parentPath ?? '',
    destinationPath,
    validationError,
    submitError,
    setSubmitError,
    canSubmit: target !== null && validationError === null,
    showNewFile: target?.kind === 'file',
    showNewFolder: target?.kind === 'folder',
    newName,
    setNewName,
    changeName,
    open,
    reset,
  };
}
