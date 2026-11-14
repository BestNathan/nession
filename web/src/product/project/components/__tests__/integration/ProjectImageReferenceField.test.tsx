import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  imagesApi,
  type ImageBuildDescriptor,
  type ImageDescriptor,
} from '@/capabilities/images';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import { ProjectImageReferenceField } from '../../ProjectImageReferenceField';
import type { ProjectDraft } from '../../../types';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const BUILT = `sha256:${'b'.repeat(64)}`;

function image(digest = DIGEST, alias = 'workspace-runtime'): ImageDescriptor {
  return {
    image_id: 'image-project',
    digest,
    size_bytes: 4096,
    source: { kind: 'local_directory', path: '/var/lib/nession/base' },
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

function build(overrides: Partial<ImageBuildDescriptor> = {}): ImageBuildDescriptor {
  return {
    build_id: 'build-123e4567-e89b-42d3-a456-426614174000',
    image_id: 'image-123e4567-e89b-42d3-a456-426614174000',
    attempt: 1,
    source: {
      kind: 'github',
      repository_url: 'https://github.com/BestNathan/nession',
      ref: 'main',
    },
    packaging: {
      compression: 'none',
      block_size: 4096,
      fixed_timestamp: 0,
      fixed_uuid: '11111111-1111-4111-8111-111111111111',
    },
    status: 'running',
    stage: 'packaging',
    progress: { files: 12, bytes: 4096, elapsed_ms: 1200 },
    size_bytes: 0,
    deduplicated: false,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

const draft: ProjectDraft = {
  name: 'Nession',
  source: { repository_url: 'https://github.com/BestNathan/nession', ref: 'main' },
  locations: [],
  image_digest: undefined,
};

describe('Project image reference field', () => {
  let surface: MockPluginSurface;
  let release: () => void;

  beforeEach(() => {
    surface = createMockPluginSurface();
    release = imagesApi.install(surface);
  });

  afterEach(() => release());

  it('selects one Project image through its own selector', async () => {
    let changed: ProjectDraft | null = null;
    render(
      <ProjectImageReferenceField
        draft={draft}
        onChange={(next) => {
          changed = next;
        }}
        disabled={false}
      />,
    );
    // The field recovers any durable build for the draft source on mount.
    expect(surface.requests[0]?.type).toBe('server.image.build.list');
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });
    await userEvent.click(screen.getByTestId('project-image-choose'));
    const list = surface.requests.find((request) => request.type === 'server.image.list');
    expect(list?.payload).toEqual({ offset: 0, limit: 50, query: '' });
    surface.resolveNext('server.image.list', {
      images: [image()],
      total: 1,
    });
    await screen.findByText('workspace-runtime');
    await userEvent.click(screen.getByTestId('project-image-use'));
    expect(changed).toEqual({ ...draft, image_digest: DIGEST });
  });

  it('submits an asynchronous build and requires an explicit Use this image', async () => {
    let changed: ProjectDraft | null = null;
    render(
      <ProjectImageReferenceField
        draft={{ ...draft, image_digest: DIGEST }}
        onChange={(next) => {
          changed = next;
        }}
        disabled={false}
      />,
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });
    await userEvent.click(screen.getByTestId('project-image-build'));
    const submitted = surface.requests.find(
      (request) => request.type === 'server.image.build.submit',
    );
    expect(submitted?.payload).toEqual({
      source: {
        kind: 'github',
        repository_url: 'https://github.com/BestNathan/nession',
        ref: 'main',
      },
    });
    surface.resolveNext('server.image.build.submit', {
      success: true,
      build: build(),
    });
    // The durable record reports a real stage and measured counts while active.
    await screen.findByTestId('project-image-build-progress');
    expect(screen.getByTestId('project-image-build-progress')).toHaveTextContent(
      'Packaging with mkfs.erofs',
    );
    expect(screen.getByTestId('project-image-build-progress-detail')).toHaveTextContent(
      '12 files',
    );
    expect(changed).toBeNull();

    // A pushed transition completes the durable record.
    surface.pushMessage('server.image.build.updated', {
      build: build({
        status: 'succeeded',
        stage: null,
        digest: BUILT,
        size_bytes: 4096,
      }),
    });
    await waitFor(() =>
      expect(
        surface.requests.some((request) => request.type === 'server.image.get'),
      ).toBe(true),
    );
    surface.resolveNext('server.image.get', {
      success: true,
      image: image(BUILT, 'nession-web-build'),
    });
    await screen.findByTestId('project-image-build-result');
    await userEvent.click(screen.getByTestId('project-image-use-build'));
    expect(changed).toEqual({
      ...draft,
      image_digest: BUILT,
    });
  });

  it('preserves the old reference when the durable build fails', async () => {
    let changed: ProjectDraft | null = null;
    render(
      <ProjectImageReferenceField
        draft={{ ...draft, image_digest: DIGEST }}
        onChange={(next) => {
          changed = next;
        }}
        disabled={false}
      />,
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });
    await userEvent.click(screen.getByTestId('project-image-build'));
    surface.resolveNext('server.image.build.submit', {
      success: true,
      build: build(),
    });
    await screen.findByTestId('project-image-build-progress');
    surface.pushMessage('server.image.build.updated', {
      build: build({
        status: 'failed',
        stage: null,
        error: 'source could not be packaged',
      }),
    });
    await screen.findByTestId('project-image-build-error');
    expect(screen.getByTestId('project-image-build-error')).toHaveTextContent(
      'The current reference is unchanged',
    );
    expect(changed).toBeNull();
    expect(screen.getByTestId('project-image-digest-field')).toHaveTextContent(DIGEST);
    // A failed build is retryable through the same durable record.
    await userEvent.click(screen.getByTestId('project-image-build-retry'));
    const retried = surface.requests.find(
      (request) => request.type === 'server.image.build.retry',
    );
    expect(retried?.payload).toEqual({ build_id: build().build_id });
  });

  it('recovers an active durable build after a remount', async () => {
    const { unmount } = render(
      <ProjectImageReferenceField draft={draft} onChange={() => undefined} disabled={false} />,
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });
    unmount();
    render(
      <ProjectImageReferenceField draft={draft} onChange={() => undefined} disabled={false} />,
    );
    expect(surface.requests.some((request) => request.type === 'server.image.build.list')).toBe(
      true,
    );
    surface.resolveNext('server.image.build.list', {
      builds: [build()],
      total: 1,
    });
    await screen.findByTestId('project-image-build-progress');
    expect(screen.getByTestId('project-image-build-progress')).toHaveTextContent(
      'Packaging with mkfs.erofs',
    );
  });
});
