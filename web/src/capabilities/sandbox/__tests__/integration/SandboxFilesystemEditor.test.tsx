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
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import { useSandboxDraft } from '../../hooks/useSandboxDraft';
import { SandboxFilesystemFields } from '../../components/SandboxFilesystemFields';

const workspaceApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../WorkspacePlugin', () => ({
  workspaceApi: workspaceApiMock,
  WorkspacePlugin: class WorkspacePlugin {},
}));

const DIGEST = `sha256:${'a'.repeat(64)}`;
const TOOL_DIGEST = `sha256:${'b'.repeat(64)}`;

function catalog(): SandboxCapabilityCatalog {
  const implementation = (path: string): SandboxImplementationSupport => ({
    path,
    status: 'available',
  });
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
      implementation('filesystem.composition'),
    ],
    resource_fields: [],
    syscall_fields: [],
  };
}

function context(): SandboxCurrentContext {
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
    catalog: catalog(),
  };
}

function image(imageId: string, digest: string, alias: string): ImageDescriptor {
  return {
    image_id: imageId,
    digest,
    size_bytes: 4096,
    source: { kind: 'local_directory', path: `/var/lib/nession/${imageId}` },
    packaging: {
      compression: 'none',
      block_size: 4096,
      fixed_timestamp: 0,
      fixed_uuid: '11111111-1111-4111-8111-111111111111',
    },
    status: 'ready',
    alias,
    aliases: [alias],
    created_at: 1,
    updated_at: 2,
  };
}

function Harness() {
  const ctx = context();
  const draft = useSandboxDraft(ctx);
  const [workingDir, setWorkingDir] = useState('');
  return (
    <SandboxFilesystemFields
      context={ctx}
      sessionId="a1:s1"
      draft={draft}
      workingDir={workingDir}
      workingDirError={undefined}
      onWorkingDirChange={setWorkingDir}
      observations={new Map()}
    />
  );
}

describe('Sandbox Filesystem editor', () => {
  let surface: MockPluginSurface;
  let release: () => void;

  beforeEach(() => {
    workspaceApiMock.list.mockReset();
    workspaceApiMock.list.mockResolvedValue([]);
    surface = createMockPluginSurface();
    release = imagesApi.install(surface);
  });

  afterEach(() => release());

  async function chooseRootfs(images: ImageDescriptor[]) {
    await userEvent.click(screen.getByTestId('sandbox-rootfs-image'));
    await waitFor(() => expect(surface.requests[0]?.type).toBe('server.image.list'));
    surface.resolveNext('server.image.list', { images, total: images.length });
    await screen.findByText(images[0].aliases[0]);
    await userEvent.click(screen.getByTestId('sandbox-image-row'));
    await userEvent.click(screen.getByTestId('sandbox-image-select-submit'));
    await screen.findByTestId('sandbox-rootfs-selected');
  }

  it('declares one Base Runtime RootFS and previews the mapping', async () => {
    render(<Harness />);
    await chooseRootfs([image('base', DIGEST, 'base-runtime')]);
    expect(screen.getByTestId('sandbox-filesystem-preview-rootfs')).toHaveTextContent('/');
    expect(screen.getByTestId('sandbox-filesystem-preview-rootfs')).toHaveTextContent(DIGEST);

    // Selecting Local replaces the image root without removing access rows.
    await userEvent.click(screen.getByTestId('sandbox-rootfs-local'));
    expect(screen.queryByTestId('sandbox-rootfs-selected')).not.toBeInTheDocument();
  });

  it('adds one read-only mount at a validated /opt target', async () => {
    render(<Harness />);
    await chooseRootfs([image('base', DIGEST, 'base-runtime')]);
    await userEvent.click(screen.getByTestId('sandbox-mount-add'));
    await waitFor(() =>
      expect(surface.requests.some((request) => request.type === 'server.image.list')).toBe(
        true,
      ),
    );
    surface.resolveNext('server.image.list', {
      images: [image('tool', TOOL_DIGEST, 'rust-toolchain')],
      total: 1,
    });
    await screen.findByText('rust-toolchain');
    await userEvent.click(screen.getByTestId('sandbox-image-row'));
    await userEvent.clear(screen.getByTestId('sandbox-mount-target'));
    await userEvent.type(screen.getByTestId('sandbox-mount-target'), '/opt/rust');
    await userEvent.click(screen.getByTestId('sandbox-image-select-submit'));

    await screen.findByTestId('sandbox-mount-row');
    expect(screen.getByTestId('sandbox-filesystem-preview-mount-0')).toHaveTextContent(
      '/opt/rust',
    );
    expect(screen.getByTestId('sandbox-filesystem-preview-mount-0')).toHaveTextContent(
      'read-only',
    );
  });

  it('declares an auto Workspace only under an image RootFS', async () => {
    render(<Harness />);
    await screen.findByText(/requires an image RootFS/);
    expect(screen.getByTestId('sandbox-workspace-auto')).toBeDisabled();

    await chooseRootfs([image('base', DIGEST, 'base-runtime')]);
    await userEvent.click(screen.getByTestId('sandbox-workspace-auto'));
    expect(screen.getByTestId('sandbox-filesystem-preview-workspace')).toHaveTextContent(
      'Auto by Session name',
    );
  });

  it('blocks Enter-era access editing when an image root is declared', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('sandbox-fs-read-add'));
    await userEvent.type(screen.getByTestId('sandbox-fs-read-0'), '/usr');
    await chooseRootfs([image('base', DIGEST, 'base-runtime')]);

    expect(screen.getByTestId('sandbox-filesystem-access-conflict')).toBeVisible();
    expect(screen.queryByTestId('sandbox-fs-read-add')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('sandbox-filesystem-clear-access'));
    expect(screen.getByTestId('sandbox-fs-read-add')).toBeVisible();
  });
});
