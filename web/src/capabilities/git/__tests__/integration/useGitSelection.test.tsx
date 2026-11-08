import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitSelection } from '../../hooks/useGitSelection';
import { gitApi } from '../../GitPlugin';
import type { GitRow } from '../../state';
import type { GitDiffResponse, GitPreviewResponse } from '../../types';

vi.mock('../../GitPlugin', () => ({
  gitApi: {
    gitStatus: vi.fn(),
    gitDiff: vi.fn(),
    gitPreview: vi.fn(),
    gitRoot: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
  },
}));

const mockedDiff = vi.mocked(gitApi.gitDiff);
const mockedPreview = vi.mocked(gitApi.gitPreview);

function diffResponse(path: string, marker: string, truncated = false): GitDiffResponse {
  return {
    state: 'ok',
    diff: {
      path,
      text: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${marker}_DIFF_RESPONSE\n+${marker}_DIFF_RESPONSE\n`,
      binary: false,
      truncated,
      truncated_bytes: truncated ? 10 : 0,
    },
  };
}

function previewResponse(path: string, marker: string): GitPreviewResponse {
  const text = `${marker}_PREVIEW_RESPONSE ${path}\n`;
  return {
    state: 'ok',
    preview: {
      path,
      state: 'ready',
      text,
      binary: false,
      size: text.length,
      truncated: false,
      truncated_bytes: 0,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tracked: GitRow = {
  kind: 'tracked',
  path: 'src/reselect.ts',
  file: {
    path: 'src/reselect.ts',
    kind: 'modified',
    staged: false,
    unstaged: true,
  },
};
const untracked: GitRow = { kind: 'untracked', path: 'notes/reselect.ts' };
const untrackedOther: GitRow = { kind: 'untracked', path: 'notes/reselect-other.ts' };
const unmerged: GitRow = { kind: 'unmerged', path: 'src/reselect-conflict.ts' };

type SelectionProps = Parameters<typeof useGitSelection>[0];

function props(overrides: Partial<SelectionProps> = {}): SelectionProps {
  return {
    agentId: 'agent-a',
    sessionId: 'agent-a:review',
    handedOver: null,
    rows: [tracked, untracked, untrackedOther, unmerged],
    ...overrides,
  };
}

function diffText(state: { diff: GitDiffResponse | null }): string {
  return state.diff?.state === 'ok' ? state.diff.diff.text : '';
}

function previewText(state: { preview: GitPreviewResponse | null }): string {
  return state.preview?.state === 'ok' ? state.preview.preview.text : '';
}

describe('Git selection request ownership (#2972)', () => {
  beforeEach(() => {
    mockedDiff.mockReset();
    mockedPreview.mockReset();
  });

  it('keeps the second same-row tracked diff when the first resolves last (SC-01)', async () => {
    const first = deferred<GitDiffResponse>();
    const second = deferred<GitDiffResponse>();
    mockedDiff.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useGitSelection(props()));
    let firstSelection: Promise<void> = Promise.resolve();
    let secondSelection: Promise<void> = Promise.resolve();
    act(() => {
      firstSelection = result.current.selectRow(tracked);
    });
    act(() => {
      secondSelection = result.current.selectRow(tracked);
    });

    await act(async () => {
      second.resolve(diffResponse(tracked.path, 'NEW'));
      await secondSelection;
    });
    expect(diffText(result.current.state)).toContain('NEW_DIFF_RESPONSE');

    await act(async () => {
      first.resolve(diffResponse(tracked.path, 'OLD', true));
      await firstSelection;
    });
    expect(diffText(result.current.state)).toContain('NEW_DIFF_RESPONSE');
    expect(diffText(result.current.state)).not.toContain('OLD_DIFF_RESPONSE');
    if (result.current.state.diff?.state === 'ok') {
      expect(result.current.state.diff.diff.truncated).toBe(false);
    }
    expect(result.current.state.loading).toBe(false);
    expect(result.current.state.error).toBeNull();
  });

  it('does not let a late older rejection replace the newer success (SC-01)', async () => {
    const first = deferred<GitDiffResponse>();
    const second = deferred<GitDiffResponse>();
    mockedDiff.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useGitSelection(props()));
    let firstSelection: Promise<void> = Promise.resolve();
    let secondSelection: Promise<void> = Promise.resolve();
    act(() => {
      firstSelection = result.current.selectRow(tracked);
    });
    act(() => {
      secondSelection = result.current.selectRow(tracked);
    });

    await act(async () => {
      second.resolve(diffResponse(tracked.path, 'NEW'));
      await secondSelection;
    });
    await act(async () => {
      first.reject(new Error('older selection failed'));
      await firstSelection;
    });

    expect(diffText(result.current.state)).toContain('NEW_DIFF_RESPONSE');
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.loading).toBe(false);
  });

  it('keeps the second same-row preview when the first resolves last (SC-02)', async () => {
    const first = deferred<GitPreviewResponse>();
    const second = deferred<GitPreviewResponse>();
    mockedPreview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useGitSelection(props()));
    let firstSelection: Promise<void> = Promise.resolve();
    let secondSelection: Promise<void> = Promise.resolve();
    act(() => {
      firstSelection = result.current.selectRow(untracked);
    });
    act(() => {
      secondSelection = result.current.selectRow(untracked);
    });

    await act(async () => {
      second.resolve(previewResponse(untracked.path, 'NEW'));
      await secondSelection;
    });
    expect(previewText(result.current.state)).toBe(
      `NEW_PREVIEW_RESPONSE ${untracked.path}\n`,
    );

    await act(async () => {
      first.resolve(previewResponse(untracked.path, 'OLD'));
      await firstSelection;
    });
    expect(previewText(result.current.state)).toBe(
      `NEW_PREVIEW_RESPONSE ${untracked.path}\n`,
    );
    expect(result.current.state.media).toBeNull();
    expect(result.current.state.error).toBeNull();
  });

  it('holds the same ownership for an unmerged preview (SC-02)', async () => {
    const first = deferred<GitPreviewResponse>();
    const second = deferred<GitPreviewResponse>();
    mockedPreview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useGitSelection(props()));
    let firstSelection: Promise<void> = Promise.resolve();
    let secondSelection: Promise<void> = Promise.resolve();
    act(() => {
      firstSelection = result.current.selectRow(unmerged);
    });
    act(() => {
      secondSelection = result.current.selectRow(unmerged);
    });

    await act(async () => {
      second.resolve(previewResponse(unmerged.path, 'NEW'));
      await secondSelection;
    });
    await act(async () => {
      first.resolve(previewResponse(unmerged.path, 'OLD'));
      await firstSelection;
    });

    expect(previewText(result.current.state)).toBe(
      `NEW_PREVIEW_RESPONSE ${unmerged.path}\n`,
    );
  });

  it('discards an older preview when the path changes (SC-02)', async () => {
    const first = deferred<GitPreviewResponse>();
    mockedPreview.mockReturnValueOnce(first.promise).mockResolvedValueOnce(
      previewResponse(untrackedOther.path, 'NEW'),
    );

    const { result } = renderHook(() => useGitSelection(props()));
    let firstSelection: Promise<void> = Promise.resolve();
    act(() => {
      firstSelection = result.current.selectRow(untracked);
    });
    await act(async () => {
      await result.current.selectRow(untrackedOther);
    });
    expect(previewText(result.current.state)).toBe(
      `NEW_PREVIEW_RESPONSE ${untrackedOther.path}\n`,
    );

    await act(async () => {
      first.resolve(previewResponse(untracked.path, 'OLD'));
      await firstSelection;
    });
    expect(previewText(result.current.state)).toBe(
      `NEW_PREVIEW_RESPONSE ${untrackedOther.path}\n`,
    );
  });

  it('discards an older preview when the Session changes (SC-02)', async () => {
    const first = deferred<GitPreviewResponse>();
    mockedPreview.mockReturnValueOnce(first.promise);

    const { result, rerender } = renderHook((value: SelectionProps) => useGitSelection(value), {
      initialProps: props(),
    });
    let firstSelection: Promise<void> = Promise.resolve();
    act(() => {
      firstSelection = result.current.selectRow(untracked);
    });

    rerender(props({ sessionId: 'agent-a:design-system' }));
    await act(async () => {
      first.resolve(previewResponse(untracked.path, 'OLD'));
      await firstSelection;
    });

    expect(result.current.state.selectedPath).toBeNull();
    expect(result.current.state.preview).toBeNull();
    expect(result.current.state.loading).toBe(false);
  });
});
