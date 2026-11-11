import { beforeEach, describe, expect, it } from 'vitest';
import { ProjectsPlugin } from '@/product/project/ProjectsPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import type { Project } from '@/product/project/types';

const PROJECT: Project = {
  project_id: 'project-123e4567-e89b-42d3-a456-426614174000',
  name: 'Nession',
  locations: [{ agent_id: 'macbook', path: '/Users/nathan/code/nession' }],
  created_at: 1,
  updated_at: 2,
};

describe('ProjectsPlugin', () => {
  let plugin: ProjectsPlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new ProjectsPlugin();
    surface = createMockPluginSurface();
  });

  it('names its transport "projects"', () => {
    expect(plugin.name).toBe('projects');
  });

  it('refuses to request before a transport is installed', async () => {
    await expect(plugin.listProjects()).rejects.toThrow('not connected');
  });

  it('lists Projects through server.project.list', async () => {
    plugin.install(surface);
    const pending = plugin.listProjects();
    expect(surface.requests[0].type).toBe('server.project.list');
    surface.resolveNext('server.project.list', { projects: [PROJECT] });
    await expect(pending).resolves.toEqual([PROJECT]);
  });

  it('reports a failed list as an error, not as an empty collection', async () => {
    plugin.install(surface);
    const pending = plugin.listProjects();
    surface.resolveNext('server.project.list', {
      projects: [],
      error: 'Projects could not be loaded',
    });
    await expect(pending).rejects.toThrow('Projects could not be loaded');
  });

  it('creates with the typed payload and returns the stored Project', async () => {
    plugin.install(surface);
    const pending = plugin.createProject({ name: 'Nession', locations: [] });
    expect(surface.requests[0].type).toBe('server.project.create');
    expect(surface.requests[0].payload).toEqual({ name: 'Nession', locations: [] });
    surface.resolveNext('server.project.create', { success: true, project: PROJECT });
    await expect(pending).resolves.toEqual(PROJECT);
  });

  it('surfaces an update refusal', async () => {
    plugin.install(surface);
    const pending = plugin.updateProject({
      project_id: PROJECT.project_id,
      name: 'Renamed',
      locations: [],
    });
    surface.resolveNext('server.project.update', {
      success: false,
      error: 'Project not found',
      error_kind: 'not_found',
    });
    await expect(pending).rejects.toThrow('Project not found');
  });

  it('returns null for a missing Project and throws for a failed read', async () => {
    plugin.install(surface);
    const missing = plugin.getProject(PROJECT.project_id);
    surface.resolveNext('server.project.get', {
      success: false,
      error: 'Project not found',
      error_kind: 'not_found',
    });
    await expect(missing).resolves.toBeNull();

    const failed = plugin.getProject(PROJECT.project_id);
    surface.resolveNext('server.project.get', {
      success: false,
      error: 'Project could not be loaded',
      error_kind: 'unavailable',
    });
    await expect(failed).rejects.toThrow('Project could not be loaded');
  });

  it('deletes and surfaces a refusal', async () => {
    plugin.install(surface);
    const pending = plugin.deleteProject(PROJECT.project_id);
    expect(surface.requests[0].type).toBe('server.project.delete');
    surface.resolveNext('server.project.delete', { success: true });
    await expect(pending).resolves.toBeUndefined();

    const refused = plugin.deleteProject(PROJECT.project_id);
    surface.resolveNext('server.project.delete', {
      success: false,
      error: 'Project not found',
      error_kind: 'not_found',
    });
    await expect(refused).rejects.toThrow('Project not found');
  });
});
