import { useCallback, useEffect, useState } from 'react';

/**
 * A History selection is scoped to the Git target and the list it was made in.
 *
 * The selected OID is a question about one repository: carrying it across a
 * Session switch asks the successor's agent to resolve a commit that cannot
 * exist there, and a first page that no longer lists the row leaves a detail
 * pane attached to nothing (#3767). The target key is therefore part of the
 * selection rather than a fact kept beside it.
 */
interface GitHistorySelection {
  targetKey: string;
  oid: string;
  file: string | null;
}

export interface GitHistorySelectionState {
  selected: string | null;
  selectedFile: string | null;
  onSelectCommit: (hash: string) => void;
  onSelectFile: (path: string) => void;
}

/**
 * The selected commit and changed file of a History list.
 *
 * A selection is renderable only while both its target and its row are still
 * here. Deriving that — rather than clearing it in an effect — means the first
 * render after a Session switch already has no selection, so no `git.commit`
 * or `git.diff` is addressed to the successor with the predecessor's OID. It
 * also makes the selected row the only row whose detail can be shown when a
 * refreshed first page drops it.
 *
 * The stored selection must not outlive what makes it valid: otherwise a
 * switch away and back would resurrect it, and a commit dropped by a refresh
 * would reappear if a later answer brought the OID back.
 */
export function useGitHistorySelection({
  targetKey,
  commits,
}: {
  targetKey: string | null;
  commits: readonly { hash: string }[];
}): GitHistorySelectionState {
  const [selection, setSelection] = useState<GitHistorySelection | null>(null);

  const selectionForTarget =
    selection && selection.targetKey === targetKey ? selection : null;
  const selected =
    selectionForTarget &&
    commits.some((commit) => commit.hash === selectionForTarget.oid)
      ? selectionForTarget.oid
      : null;
  const selectedFile = selected && selectionForTarget ? selectionForTarget.file : null;

  useEffect(() => {
    if (!selection) {
      return;
    }
    const stillSelectable =
      selection.targetKey === targetKey &&
      commits.some((commit) => commit.hash === selection.oid);
    if (!stillSelectable) {
      setSelection(null);
    }
  }, [selection, targetKey, commits]);

  const onSelectCommit = useCallback(
    (hash: string) => {
      if (!targetKey) {
        return;
      }
      setSelection({ targetKey, oid: hash, file: null });
    },
    [targetKey],
  );

  const onSelectFile = useCallback(
    (path: string) => {
      setSelection((current) =>
        current && current.targetKey === targetKey
          ? { ...current, file: path }
          : current,
      );
    },
    [targetKey],
  );

  return { selected, selectedFile, onSelectCommit, onSelectFile };
}
