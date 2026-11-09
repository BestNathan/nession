import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitSelection } from '../../hooks/useGitSelection';
import { gitApi } from '../../GitPlugin';
import type { GitRow } from '../../state';
import type { GitPreviewResponse } from '../../types';

const blob = vi.hoisted(() => ({ next: 0 }));
vi.mock('@/shared/lib/blob', () => ({
  base64ToBlobUrl: vi.fn(() => `blob:${++blob.next}`),
}));

vi.mock('../../GitPlugin', () => ({
  gitApi: {
    gitStatus: vi.fn(),
    gitDiff: vi.fn(),
    gitPreview: vi.fn(),
    gitRoot: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
  },
}));

const mockedPreview = vi.mocked(gitApi.gitPreview);
const revokeObjectURL = vi.fn();

function mediaResponse(path: string): GitPreviewResponse {
  return {
    state: 'ok',
    preview: {
      path,
      state: 'ready',
      text: '',
      binary: true,
      size: 10,
      truncated: false,
      truncated_bytes: 0,
      media: { content_base64: 'AAAA', mime_type: 'image/png', complete: true },
    },
  };
}

function textResponse(path: string): GitPreviewResponse {
  return {
    state: 'ok',
    preview: {
      path,
      state: 'ready',
      text: 'plain\n',
      binary: false,
      size: 6,
      truncated: false,
      truncated_bytes: 0,
    },
  };
}

const photo: GitRow = { kind: 'untracked', path: 'assets/photo.png', key: 'untracked:assets/photo.png' };
const notes: GitRow = { kind: 'untracked', path: 'notes/plain.txt', key: 'untracked:notes/plain.txt' };

describe('Git media selection (#2876 SC-03/SC-04)', () => {
  beforeEach(() => {
    blob.next = 0;
    revokeObjectURL.mockReset();
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
    mockedPreview.mockReset();
  });

  it('asks for media bytes for a media path and revokes the URL when selection changes', async () => {
    mockedPreview.mockImplementation(async (req) =>
      req.path === photo.path ? mediaResponse(photo.path) : textResponse(notes.path),
    );
    const { result, unmount } = renderHook(() =>
      useGitSelection({ agentId: 'a', sessionId: 'a:s', handedOver: null, rows: [photo, notes] }),
    );

    await act(async () => {
      await result.current.selectRow(photo);
    });
    await waitFor(() => expect(result.current.state.media?.url).toBe('blob:1'));
    expect(mockedPreview).toHaveBeenCalledWith({
      agent_id: 'a',
      session: 'a:s',
      path: photo.path,
      expected: 'untracked',
      want: 'media',
    });

    await act(async () => {
      await result.current.selectRow(notes);
    });
    await waitFor(() => expect(result.current.state.media).toBeNull());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:1');

    unmount();
  });

  it('drops a stale media answer instead of displaying it', async () => {
    let resolvePhoto: (value: GitPreviewResponse) => void = () => {};
    mockedPreview.mockImplementation(async (req) => {
      if (req.path === photo.path) {
        return new Promise<GitPreviewResponse>((resolve) => {
          resolvePhoto = resolve;
        });
      }
      return textResponse(notes.path);
    });
    const { result } = renderHook(() =>
      useGitSelection({ agentId: 'a', sessionId: 'a:s', handedOver: null, rows: [photo, notes] }),
    );

    let photoSelection: Promise<void> = Promise.resolve();
    act(() => {
      photoSelection = result.current.selectRow(photo);
    });
    await act(async () => {
      await result.current.selectRow(notes);
    });
    expect(result.current.state.selectedPath).toBe(notes.path);

    await act(async () => {
      resolvePhoto(mediaResponse(photo.path));
      await photoSelection;
    });

    expect(result.current.state.selectedPath).toBe(notes.path);
    expect(result.current.state.media).toBeNull();
  });
});
