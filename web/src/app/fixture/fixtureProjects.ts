import { useEffect, useMemo, useState } from 'react';
import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import { projectsApi } from '@/product/project';
import { useProjects } from '@/product/project/hooks/useProjects';
import { useProjectDialogs } from '@/product/project/hooks/useProjectDialogs';
import type { Project, ProjectShellProps } from '@/product/project/types';
import { FIXTURE_AGENTS } from './fixtureData';

export const PROJECT_ONE = 'project-00000000-0000-4000-8000-000000000001';
export const PROJECT_TWO = 'project-00000000-0000-4000-8000-000000000002';
const CREATED_AT = 1_762_300_000;
const UPDATED_AT = 1_762_303_600;

function seedProjects(): Project[] {
  return [
    {
      project_id: PROJECT_ONE,
      name: 'Nession',
      description: 'Workspace for Nession',
      source: {
        repository_url: 'https://github.com/BestNathan/nession.git',
        ref: 'main',
      },
      locations: [{ agent_id: 'macbook', path: '/Users/nathan/code/nession' }],
      session_defaults: {
        shell: '/bin/zsh',
        env_profile_ids: ['dev'],
        sandbox_policy_ref: 'sandbox/default',
      },
      image_digest: `sha256:${'a'.repeat(64)}`,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
    },
    {
      project_id: PROJECT_TWO,
      name: 'Ops notes',
      locations: [],
      created_at: CREATED_AT + 60,
      updated_at: UPDATED_AT + 60,
    },
  ];
}

function offlineProjects(): Project[] {
  const projects = seedProjects();
  projects[0].locations = [{ agent_id: 'sg-prod', path: '/srv/nession' }];
  return projects;
}

/**
 * Two online Existing Locations with multi-segment paths (#3089 SC-07). The
 * canonical single short location cannot exercise the Select's wrapping
 * boundary, and the offline scenario cannot exercise selection.
 */
function longLocationProjects(): Project[] {
  const projects = seedProjects();
  projects[0].locations = [
    {
      agent_id: 'macbook',
      path: '/Users/nathan/code/nession/.claude/worktrees/fix-3089-select-location-geometry/web/src/product/session/components',
    },
    {
      agent_id: 'devbox-01',
      path: '/workspace/nession/services/web/src/product/session/components/very-long-directory-name-for-geometry',
    },
  ];
  return projects;
}

export type FixtureProjectsScenario =
  | 'canonical'
  | 'empty'
  | 'error'
  | 'loading'
  | 'offline'
  | 'long'
  | 'stale-list';

export function fixtureProjectsScenario(search: string): FixtureProjectsScenario {
  const value = new URLSearchParams(search).get('projects');
  if (
    value === 'empty' ||
    value === 'error' ||
    value === 'loading' ||
    value === 'offline' ||
    value === 'long' ||
    value === 'stale-list'
  ) {
    return value;
  }
  return 'canonical';
}

interface HeldList {
  /** The list as it stood when the read started. */
  snapshot: Project[];
  resolve: (payload: unknown) => void;
}

interface ProjectHarnessState {
  scenario: FixtureProjectsScenario;
  projects: Project[];
  lists: number;
  creates: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  deletes: Record<string, unknown>[];
  next: number;
  /** `stale-list` reads, oldest first, settled only by the browser test. */
  heldLists: HeldList[];
}

function answerList(state: ProjectHarnessState): unknown {
  state.lists += 1;
  if (state.scenario === 'error') {
    return { projects: [], error: 'Projects could not be loaded' };
  }
  return { projects: state.projects };
}

function answerGet(state: ProjectHarnessState, payload: Record<string, unknown>): unknown {
  const project = state.projects.find((item) => item.project_id === payload.project_id);
  return project
    ? { success: true, project }
    : { success: false, error_kind: 'not_found', error: 'Project not found' };
}

