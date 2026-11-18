import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SandboxCapabilityCatalog,
  SandboxCurrentContext,
  SandboxImplementationSupport,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import {
  imagesApi,
  type ImageDescriptor,
  type ImageLibraryEntry,
} from '@/capabilities/images';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import { useSandboxDraft } from '../../hooks/useSandboxDraft';
import { SandboxFilesystemFields } from '../../components/SandboxFilesystemFields';
import { sandboxApi } from '../../SandboxPlugin';

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

function libraryEntry(
  descriptor: ImageDescriptor,
  imageKind: string,
): ImageLibraryEntry {
  return {
    image: descriptor,
    repository: 'nession/fixtures',
    tags: [],
    manifest_digest: null,
    media_type: null,
    kind: null,
    image_kind: imageKind,
    mount_default: imageKind === 'tool' ? '/opt/fixture' : null,
    platform: 'linux/amd64',
    representation: 'single_layer',
    layers: [],
    closure: [],
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
      targetPlatform="linux/amd64"
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
  let releaseSandbox: () => void;

  beforeEach(() => {
    workspaceApiMock.list.mockReset();
    workspaceApiMock.list.mockResolvedValue([]);
    surface = createMockPluginSurface();
    release = imagesApi.install(surface);
    releaseSandbox = sandboxApi.install(surface);
  });

  afterEach(() => {
    release();
    releaseSandbox();
  });

  async function chooseRootfs(images: ImageDescriptor[]) {
    await userEvent.click(screen.getByTestId('sandbox-rootfs-image'));
    await waitFor(() =>
      expect(surface.requests[0]?.type).toBe('server.image.library.list'),
    );
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: images.map((descriptor) => libraryEntry(descriptor, 'base_runtime')),
      total: images.length,
    });
    await screen.findByText(images[0].aliases[0]);
    await userEvent.click(screen.getByTestId('sandbox-image-row'));
    await userEvent.click(screen.getByTestId('sandbox-image-select-submit'));
    await screen.findByTestId('sandbox-rootfs-selected');
  }

  it('projects role, platform and Agent cache, and refuses a mismatched or referenced image', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('sandbox-rootfs-image'));
    await waitFor(() =>
      expect(surface.requests[0]?.type).toBe('server.image.library.list'),
    );
    const base = libraryEntry(image('base', DIGEST, 'base-runtime'), 'base_runtime');
    const tool = libraryEntry(image('tool', `sha256:${'b'.repeat(64)}`, 'rust-toolchain'), 'tool');
    const referenced = {
      ...libraryEntry(image('composite', `sha256:${'c'.repeat(64)}`, 'composite'), 'base_runtime'),
      representation: 'referenced' as const,
    };
    const wrongPlatform = {
      ...libraryEntry(image('arm', `sha256:${'d'.repeat(64)}`, 'arm-base'), 'base_runtime'),
      platform: 'linux/arm64',
    };
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [base, tool, referenced, wrongPlatform],
      total: 4,
    });
    await screen.findByText('base-runtime');
    const rows = await screen.findAllByTestId('sandbox-image-row');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBeEnabled();
    expect(rows[0]).toHaveAttribute('data-image-role', 'base_runtime');
    expect(rows[1]).toBeDisabled();
    expect(rows[1]).toHaveTextContent('Not a Base Runtime image (Toolchain)');
    expect(rows[2]).toBeDisabled();
    expect(rows[2]).toHaveTextContent('Referenced composite images are not executable');
    expect(rows[3]).toBeDisabled();
    expect(rows[3]).toHaveTextContent('does not match this Agent (linux/amd64)');

    // The Agent cache phase is observed for this Session's Agent, separately
    // from the Server Ready badge.
    const cacheRequest = surface.requests.find(
      (request) => request.type === 'server.session.sandbox.context',
    );
    expect(cacheRequest?.payload.cache_digests).toEqual([
      DIGEST,
      `sha256:${'b'.repeat(64)}`,
      `sha256:${'c'.repeat(64)}`,
      `sha256:${'d'.repeat(64)}`,
    ]);
    surface.resolveNext('server.session.sandbox.context', {
      success: true,
      context: context(),
      cache_statuses: [],
      cache_observations: [
        {
          contract_version: 1,
          digest: DIGEST,
          phase: 'resumable',
          downloaded_bytes: 524_288,
          total_bytes: 4_194_304,
          active: false,
          updated_at: 1,
        },
      ],
    });
    await waitFor(() =>
      expect(rows[0]).toHaveTextContent('Resumable partial'),
    );
    expect(rows[0]).toHaveTextContent('Server Ready');
  });

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
      expect(
        surface.requests.some(
          (request) => request.type === 'server.image.library.list',
        ),
      ).toBe(true),
    );
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [libraryEntry(image('tool', TOOL_DIGEST, 'rust-toolchain'), 'tool')],
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

  it('declares an auto or Project Location Workspace only under an image RootFS', async () => {
    render(<Harness />);
    await screen.findByText(/requires an image RootFS/);
    expect(screen.getByTestId('sandbox-workspace-auto')).toBeDisabled();
    expect(screen.getByTestId('sandbox-workspace-project')).toBeDisabled();

    await chooseRootfs([image('base', DIGEST, 'base-runtime')]);
    await userEvent.click(screen.getByTestId('sandbox-workspace-auto'));
    expect(screen.getByTestId('sandbox-filesystem-preview-workspace')).toHaveTextContent(
      'Auto by Session name',
    );

    await userEvent.click(screen.getByTestId('sandbox-workspace-project'));
    expect(screen.getByTestId('sandbox-filesystem-preview-workspace')).toHaveTextContent(
      'Project Location',
    );
    expect(screen.getByTestId('sandbox-workspace-project-selected')).toBeVisible();
    await userEvent.click(screen.getByTestId('sandbox-workspace-project-clear'));
    expect(screen.queryByTestId('sandbox-workspace-project-selected')).not.toBeInTheDocument();
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
