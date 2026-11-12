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
    expect(surface.requests[0]?.type).toBe('server.image.list');
    expect(surface.requests[0]?.payload).toEqual({ offset: 0, limit: 50, query: '' });
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
    surface.resolveNext('server.image.list', {
      images: [image(1)],
      total: 235,
      next_offset: 50,
    });
    await screen.findByText('image-1');
    await waitFor(() => expect(screen.getByTestId('images-next')).toBeEnabled());
    await userEvent.click(screen.getByTestId('images-next'));
    await waitFor(() =>
      expect(surface.requests[0]?.payload).toEqual({ offset: 50, limit: 50, query: '' }),
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
      expect(surface.requests[0]?.payload).toEqual({
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
    await waitFor(() => expect(surface.requests).toHaveLength(1));
    surface.resolveNext('server.image.list', { images: [], total: 0 });
    await screen.findByTestId('images-empty');
    expect(screen.getByTestId('images-page-label')).toHaveTextContent('0 images');
  });

  it('shows a failed registry read', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    await waitFor(() => expect(surface.requests).toHaveLength(1));
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
});