function answerCreate(state: ProjectHarnessState, payload: Record<string, unknown>): unknown {
  state.creates.push(payload);
  const name = String(payload.name ?? '').trim();
  if (!name) {
    return { success: false, error_kind: 'invalid', error: 'project name must not be empty' };
  }
  const now = CREATED_AT + state.next;
  const project: Project = {
    project_id: `project-00000000-0000-4000-8000-${String(900 + state.next).padStart(12, '0')}`,
    name,
    description: (payload.description as string | undefined) || undefined,
    source: (payload.source as Project['source']) ?? undefined,
    locations: (payload.locations as Project['locations']) ?? [],
    session_defaults: (payload.session_defaults as Project['session_defaults']) ?? undefined,
    image_digest: (payload.image_digest as string | undefined) || undefined,
    created_at: now,
    updated_at: now,
  };
  state.next += 1;
  state.projects = [...state.projects, project];
  return { success: true, project };
}

function answerUpdate(state: ProjectHarnessState, payload: Record<string, unknown>): unknown {
  state.updates.push(payload);
  const index = state.projects.findIndex((item) => item.project_id === payload.project_id);
  if (index < 0) {
    return { success: false, error_kind: 'not_found', error: 'Project not found' };
  }
  const previous = state.projects[index];
  const project: Project = {
    project_id: previous.project_id,
    name: String(payload.name ?? previous.name),
    description: (payload.description as string | undefined) || undefined,
    source: (payload.source as Project['source']) ?? undefined,
    locations: (payload.locations as Project['locations']) ?? [],
    session_defaults: (payload.session_defaults as Project['session_defaults']) ?? undefined,
    image_digest: (payload.image_digest as string | undefined) || undefined,
    created_at: previous.created_at,
    updated_at: previous.updated_at + 1,
  };
  state.projects = state.projects.map((item, i) => (i === index ? project : item));
  return { success: true, project };
}

function answerDelete(state: ProjectHarnessState, payload: Record<string, unknown>): unknown {
  state.deletes.push(payload);
  const exists = state.projects.some((item) => item.project_id === payload.project_id);
  if (!exists) {
    return { success: false, error_kind: 'not_found', error: 'Project not found' };
  }
  state.projects = state.projects.filter((item) => item.project_id !== payload.project_id);
  return { success: true };
}

function fixtureProjectSurface(state: ProjectHarnessState): PluginSurface {
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));
  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      switch (type) {
        case 'server.project.list':
          if (state.scenario === 'loading') {
            state.lists += 1;
            return new Promise<T>(() => {});
          }
          if (state.scenario === 'stale-list') {
            state.lists += 1;
            // Capture the answer now and settle it in the order the browser
            // test chooses: a later mutation's refresh must win over this
            // older read even when it arrives first (#3387 SC-02).
            return new Promise<T>((resolve) => {
              state.heldLists.push({
                snapshot: state.projects,
                resolve: resolve as (payload: unknown) => void,
              });
            });
          }
          return Promise.resolve(answerList(state)) as Promise<T>;
        case 'server.project.get':
          return Promise.resolve(answerGet(state, payload)) as Promise<T>;
        case 'server.project.create':
          return Promise.resolve(answerCreate(state, payload)) as Promise<T>;
        case 'server.project.update':
          return Promise.resolve(answerUpdate(state, payload)) as Promise<T>;
        case 'server.project.delete':
          return Promise.resolve(answerDelete(state, payload)) as Promise<T>;
        default:
          return Promise.reject(new Error(`fixture project surface does not answer ${type}`));
      }
    },
    send(): void {},
    subscribe(): () => void {
      return () => {};
    },
    onBinary(): () => void {
      return () => {};
    },
    waitForConnection(): Promise<void> {
      return Promise.resolve();
    },
    onConnectionStateChange(): () => void {
      return () => {};
    },
  };
}

