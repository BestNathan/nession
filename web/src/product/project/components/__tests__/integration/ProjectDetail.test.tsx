import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectDetailContent } from '@/product/project/components/ProjectDetail';
import type { Project } from '@/product/project/types';
import type { Agent } from '@/types';

function agent(overrides: Partial<Agent>): Agent {
  return {
    agent_id: 'macbook',
    hostname: 'macbook',
    ip_address: '10.0.0.1',
    port: 19090,
    status: 'online',
    session_count: 0,
    last_heartbeat: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const PROJECT: Project = {
  project_id: 'project-123e4567-e89b-42d3-a456-426614174000',
  name: 'Nession',
  description: 'Workspace for Nession',
  source: { repository_url: 'https://github.com/BestNathan/nession.git', ref: 'main' },
  locations: [
    { agent_id: 'macbook', path: '/Users/nathan/code/nession' },
    { agent_id: 'sg-prod', path: '/srv/nession' },
  ],
  session_defaults: {
    shell: '/bin/zsh',
    env_profile_ids: ['dev', 'prod'],
    sandbox_policy_ref: 'sandbox/default',
  },
  image_digest: `sha256:${'a'.repeat(64)}`,
  created_at: 1,
  updated_at: 2,
};

const AGENTS = [agent({}), agent({ agent_id: 'sg-prod', hostname: 'sg-prod', status: 'offline' })];

describe('ProjectDetailContent', () => {
  it('shows the declaration: source, locations, defaults and image digest', () => {
    render(
      <ProjectDetailContent
        project={PROJECT}
        agents={AGENTS}
        onCreateSession={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    expect(screen.getByTestId('project-detail-title')).toHaveTextContent('Nession');
    expect(screen.getByTestId('project-source-ref')).toHaveTextContent('main');
    expect(screen.getByText('https://github.com/BestNathan/nession.git')).toBeInTheDocument();
    expect(screen.getByText('/Users/nathan/code/nession')).toBeInTheDocument();
    expect(screen.getByText('/srv/nession')).toBeInTheDocument();
    expect(screen.getAllByTestId('project-location-status').map((node) => node.textContent))
      .toEqual(['Online', 'Offline']);
    expect(screen.getByText('/bin/zsh')).toBeInTheDocument();
    expect(screen.getByText('dev, prod')).toBeInTheDocument();
    expect(screen.getByText('sandbox/default')).toBeInTheDocument();
    expect(screen.getByTestId('project-image-digest')).toHaveTextContent('sha256:');
  });

  it('invokes the Project actions without requiring a Session', async () => {
    const user = userEvent.setup();
    const onCreateSession = vi.fn();
    const onSettings = vi.fn();
    render(
      <ProjectDetailContent
        project={PROJECT}
        agents={AGENTS}
        onCreateSession={onCreateSession}
        onSettings={onSettings}
      />,
    );

    await user.click(screen.getByTestId('project-detail-create-session'));
    expect(onCreateSession).toHaveBeenCalledWith(PROJECT);

    await user.click(screen.getByLabelText('Project settings'));
    expect(onSettings).toHaveBeenCalledWith(PROJECT);
  });

  it('explains absent source, locations, defaults and image', () => {
    render(
      <ProjectDetailContent
        project={{
          project_id: PROJECT.project_id,
          name: 'Empty Project',
          locations: [],
          created_at: 1,
          updated_at: 2,
        }}
        agents={[]}
        onCreateSession={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
    expect(screen.getByText('No Git source configured.')).toBeInTheDocument();
    expect(screen.getByText(/No Existing Locations/)).toBeInTheDocument();
    expect(screen.getByText('No Session defaults.')).toBeInTheDocument();
    expect(screen.getByText(/No image digest/)).toBeInTheDocument();
  });
});
