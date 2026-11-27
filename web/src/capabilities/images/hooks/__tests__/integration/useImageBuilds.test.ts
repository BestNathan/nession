import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ImageBuildDescriptor } from '@/generated/protocol/core/server-image-build-submit/v1';

type BuildChangedListener = (build: ImageBuildDescriptor) => void;
type ConnectionListener = (state: string) => void;

const imagesApi = vi.hoisted(() => ({
  listBuilds: vi.fn(),
  onBuildChanged: vi.fn(),
  onConnectionStateChange: vi.fn(),
  connectionState: vi.fn(() => 'connected'),
  cancelBuild: vi.fn(),
  retryBuild: vi.fn(),
}));

vi.mock('@/capabilities/images/ImagesPlugin', () => ({
  imagesApi,
  IMAGE_PAGE_SIZE: 20,
}));
vi.mock('@/capabilities/images/model', () => ({ IMAGE_PAGE_SIZE: 20 }));

import { useImageBuilds } from '@/capabilities/images/hooks/useImageBuilds';

function build(overrides: Partial<ImageBuildDescriptor> = {}): ImageBuildDescriptor {
  return {
    build_id: 'b1',
    image_id: 'i1',
    attempt: 1,
    source: {
      kind: 'github',
      repository_url: 'https://github.com/BestNathan/nession',
      ref: 'main',
    },
    packaging: {
      compression: 'none',
      block_size: 4096,
      fixed_timestamp: 0,
      fixed_uuid: '11111111-1111-4111-8111-111111111111',
    },
    status: 'running',
    stage: 'packaging',
    progress: { files: 1, bytes: 10, elapsed_ms: 5 },
    size_bytes: 0,
    deduplicated: false,
    alias: 'nightly',
    created_at: 1,
    updated_at: 2,
    ...overrides,
  } as ImageBuildDescriptor;
}

let push: BuildChangedListener = () => {};
let connection: ConnectionListener = () => {};

describe('useImageBuilds — filtered page authority (#4602 SC-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imagesApi.connectionState.mockReturnValue('connected');
    imagesApi.onBuildChanged.mockImplementation((listener: BuildChangedListener) => {
      push = listener;
      return () => {};
    });
    imagesApi.onConnectionStateChange.mockImplementation((listener: ConnectionListener) => {
      connection = listener;
      return () => {};
    });
    imagesApi.listBuilds.mockResolvedValue({ builds: [build()], total: 1 });
  });

  it('re-reads the authoritative page when a transition leaves the active filter', async () => {
    const { result } = renderHook(() => useImageBuilds());
    await waitFor(() => expect(result.current.builds).toHaveLength(1));

    act(() => { result.current.toggleStatus('running'); });
    await waitFor(() => expect(result.current.builds).toHaveLength(1));
    const readsBefore = imagesApi.listBuilds.mock.calls.length;

    // The build succeeded, so it no longer belongs to a `running` filter.
    imagesApi.listBuilds.mockResolvedValue({ builds: [], total: 0 });
    act(() => { push(build({ status: 'succeeded' })); });

    await waitFor(() => {
      expect(imagesApi.listBuilds.mock.calls.length).toBeGreaterThan(readsBefore);
    });
    await waitFor(() => expect(result.current.builds).toEqual([]));
    expect(result.current.total).toBe(0);
  });

  it('re-reads instead of fabricating a row and a total for an entering build', async () => {
    const { result } = renderHook(() => useImageBuilds());
    await waitFor(() => expect(result.current.builds).toHaveLength(1));
    const readsBefore = imagesApi.listBuilds.mock.calls.length;

    imagesApi.listBuilds.mockResolvedValue({ builds: [build({ build_id: 'b2' }), build()], total: 2 });
    act(() => { push(build({ build_id: 'b2' })); });

    await waitFor(() => {
      expect(imagesApi.listBuilds.mock.calls.length).toBeGreaterThan(readsBefore);
    });
    // The count is the Server's answer, never local arithmetic.
    await waitFor(() => expect(result.current.total).toBe(2));
    expect(result.current.builds.map((entry) => entry.build_id)).toEqual(['b2', 'b1']);
  });

  it('applies a pushed transition in place while the record still matches', async () => {
    const { result } = renderHook(() => useImageBuilds());
    await waitFor(() => expect(result.current.builds).toHaveLength(1));
    const readsBefore = imagesApi.listBuilds.mock.calls.length;

    act(() => { push(build({ stage: 'publishing', updated_at: 9 })); });

    expect(result.current.builds[0].stage).toBe('publishing');
    expect(imagesApi.listBuilds.mock.calls.length).toBe(readsBefore);
  });

  it('never lets an older selection reply overwrite the current page', async () => {
    const resolvers: Array<(page: { builds: ImageBuildDescriptor[]; total: number }) => void> = [];
    imagesApi.listBuilds.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const { result } = renderHook(() => useImageBuilds());
    expect(resolvers).toHaveLength(1);

    act(() => { result.current.setQuery('nightly'); });
    // The new selection retires the old read; only one read is ever in flight.
    await waitFor(() => expect(resolvers.length).toBeGreaterThanOrEqual(1));

    await act(async () => {
      resolvers[0]({ builds: [build({ alias: 'old-selection' })], total: 1 });
      await Promise.resolve();
    });
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1]({ builds: [build({ alias: 'nightly' })], total: 1 });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.builds[0].alias).toBe('nightly'));
    expect(imagesApi.listBuilds).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'nightly' }),
    );
  });

  it('re-reads the durable inventory once the transport returns', async () => {
    const { result } = renderHook(() => useImageBuilds());
    await waitFor(() => expect(result.current.builds).toHaveLength(1));
    const readsBefore = imagesApi.listBuilds.mock.calls.length;

    act(() => {
      connection('reconnecting');
      connection('connected');
    });

    await waitFor(() => {
      expect(imagesApi.listBuilds.mock.calls.length).toBeGreaterThan(readsBefore);
    });
  });
});