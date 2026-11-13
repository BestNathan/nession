import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectsApi } from '@/product/project';
import { useProjects } from '../../useProjects';
import type { Project } from '@/product/project/types';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';

function project(id: string, name: string): Project {
  return {
    project_id: id,
    name,
    locations: [],
    created_at: 1,
    updated_at: 1,
  };
}

const OLD = project('project-old', 'Old list');
const NEW = project('project-new', 'New list');
const NEWEST = project('project-newest', 'Newest list');

/**
 * Settle one deferred list request by its position.
 *
 * `resolveNext` settles the oldest pending request, which is exactly what this
 * suite must not do: ordering is the subject, so the test chooses the request.
 */
function settle(surface: MockPluginSurface, index: number, projects: Project[]) {
  const [request] = surface.requests.splice(index, 1);
  request?.resolve({ projects });
}

function settleError(surface: MockPluginSurface, index: number, message: string) {
  const [request] = surface.requests.splice(index, 1);
  request?.reject(new Error(message));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useProjects response ordering (#3387 SC-01)', () => {
  let surface: MockPluginSurface;
  let release: () => void;
  let unmount: (() => void) | null;

  beforeEach(() => {
    surface = createMockPluginSurface();
    release = projectsApi.install(surface);
    unmount = null;
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    release();
  });

  function renderProjects() {
    const view = renderHook(() => useProjects());
    unmount = view.unmount;
    return view;
  }

  it('keeps the newer refresh when the older read succeeds late (#3387 SC-01)', async () => {
    const { result } = renderProjects();
    // Mount read A.
    expect(surface.requests).toHaveLength(1);
    expect(result.current.loading).toBe(true);

    // A caller refresh B starts before A answers.
    act(() => {
      void result.current.refresh();
    });
    expect(surface.requests).toHaveLength(2);

    // B answers first with the current truth.
    await act(async () => {
      settle(surface, 1, [NEW]);
      await Promise.resolve();
    });
    expect(result.current.projects).toEqual([NEW]);
    expect(result.current.loading).toBe(false);
    expect(result.current.loaded).toBe(true);

    // A answers late with the pre-mutation list. It must not commit.
    await act(async () => {
      settle(surface, 0, [OLD]);
      await Promise.resolve();
    });
    expect(result.current.projects).toEqual([NEW]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('keeps the newer refresh when the older read fails late (#3387 SC-01)', async () => {
    const { result } = renderProjects();
    act(() => {
      void result.current.refresh();
    });

    await act(async () => {
      settle(surface, 1, [NEW]);
      await Promise.resolve();
    });
    expect(result.current.projects).toEqual([NEW]);

    await act(async () => {
      settleError(surface, 0, 'the old read failed');
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.projects).toEqual([NEW]);
    expect(result.current.loading).toBe(false);
  });

  it('commits the newest empty list, the newest failure and a later retry (#3387 SC-01)', async () => {
    const { result } = renderProjects();
    act(() => {
      void result.current.refresh();
    });

    // The latest read answers with a legitimate empty collection.
    await act(async () => {
      settle(surface, surface.requests.length - 1, []);
      await Promise.resolve();
    });
    expect(result.current.projects).toEqual([]);
    expect(result.current.error).toBeNull();

    // The latest read fails: the failure is the current truth.
    act(() => {
      void result.current.refresh();
    });
    await act(async () => {
      settleError(surface, surface.requests.length - 1, 'Projects could not be loaded');
      await Promise.resolve();
    });
    expect(result.current.error).toBe('Projects could not be loaded');
    expect(result.current.loading).toBe(false);

    // Retry succeeds and clears the error with the newest list.
    act(() => {
      void result.current.refresh();
    });
    await act(async () => {
      settle(surface, surface.requests.length - 1, [NEWEST]);
      await Promise.resolve();
    });
    expect(result.current.projects).toEqual([NEWEST]);
    expect(result.current.error).toBeNull();
  });

  it('a reply from a superseded transport cannot commit after reconnect (#3387 SC-01)', async () => {
    const { result } = renderProjects();
    // A is in flight on the old surface.
    expect(surface.requests).toHaveLength(1);

    const nextSurface = createMockPluginSurface();
    const releaseNext = projectsApi.install(nextSurface);
    try {
      // Installing B notifies the hook, which starts the current-generation
      // read on B.
      expect(nextSurface.requests).toHaveLength(1);

      await act(async () => {
        settle(nextSurface, 0, [NEW]);
        await Promise.resolve();
      });
      expect(result.current.projects).toEqual([NEW]);

      // The old transport answers late with its own older list.
      await act(async () => {
        settle(surface, 0, [OLD]);
        await Promise.resolve();
      });
      expect(result.current.projects).toEqual([NEW]);
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    } finally {
      releaseNext();
    }
  });

  it('an uninstalled transport leaves loading honest and ignores the old reply (#3387 SC-01)', async () => {
    const { result } = renderProjects();
    expect(surface.requests).toHaveLength(1);

    // Releasing the transport is a connection change: this read is newest, and
    // a not-yet-installed transport is a loading state, not an error.
    release();
    await flush();
    expect(result.current.loading).toBe(true);
    expect(result.current.projects).toEqual([]);

    await act(async () => {
      settle(surface, 0, [OLD]);
      await Promise.resolve();
    });
    expect(result.current.projects).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.loaded).toBe(false);
  });
});
