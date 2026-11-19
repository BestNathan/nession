import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  imagesApi,
  type ImageBuildDescriptor,
  type ImageDescriptor,
  type ImageLibraryEntry,
} from '@/capabilities/images';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import { ProjectImageReferenceField } from '../../ProjectImageReferenceField';
import type { ProjectDraft } from '../../../types';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const BUILT = `sha256:${'b'.repeat(64)}`;
const SOURCE_A = 'https://github.com/BestNathan/nession';
const SOURCE_B = 'https://github.com/BestNathan/other';
const BUILD_B_ID = 'build-223e4567-e89b-42d3-a456-426614174000';

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
    mount_default: null,
    platform: 'linux/amd64',
    representation: 'single_layer',
    layers: [],
    closure: [],
  };
}

const draft: ProjectDraft = {
  name: 'Nession',
  source: { repository_url: 'https://github.com/BestNathan/nession', ref: 'main' },
  locations: [],
  envProfileIds: [],
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
    const list = surface.requests.find(
      (request) => request.type === 'server.image.library.list',
    );
    expect(list?.payload).toEqual({ offset: 0, limit: 50, query: '', repository: '' });
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [libraryEntry(image(), 'directory')],
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

  it('hides the previous source build and preserves the pinned digest after a source switch', async () => {
    let changed: ProjectDraft | null = null;
    const { rerender } = render(
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

    rerender(
      <ProjectImageReferenceField
        draft={{ ...draft, source: { repository_url: SOURCE_B, ref: 'main' }, image_digest: DIGEST }}
        onChange={(next) => {
          changed = next;
        }}
        disabled={false}
      />,
    );

    // The old source's result and its explicit Use action disappear in the
    // same render as the source change; the pinned Project digest stays.
    expect(screen.queryByTestId('project-image-build-result')).toBeNull();
    expect(screen.queryByTestId('project-image-use-build')).toBeNull();
    expect(screen.getByTestId('project-image-digest-field')).toHaveTextContent(DIGEST);
    expect(changed).toBeNull();

    // The new source keeps its own build path.
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });
    await userEvent.click(screen.getByTestId('project-image-build'));
    const submitted = surface.requests.find(
      (request) => request.type === 'server.image.build.submit',
    );
    expect(submitted?.payload).toEqual({
      source: { kind: 'github', repository_url: SOURCE_B, ref: 'main' },
    });
    surface.resolveNext('server.image.build.submit', {
      success: true,
      build: build({
        build_id: BUILD_B_ID,
        source: { kind: 'github', repository_url: SOURCE_B, ref: 'main' },
      }),
    });
    await screen.findByTestId('project-image-build-progress');
    expect(screen.getByTestId('project-image-build-progress')).toHaveAttribute(
      'data-build-id',
      BUILD_B_ID,
    );
  });

  it('ignores a submit that settles after the source changed', async () => {
    let changed: ProjectDraft | null = null;
    const { rerender } = render(
      <ProjectImageReferenceField
        draft={draft}
        onChange={(next) => {
          changed = next;
        }}
        disabled={false}
      />,
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });
    await userEvent.click(screen.getByTestId('project-image-build'));

    rerender(
      <ProjectImageReferenceField
        draft={{ ...draft, source: { repository_url: SOURCE_B, ref: 'main' } }}
        onChange={(next) => {
          changed = next;
        }}
        disabled={false}
      />,
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });

    // A's deferred submission settles only after B owns the field.
    surface.resolveNext('server.image.build.submit', {
      success: true,
      build: build(),
    });
    await act(async () => {});
    expect(screen.queryByTestId('project-image-build-progress')).toBeNull();
    expect(screen.queryByTestId('project-image-build-result')).toBeNull();
    expect(screen.queryByTestId('project-image-build-submit-error')).toBeNull();
    expect(
      surface.requests.some((request) => request.type === 'server.image.get'),
    ).toBe(false);
    expect(screen.getByTestId('project-image-build')).toHaveTextContent(
      'Build from Git Source',
    );

    // B's own submission still works after the stale completion.
    await userEvent.click(screen.getByTestId('project-image-build'));
    const submitted = surface.requests.find(
      (request) => request.type === 'server.image.build.submit',
    );
    expect(submitted?.payload).toEqual({
      source: { kind: 'github', repository_url: SOURCE_B, ref: 'main' },
    });
    surface.resolveNext('server.image.build.submit', {
      success: true,
      build: build({
        build_id: BUILD_B_ID,
        source: { kind: 'github', repository_url: SOURCE_B, ref: 'main' },
      }),
    });
    await screen.findByTestId('project-image-build-progress');
    expect(screen.getByTestId('project-image-build-progress')).toHaveAttribute(
      'data-build-id',
      BUILD_B_ID,
    );
    expect(changed).toBeNull();
  });

  it('ignores a recovery that settles after the source changed', async () => {
    const { rerender } = render(
      <ProjectImageReferenceField draft={draft} onChange={() => undefined} disabled={false} />,
    );
    rerender(
      <ProjectImageReferenceField
        draft={{ ...draft, source: { repository_url: SOURCE_B, ref: 'main' } }}
        onChange={() => undefined}
        disabled={false}
      />,
    );

    // The first pending list belongs to A and must not be shown under B.
    surface.resolveNext('server.image.build.list', {
      builds: [
        build({
          status: 'succeeded',
          stage: null,
          digest: BUILT,
          size_bytes: 4096,
        }),
      ],
      total: 1,
    });
    await act(async () => {});
    expect(screen.queryByTestId('project-image-build-result')).toBeNull();
    expect(screen.queryByTestId('project-image-build-loading')).toBeNull();
    expect(
      surface.requests.some((request) => request.type === 'server.image.get'),
    ).toBe(false);

    // B recovers its own durable build independently.
    surface.resolveNext('server.image.build.list', {
      builds: [
        build({
          build_id: BUILD_B_ID,
          source: { kind: 'github', repository_url: SOURCE_B, ref: 'main' },
        }),
      ],
      total: 1,
    });
    await screen.findByTestId('project-image-build-progress');
    expect(screen.getByTestId('project-image-build-progress')).toHaveAttribute(
      'data-build-id',
      BUILD_B_ID,
    );
  });

  it('ignores an image descriptor that settles after the source changed', async () => {
    let changed: ProjectDraft | null = null;
    const { rerender } = render(
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
      build: build({
        status: 'succeeded',
        stage: null,
        digest: BUILT,
        size_bytes: 4096,
      }),
    });
    await screen.findByTestId('project-image-build-loading');

    rerender(
      <ProjectImageReferenceField
        draft={{ ...draft, source: { repository_url: SOURCE_B, ref: 'main' }, image_digest: DIGEST }}
        onChange={(next) => {
          changed = next;
        }}
        disabled={false}
      />,
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });

    // A's descriptor arrives after the switch and must not offer its digest.
    surface.resolveNext('server.image.get', {
      success: true,
      image: image(BUILT, 'nession-web-build'),
    });
    await act(async () => {});
    expect(screen.queryByTestId('project-image-build-result')).toBeNull();
    expect(screen.queryByTestId('project-image-use-build')).toBeNull();
    expect(screen.getByTestId('project-image-digest-field')).toHaveTextContent(DIGEST);
    expect(changed).toBeNull();
  });

  it('ignores a cancel completion that settles after the source changed', async () => {
    const { rerender } = render(
      <ProjectImageReferenceField draft={draft} onChange={() => undefined} disabled={false} />,
    );
    surface.resolveNext('server.image.build.list', {
      builds: [build()],
      total: 1,
    });
    await screen.findByTestId('project-image-build-progress');
    await userEvent.click(screen.getByTestId('project-image-build-cancel'));

    rerender(
      <ProjectImageReferenceField
        draft={{ ...draft, source: { repository_url: SOURCE_B, ref: 'main' } }}
        onChange={() => undefined}
        disabled={false}
      />,
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });

    surface.resolveNext('server.image.build.cancel', {
      success: true,
      build: build({ status: 'canceled', stage: null }),
    });
    await act(async () => {});
    expect(screen.queryByTestId('project-image-build-progress')).toBeNull();
    expect(screen.queryByTestId('project-image-build-submit-error')).toBeNull();
  });

  it('ignores a retry completion that settles after the source changed', async () => {
    const { rerender } = render(
      <ProjectImageReferenceField draft={draft} onChange={() => undefined} disabled={false} />,
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
    await userEvent.click(screen.getByTestId('project-image-build-retry'));

    rerender(
      <ProjectImageReferenceField
        draft={{ ...draft, source: { repository_url: SOURCE_B, ref: 'main' } }}
        onChange={() => undefined}
        disabled={false}
      />,
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });

    surface.resolveNext('server.image.build.retry', {
      success: true,
      build: build(),
    });
    await act(async () => {});
    expect(screen.queryByTestId('project-image-build-progress')).toBeNull();
    expect(screen.queryByTestId('project-image-build-submit-error')).toBeNull();
  });

  it('ignores a pushed update for the previous source build', async () => {
    const { rerender } = render(
      <ProjectImageReferenceField draft={draft} onChange={() => undefined} disabled={false} />,
    );
    surface.resolveNext('server.image.build.list', {
      builds: [build()],
      total: 1,
    });
    await screen.findByTestId('project-image-build-progress');

    rerender(
      <ProjectImageReferenceField
        draft={{ ...draft, source: { repository_url: SOURCE_B, ref: 'main' } }}
        onChange={() => undefined}
        disabled={false}
      />,
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });

    surface.pushMessage('server.image.build.updated', {
      build: build({
        status: 'succeeded',
        stage: null,
        digest: BUILT,
        size_bytes: 4096,
      }),
    });
    await act(async () => {});
    expect(screen.queryByTestId('project-image-build-result')).toBeNull();
    expect(screen.queryByTestId('project-image-build-loading')).toBeNull();
    expect(
      surface.requests.some((request) => request.type === 'server.image.get'),
    ).toBe(false);
  });

  it('recovers a durable build for an equivalent normalized source spelling', async () => {
    render(
      <ProjectImageReferenceField
        draft={{
          ...draft,
          source: { repository_url: `${SOURCE_A}.git/`, ref: ' main ' },
        }}
        onChange={() => undefined}
        disabled={false}
      />,
    );
    surface.resolveNext('server.image.build.list', {
      builds: [build()],
      total: 1,
    });
    await screen.findByTestId('project-image-build-progress');
    expect(screen.getByTestId('project-image-build-progress')).toHaveAttribute(
      'data-build-id',
      build().build_id,
    );
  });
});
