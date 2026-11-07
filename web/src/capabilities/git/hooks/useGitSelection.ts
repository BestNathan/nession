import { useCallback, useEffect, useRef, useState } from 'react';
import { gitApi } from '../GitPlugin';
import type { GitRow } from '../state';
import type { GitDiffResponse, GitPreviewResponse } from '../types';
import { mediaHintForPath } from '@/shared/file-viewer';
import { base64ToBlobUrl } from '@/shared/lib/blob';

export type GitPreviewKind = 'untracked' | 'unmerged';

/** A caller-owned media URL for the selected Git row. */
export interface GitMediaView {
  url: string;
  mimeType: string;
}

export interface GitSelectionState {
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

/**
 * One request per opened Git row, with the row kind choosing the operation.
 *
 * A tracked row asks for its bounded diff. An untracked or unmerged row asks
 * for the worktree preview read, carrying the row kind it was selected from;
 * a media extension asks the same operation for complete bounded bytes.
 * Responses are dropped when the Session moved on or the selection changed;
 * the Agent independently rechecks the row's status before and after reading.
 *
 * The Blob URL for a media answer belongs to this hook: a stale response, a
 * new selection, a Session change and unmount all revoke it (#2876 SC-04).
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
  const target = useRef<{ agent_id: string; session: string } | null>(null);
  const lastHandoff = useRef<string | null>(null);
  const mediaUrlRef = useRef<string | null>(null);

  const clearMediaUrl = useCallback(() => {
    if (mediaUrlRef.current) {
      URL.revokeObjectURL(mediaUrlRef.current);
      mediaUrlRef.current = null;
    }
  }, []);

  useEffect(() => () => clearMediaUrl(), [clearMediaUrl]);

  const selectRow = useCallback(async (row: GitRow) => {
    const current = target.current;
    if (!current) {
      return;
    }
    const forGeneration = generation.current;
    const token = ++selectionToken.current;
    const mode = row.kind === 'tracked' ? 'diff' : 'preview';
    const previewKind = row.kind === 'tracked' ? null : row.kind;
    const wantsMedia = row.kind !== 'tracked' && mediaHintForPath(row.path) !== null;

    clearMediaUrl();
    setState({
      selectedPath: row.path,
      mode,
      previewKind,
      diff: null,
      preview: null,
      media: null,
      loading: true,
      error: null,
    });

    const isCurrent = () =>
      generation.current === forGeneration && selectionToken.current === token;

    try {
      if (row.kind === 'tracked') {
        const response = await gitApi.gitDiff({ ...current, path: row.path });
        if (!isCurrent()) {
          return;
        }
        setState((previous) =>
          previous.selectedPath === row.path && previous.mode === 'diff'
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

        let media: GitMediaView | null = null;
        const payload =
          response.state === 'ok' && response.preview.state === 'ready'
            ? response.preview.media
            : null;
        if (payload) {
          const url = base64ToBlobUrl(payload.content_base64, payload.mime_type);
          if (!isCurrent()) {
            URL.revokeObjectURL(url);
            return;
          }
          mediaUrlRef.current = url;
          media = { url, mimeType: payload.mime_type };
        }

        setState((previous) =>
          previous.selectedPath === row.path && previous.mode === 'preview'
            ? { ...previous, preview: response, media, loading: false, error: null }
            : previous,
        );
      }
    } catch (failure) {
      if (!isCurrent()) {
        return;
      }
      setState((previous) =>
        previous.selectedPath === row.path && previous.mode === mode
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
  useEffect(() => {
    if (!target.current || !handedOver || !rows || lastHandoff.current === handedOver) {
      return;
    }
    const row = rows.find((candidate) => candidate.path === handedOver);
    if (!row) {
      return;
    }
    lastHandoff.current = handedOver;
    void selectRow(row);
  }, [handedOver, rows, selectRow]);

  return { state, selectRow };
}
