import { describe, expect, it } from 'vitest';
import {
  createFixtureProjectHarness,
  fixtureProjectsScenario,
} from '@/app/fixture/fixtureProjects';
import type { Project } from '@/product/project/types';

describe('fixtureProjects', () => {
  it('reads the projects scenario from the route query', () => {
    expect(fixtureProjectsScenario('')).toBe('canonical');
    expect(fixtureProjectsScenario('?projects=empty')).toBe('empty');
    expect(fixtureProjectsScenario('?projects=error')).toBe('error');
    expect(fixtureProjectsScenario('?projects=offline')).toBe('offline');
    expect(fixtureProjectsScenario('?projects=long')).toBe('long');
  });

  it('answers the five Project wires with deterministic data', async () => {
    const { surface, controls } = createFixtureProjectHarness('');
    const list = await surface.request<{ projects: Project[] }>('server.project.list', {});
    expect(list.projects).toHaveLength(2);
    expect(list.projects[0].name).toBe('Nession');

    const created = await surface.request<{ success: boolean; project: Project }>(
      'server.project.create',
      { name: 'Created', locations: [] },
    );
    expect(created.success).toBe(true);
    expect(created.project.name).toBe('Created');
    expect(controls.createRequests()).toHaveLength(1);
    expect(controls.projects()).toHaveLength(3);

    const updated = await surface.request<{ success: boolean; project: Project }>(
      'server.project.update',
      {
        project_id: created.project.project_id,
        name: 'Renamed',
        locations: [],
        session_defaults: null,
      },
    );
    expect(updated.project.name).toBe('Renamed');
    expect(updated.project.created_at).toBe(created.project.created_at);

    const deleted = await surface.request<{ success: boolean }>('server.project.delete', {
      project_id: created.project.project_id,
    });
    expect(deleted.success).toBe(true);
    expect(controls.deleteRequests()).toHaveLength(1);
    expect(controls.projects().some((project) => project.project_id === created.project.project_id))
      .toBe(false);
  });

  it('reports a failed list without fabricating projects', async () => {
    const { surface } = createFixtureProjectHarness('?projects=error');
    const response = await surface.request<{ projects: Project[]; error?: string }>(
      'server.project.list',
      {},
    );
    expect(response.projects).toEqual([]);
    expect(response.error).toBe('Projects could not be loaded');
  });

  it('places the canonical project on the offline Agent for the offline scenario', async () => {
    const { surface } = createFixtureProjectHarness('?projects=offline');
    const list = await surface.request<{ projects: Project[] }>('server.project.list', {});
    expect(list.projects[0].locations[0].agent_id).toBe('sg-prod');
  });

  it('gives the long scenario two online multi-segment locations', async () => {
    const { surface } = createFixtureProjectHarness('?projects=long');
    const list = await surface.request<{ projects: Project[] }>('server.project.list', {});
    const locations = list.projects[0].locations;
    expect(locations).toHaveLength(2);
    expect(locations[0].agent_id).toBe('macbook');
    expect(locations[1].agent_id).toBe('devbox-01');
    expect(locations.every((location) => location.path.split('/').length > 8)).toBe(true);
  });
});
