import { useCallback, useEffect, useRef, useState } from 'react';
import { gitApi } from '../GitPlugin';
import type { GitRow } from '../state';
import type { GitDiffResponse, GitPreviewResponse } from '../types';
import { mediaHintForPath } from '@/shared/file-viewer';
import { base64ToBlobUrl } from '@/shared/lib/blob';

export type GitPreviewKind = 'untracked' | 'unmerged';
/** Caller-owned Blob URL for the selected Git preview. Revoked on replacement. */
export interface GitMediaView {
  url: string;
  mimeType: string;
}

export interface GitSelectionState {
  selectedKey: string | null;
  selectedPath: string | null;
  mode: 'diff' | 'preview' | null;
  previewKind: GitPreviewKind | null;
  diff: GitDiffResponse | null;
  preview: GitPreviewResponse | null;
  media: GitMediaView | null;
  loading: boolean;
  error: string | null;
}

const NO_SELECTION: GitSelectionState = {
  selectedKey: null,
  selectedPath: null,
  mode: null,
  previewKind: null,
  diff: null,
  preview: null,
  media: null,
  loading: false,
  error: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not reach the agent';
}

function isDiffRow(row: GitRow): row is Extract<GitRow, { kind: 'staged' | 'unstaged' }> {
  return row.kind === 'staged' || row.kind === 'unstaged';
}

/** Create the preview URL away from the Session hook's request/state owner. */
function materializeMedia(
  response: GitPreviewResponse,
  isCurrent: () => boolean,
): GitMediaView | null {
  const payload =
    response.state === 'ok' && response.preview.state === 'ready'
      ? response.preview.media
      : null;
  if (!payload) {
    return null;
  }
  const url = base64ToBlobUrl(payload.content_base64, payload.mime_type);
  if (!isCurrent()) {
    URL.revokeObjectURL(url);
    return null;
  }
  return { url, mimeType: payload.mime_type };
}

/**
 * One request per opened Git row, with the row kind choosing the operation.
 *
 * A staged row asks for `HEAD → INDEX`; an unstaged row asks for
 * `INDEX → WORKTREE`. Those are separate reviewed states, so the row — not a
 * flag inferred from one combined patch — selects the diff source (#845
 * SC-01). An untracked or unmerged row asks for the worktree preview read,
 * carrying the row kind it was selected from.
 *
 * Responses are dropped when the Session moved on or the selection changed;
 * the Agent independently rechecks the row's status before and after reading.
 * Selection is by row key, because one path can be both staged and unstaged.
 */
export function useGitSelection({
  agentId,
  sessionId,
  handedOver,
  rows,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  handedOver: string | null;
  rows: readonly GitRow[] | null;
}) {
  const [state, setState] = useState<GitSelectionState>(NO_SELECTION);
  const generation = useRef(0);
  const selectionToken = useRef(0);
  const mediaUrlRef = useRef<string | null>(null);
  const clearMediaUrl = useCallback(() => {
    if (mediaUrlRef.current) {
      URL.revokeObjectURL(mediaUrlRef.current);
      mediaUrlRef.current = null;
    }
  }, []);
  useEffect(() => () => clearMediaUrl(), [clearMediaUrl]);
  const target = useRef<{ agent_id: string; session: string } | null>(null);
  const lastHandoff = useRef<string | null>(null);

  const selectRow = useCallback(async (row: GitRow) => {
    const current = target.current;
    if (!current) {
      return;
    }
    const forGeneration = generation.current;
    const token = ++selectionToken.current;
    const mode = isDiffRow(row) ? 'diff' : 'preview';
    const previewKind = isDiffRow(row) ? null : row.kind;
    const wantsMedia = !isDiffRow(row) && mediaHintForPath(row.path) !== null;
    const isCurrent = () =>
      generation.current === forGeneration && selectionToken.current === token;

    clearMediaUrl();
    setState({
      selectedKey: row.key,
      selectedPath: row.path,
      mode,
      previewKind,
      diff: null,
      preview: null,
      media: null,
      loading: true,
      error: null,
    });

    try {
      if (isDiffRow(row)) {
        const response = await gitApi.gitDiff({
          ...current,
          path: row.path,
          source: { kind: row.kind },
        });
        if (!isCurrent()) {
          return;
        }
        setState((previous) =>
          previous.selectedKey === row.key && previous.mode === 'diff'
            ? { ...previous, diff: response, loading: false, error: null }
            : previous,
        );
      } else {
        const response = await gitApi.gitPreview({
          ...current,
          path: row.path,
          expected: row.kind,
          want: wantsMedia ? 'media' : 'text',
        });
        if (!isCurrent()) {
          return;
        }
        const media = materializeMedia(response, isCurrent);
        if (media) {
          mediaUrlRef.current = media.url;
        }
        setState((previous) =>
          previous.selectedKey === row.key && previous.mode === 'preview'
            ? { ...previous, preview: response, media, loading: false, error: null }
            : previous,
        );
      }
    } catch (failure) {
      if (!isCurrent()) {
        return;
      }
      setState((previous) =>
        previous.selectedKey === row.key && previous.mode === mode
          ? { ...previous, loading: false, error: message(failure) }
          : previous,
      );
    }
  }, [clearMediaUrl]);

  useEffect(() => {
    generation.current += 1;
    selectionToken.current += 1;
    clearMediaUrl();
    target.current = agentId && sessionId ? { agent_id: agentId, session: sessionId } : null;
    lastHandoff.current = null;
    setState(NO_SELECTION);
  }, [agentId, sessionId, clearMediaUrl]);

  // The Terminal Peek hands over a path, not a response. Wait until the status
  // listing can tell which kind of row that path is, then ask the matching
  // operation. An unknown path stays unselected rather than guessing a diff.
  // A path that is both staged and unstaged opens the worktree side: that is
  // the half a person acting from the Peek is about to stage.
  useEffect(() => {
    if (!target.current || !handedOver || !rows || lastHandoff.current === handedOver) {
      return;
    }
    const matching = rows.filter((candidate) => candidate.path === handedOver);
    const row =
      matching.find((candidate) => candidate.kind === 'unstaged') ?? matching[0];
    if (!row) {
      return;
    }
    lastHandoff.current = handedOver;
    void selectRow(row);
  }, [handedOver, rows, selectRow]);

  return { state, selectRow };
}
