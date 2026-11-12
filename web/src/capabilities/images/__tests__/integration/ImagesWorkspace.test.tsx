import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import { ImagesWorkspace } from '../../components/ImagesWorkspace';
import { imagesApi, type ImageDescriptor } from '../../ImagesPlugin';

function image(index: number): ImageDescriptor {
  return {
    image_id: `image-${index}`,
    digest: `sha256:${index.toString(16).padStart(64, '0')}`,
    size_bytes: 4096 + index,
    source: { kind: 'local_directory', path: `/var/lib/nession/${index}` },
    packaging: {
      compression: 'none',
      block_size: 4096,
      fixed_timestamp: 0,
      fixed_uuid: '11111111-1111-4111-8111-111111111111',
    },
    status: 'ready',
    alias: `image-${index}`,
    aliases: [`image-${index}`],
    created_at: 100 + index,
    updated_at: 200 + index,
  };
}

function runningBuild() {
  return {
    build_id: 'build-fixture-running',
    image_id: 'image-build-fixture-running',
    attempt: 1,
    source: {
      kind: 'github' as const,
      repository_url: 'https://github.com/BestNathan/nession',
      ref: 'main',
    },
    packaging: {
      compression: 'none',
      block_size: 4096,
      fixed_timestamp: 0,
      fixed_uuid: '11111111-1111-4111-8111-111111111111',
    },
    status: 'running' as const,
    stage: 'packaging' as const,
    progress: { files: 214, bytes: 2_400_000, elapsed_ms: 1500 },
    size_bytes: 0,
    deduplicated: false,
    alias: 'nightly',
    created_at: 1,
    updated_at: 2,
  };
}

function context(experience: 'web' | 'app' = 'web'): WorkspaceContext {
  return {
    session: null,
    agent: undefined,
    agents: [],
    domain: null,
    fileOps: null,
    experience,
    onToolChange: () => undefined,
  };
}

function resolveEmptyBuilds(surface: MockPluginSurface): void {
  surface.resolveNext('server.image.build.list', { builds: [], total: 0 });
}

function imageListRequest(surface: MockPluginSurface) {
  return surface.requests.find((request) => request.type === 'server.image.list');
}

describe('Images Workspace capability', () => {
  let surface: MockPluginSurface;
  let release: () => void;

  beforeEach(() => {
    surface = createMockPluginSurface();
    release = imagesApi.install(surface);
  });

  afterEach(() => {
    release();
  });

  it('reads one complete-inventory page and inspects the first image without a Session', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    const request = imageListRequest(surface);
    expect(request?.payload).toEqual({ offset: 0, limit: 50, query: '' });
    surface.resolveNext('server.image.list', {
      images: [image(1), image(2)],
      total: 235,
      next_offset: 50,
    });
    await screen.findByText('image-1');
    expect(screen.getByTestId('images-page-label')).toHaveTextContent('1–2 of 235');
    const detail = await screen.findByTestId('images-detail');
    expect(detail).toHaveTextContent('sha256:');
    expect(detail).toHaveTextContent('Server-owned immutable image');
  });

  it('pages forward and searches through the Server registry', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.list', {
      images: [image(1)],
      total: 235,
      next_offset: 50,
    });
    await screen.findByText('image-1');
    await waitFor(() => expect(screen.getByTestId('images-next')).toBeEnabled());
    await userEvent.click(screen.getByTestId('images-next'));
    await waitFor(() =>
      expect(imageListRequest(surface)?.payload).toEqual({ offset: 50, limit: 50, query: '' }),
    );
    surface.resolveNext('server.image.list', {
      images: [image(51)],
      total: 235,
      next_offset: 100,
    });
    await screen.findByText('image-51');
    expect(screen.getByTestId('images-page-label')).toHaveTextContent('51–51 of 235');

    fireEvent.change(screen.getByTestId('images-search'), { target: { value: 'node' } });
    await waitFor(() => {
      expect(imageListRequest(surface)?.payload).toEqual({
        offset: 0,
        limit: 50,
        query: 'node',
      });
    });
    surface.resolveNext('server.image.list', {
      images: [image(2)],
      total: 1,
    });
    await screen.findByText('image-2');
    expect(screen.getByTestId('images-page-label')).toHaveTextContent('1–1 of 1');
  });

  it('shows a truthful empty registry', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    await waitFor(() => expect(surface.requests).toHaveLength(2));
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.list', { images: [], total: 0 });
    await screen.findByTestId('images-empty');
    expect(screen.getByTestId('images-page-label')).toHaveTextContent('0 images');
  });

  it('shows a failed registry read', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    await waitFor(() => expect(surface.requests).toHaveLength(2));
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.list', {
      images: [],
      total: 0,
      error: 'Registry unavailable',
    });
    await screen.findByTestId('images-error');
    expect(screen.getByText('Registry unavailable')).toBeInTheDocument();
  });

  it('pushes one App detail depth and leaves it back to the list', async () => {
    const pushes: ({ title: string; onLeave: () => void } | null)[] = [];
    const depth = {
      setPush: (push: { title: string; onLeave: () => void } | null) => {
        pushes.push(push);
      },
    };
    render(<ImagesWorkspace ctx={context('app')} depth={depth} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.list', {
      images: [image(1), image(2)],
      total: 2,
    });
    await screen.findByText('image-1');
    expect(screen.queryByTestId('images-detail')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('image-1'));
    expect(pushes[pushes.length - 1]?.title).toBe('image-1');
    expect(screen.getByTestId('images-detail')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /All images/ }));
    expect(pushes[pushes.length - 1]).toBeNull();
    expect(screen.queryByTestId('images-detail')).not.toBeInTheDocument();
  });

  it('observes a running durable build, cancels it and offers retry', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    surface.resolveNext('server.image.list', { images: [], total: 0 });
    surface.resolveNext('server.image.build.list', {
      builds: [runningBuild()],
      total: 1,
    });
    const row = await screen.findByTestId('image-build-row');
    expect(row).toHaveTextContent('Building');
    expect(screen.getByTestId('image-build-stage')).toHaveTextContent(
      'Packaging with mkfs.erofs',
    );
    expect(screen.getByTestId('image-build-progress')).toHaveTextContent('214 files');
    expect(screen.getByTestId('image-build-progress')).toHaveTextContent('2,400,000 bytes');
    expect(screen.getByTestId('image-build-progress')).not.toHaveTextContent('%');

    await userEvent.click(screen.getByTestId('image-build-cancel'));
    const cancel = surface.requests.find(
      (request) => request.type === 'server.image.build.cancel',
    );
    expect(cancel?.payload).toEqual({ build_id: runningBuild().build_id });
    surface.resolveNext('server.image.build.cancel', {
      success: true,
      build: { ...runningBuild(), status: 'canceled', stage: null },
    });
    await waitFor(() =>
      expect(screen.getByTestId('image-build-status')).toHaveTextContent('Canceled'),
    );
    expect(screen.getByTestId('image-build-retry')).toBeInTheDocument();
  });

  it('re-reads the durable build inventory after a reconnect', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.list', { images: [], total: 0 });
    await screen.findByTestId('images-empty');
    surface.setConnectionState('reconnecting');
    surface.setConnectionState('connected');
    // The mock drops settled requests, so a new pending inventory read is the
    // observable re-read after the reconnect.
    await waitFor(() =>
      expect(
        surface.requests.filter((request) => request.type === 'server.image.build.list'),
      ).toHaveLength(1),
    );
    surface.resolveNext('server.image.build.list', {
      builds: [runningBuild()],
      total: 1,
    });
    await screen.findByTestId('image-build-row');
  });
});
