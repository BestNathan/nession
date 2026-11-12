import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SandboxCapabilityCatalog,
  SandboxCurrentContext,
  SandboxImplementationSupport,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { imagesApi, type ImageDescriptor } from '@/capabilities/images';
import { useSandboxDraft } from '../../hooks/useSandboxDraft';
import { useSandboxImages } from '../../hooks/useSandboxImages';
import { SandboxImageComposition } from '../../components/SandboxImageComposition';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';

const api = vi.hoisted(() => ({
  imageCacheStatuses: vi.fn(),
}));

vi.mock('../../SandboxPlugin', () => ({
  sandboxApi: api,
  SandboxPlugin: class SandboxPlugin {},
}));

function catalog(status: 'available' | 'unavailable' = 'available'): SandboxCapabilityCatalog {
  const implementation = (
    path: string,
    implementationStatus: 'available' | 'unavailable' = 'available',
  ): SandboxImplementationSupport => ({ path, status: implementationStatus });
  return {
    catalog_version: 2,
    status: 'available',
    platform: 'linux',
    backend: 'linux-bwrap',
    probe_generation: 'probe-1',
    source: 'agent-host-probe',
    detail: [],
    implementations: [
      implementation('filesystem.access'),
      implementation('filesystem.composition', status),
    ],
    resource_fields: [],
    syscall_fields: [],
  };
}

function context(status: 'available' | 'unavailable' = 'available'): SandboxCurrentContext {
  return {
    status: 'outside',
    scope: {
      session_name: 's1',
      session_instance_id: 'instance-1',
      pane_id: '%1',
      window_id: '@1',
      pane_pid: 42,
      working_dir: '/workspace',
    },
    generation: 'gen-1',
    enterable: true,
    sandbox_panes: [],
    catalog: catalog(status),
  };
}

const DIGEST = `sha256:${'a'.repeat(64)}`;

function image(): ImageDescriptor {
  return {
    image_id: 'image-one',
    digest: DIGEST,
    size_bytes: 4096,
    source: { kind: 'local_directory', path: '/var/lib/nession/base' },
    packaging: {
      compression: 'none',
      block_size: 4096,
      fixed_timestamp: 0,
      fixed_uuid: '11111111-1111-4111-8111-111111111111',
    },
    status: 'ready',
    alias: 'base-runtime',
    aliases: ['base-runtime'],
    created_at: 1,
    updated_at: 2,
  };
}

function Harness({ status = 'available' }: { status?: 'available' | 'unavailable' }) {
  const ctx = context(status);
  const draft = useSandboxDraft(ctx);
  const images = useSandboxImages('a1:s1');
  const [workingDir, setWorkingDir] = useState('');
  return (
    <SandboxImageComposition
      context={ctx}
      draft={draft}
      images={images}
      workingDir={workingDir}
      onWorkingDirChange={setWorkingDir}
    />
  );
}

describe('Sandbox image composition', () => {
  let surface: MockPluginSurface;
  let release: () => void;

  beforeEach(() => {
    api.imageCacheStatuses.mockReset();
    api.imageCacheStatuses.mockResolvedValue([{ digest: DIGEST, state: 'verified' }]);
    surface = createMockPluginSurface();
    release = imagesApi.install(surface);
  });

  afterEach(() => release());

  it('adds a pinned base image and observes the Agent cache separately', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('sandbox-image-add-open'));
    await waitFor(() => expect(surface.requests[0]?.type).toBe('server.image.list'));
    surface.resolveNext('server.image.list', { images: [image()], total: 1 });
    await screen.findByText('base-runtime');
    await userEvent.click(screen.getByTestId('sandbox-image-row'));
    await userEvent.click(screen.getByTestId('sandbox-image-add'));

    await screen.findByTestId('sandbox-image-selection');
    expect(screen.getByText('Base Runtime · /')).toBeInTheDocument();
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('sandbox-image-cache')).toHaveTextContent('Agent verified'),
    );
    expect(api.imageCacheStatuses).toHaveBeenCalledWith('a1:s1', [DIGEST]);
  });

  it('disables new images when the Agent does not support composition', async () => {
    render(<Harness status="unavailable" />);
    expect(screen.getByTestId('sandbox-image-add-open')).toBeDisabled();
    expect(screen.getByTestId('sandbox-image-unsupported')).toBeInTheDocument();
  });
});
