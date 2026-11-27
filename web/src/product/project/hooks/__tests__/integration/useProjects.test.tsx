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

/**
 * #3387 SC-01, restated for the #4602 pull controller. The hazard — an older
 * answer overwriting a newer one — is now structural: the controller holds at
 * most one read in flight per context, so a second refresh is queued behind the
 * first instead of racing it, and a retired transport's reply cannot publish at
 * all. These prove the held refresh still lands its own answer, that the newest
 * empty/failure/retry sequence commits, and that a replaced transport is fenced.
 */
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

  it('holds a manual refresh behind the mount read and lands its own answer (#3387 SC-01)', async () => {
    const { result } = renderProjects();
    // Mount read A.
    expect(surface.requests).toHaveLength(1);
    expect(result.current.loading).toBe(true);

    // A caller refresh B is held behind A, not started concurrently.
    act(() => {
      void result.current.refresh();
    });
    expect(surface.requests).toHaveLength(1);

    // A answers first; only then does the held B start.
    await act(async () => {
      settle(surface, 0, [OLD]);
      await Promise.resolve();
    });
    expect(result.current.projects).toEqual([OLD]);
    expect(surface.requests).toHaveLength(1);

    // B answers with the current truth and is the final word.
    await act(async () => {
      settle(surface, 0, [NEW]);
      await Promise.resolve();
    });
    expect(result.current.projects).toEqual([NEW]);
    expect(result.current.loading).toBe(false);
    expect(result.current.loaded).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('keeps a newer success when the earlier read failed (#3387 SC-01)', async () => {
    const { result } = renderProjects();
    act(() => {
      void result.current.refresh();
    });
    // Held, not concurrent.
    expect(surface.requests).toHaveLength(1);

    await act(async () => {
      settleError(surface, 0, 'the old read failed');
      await Promise.resolve();
    });
    await act(async () => {
      settle(surface, 0, [NEW]);
      await Promise.resolve();
    });
    expect(result.current.projects).toEqual([NEW]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('commits the newest empty list, the newest failure and a later retry (#3387 SC-01)', async () => {
    const { result } = renderProjects();

    // The mount read answers with a legitimate empty collection.
    await act(async () => {
      settle(surface, 0, []);
      await Promise.resolve();
    });
    expect(result.current.projects).toEqual([]);
    expect(result.current.error).toBeNull();

    // A later read fails: the failure is the current truth.
    act(() => {
      void result.current.refresh();
    });
    await act(async () => {
      settleError(surface, 0, 'Projects could not be loaded');
      await Promise.resolve();
    });
    expect(result.current.error).toBe('Projects could not be loaded');
    expect(result.current.loading).toBe(false);

    // Retry succeeds and clears the error with the newest list.
    act(() => {
      void result.current.refresh();
    });
    await act(async () => {
      settle(surface, 0, [NEWEST]);
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
      // Installing B notifies the hook; the revision change retires A and starts
      // the current-generation read on B (one render later).
      await flush();
      expect(nextSurface.requests).toHaveLength(1);

      await act(async () => {
        settle(nextSurface, 0, [NEW]);
        await Promise.resolve();
      });
      expect(result.current.projects).toEqual([NEW]);

      // The old transport answers late with its own older list. Its read was
      // retired, so it cannot commit.
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

    // Releasing the transport is a connection change: a not-yet-installed
    // transport is a loading state, not an error.
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