export interface FixtureProjectControls {
  projects: () => Project[];
  listRequests: () => number;
  createRequests: () => Record<string, unknown>[];
  updateRequests: () => Record<string, unknown>[];
  deleteRequests: () => Record<string, unknown>[];
  /** Start the same Project list refresh a caller/mutation would. */
  refresh: () => void;
  /** `stale-list`: reads still waiting for the test to settle them. */
  pendingLists: () => number;
  /** Resolve the newest held read with the answer it captured. */
  releaseLatestList: () => boolean;
  /** Resolve the oldest held read with the answer it captured. */
  releaseOldestList: () => boolean;
}

export function createFixtureProjectHarness(search: string): {
  surface: PluginSurface;
  controls: FixtureProjectControls;
} {
  const scenario = fixtureProjectsScenario(search);
  const state: ProjectHarnessState = {
    scenario,
    projects: scenario === 'empty' || scenario === 'error' || scenario === 'loading'
      ? []
      : scenario === 'offline'
        ? offlineProjects()
        : scenario === 'long'
          ? longLocationProjects()
          : seedProjects(),
    lists: 0,
    creates: [],
    updates: [],
    deletes: [],
    next: 0,
    heldLists: [],
  };
  return {
    surface: fixtureProjectSurface(state),
    controls: {
      projects: () => state.projects,
      listRequests: () => state.lists,
      createRequests: () => state.creates,
      updateRequests: () => state.updates,
      deleteRequests: () => state.deletes,
      refresh: () => {},
      pendingLists: () => state.heldLists.length,
      releaseLatestList: () => {
        const held = state.heldLists.pop();
        held?.resolve({ projects: held.snapshot });
        return Boolean(held);
      },
      releaseOldestList: () => {
        const held = state.heldLists.shift();
        held?.resolve({ projects: held.snapshot });
        return Boolean(held);
      },
    },
  };
}

type FixtureProjectsWindow = Window & {
  fixtureProjects?: FixtureProjectControls;
};

/** Bind the Project stub for a fixture route's lifetime. */
export function useFixtureProjects(search: string): ReturnType<typeof createFixtureProjectHarness> {
  const harness = useMemo(() => createFixtureProjectHarness(search), [search]);
  useEffect(() => {
    const release = projectsApi.install(harness.surface);
    (window as FixtureProjectsWindow).fixtureProjects = harness.controls;
    return () => {
      release();
      const windowWithControls = window as FixtureProjectsWindow;
      if (windowWithControls.fixtureProjects === harness.controls) {
        delete windowWithControls.fixtureProjects;
      }
    };
  }, [harness]);
  return harness;
}

/**
 * Project data, destination and dialogs for a fixture route.
 *
 * The fixture renders the real `Sidebar`/`AppSessionsSurface`/`ProjectDetail`
 * composition, so its Project actions must go through the same product hook and
 * dialogs as the shipped shell.
 */
export function useFixtureProjectShell(search: string) {
  const harness = useFixtureProjects(search);
  const projects = useProjects();
  const refreshProjects = projects.refresh;
  useEffect(() => {
    // The browser Case needs to start an older read before a mutation, then
    // settle the mutation's newer refresh first (#3387 SC-02).
    harness.controls.refresh = () => {
      void refreshProjects();
    };
    return () => {
      harness.controls.refresh = () => {};
    };
  }, [harness, refreshProjects]);
  const dialogs = useProjectDialogs();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (
      projects.loaded &&
      selectedProjectId &&
      !projects.projects.some((project) => project.project_id === selectedProjectId)
    ) {
      setSelectedProjectId(null);
    }
  }, [projects.loaded, projects.projects, selectedProjectId]);

  const projectShell: ProjectShellProps = {
    projects: projects.projects,
    loading: projects.loading,
    error: projects.error,
    selectedProjectId,
    onCreate: dialogs.openCreate,
    onRetry: () => { void projects.refresh(); },
    onSelect: (project) => setSelectedProjectId(project.project_id),
    onClose: () => setSelectedProjectId(null),
    onRename: dialogs.openRename,
    onSettings: dialogs.openSettings,
    onDelete: dialogs.openDelete,
    onCreateSession: dialogs.openCreateSession,
  };

  return { projectShell, dialogs, projects };
}
