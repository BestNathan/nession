import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imagesApi, type ImageDescriptor } from '@/capabilities/images';
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
    await userEvent.click(screen.getByTestId('project-image-choose'));
    await waitFor(() => expect(surface.requests[0]?.type).toBe('server.image.list'));
    expect(surface.requests[0]?.payload).toEqual({ offset: 0, limit: 50, query: '' });
    surface.resolveNext('server.image.list', {
      images: [image()],
      total: 1,
    });
    await screen.findByText('workspace-runtime');
    await userEvent.click(screen.getByTestId('project-image-use'));
    expect(changed).toEqual({ ...draft, image_digest: DIGEST });
  });

  it('requires an explicit Use this image after a successful Git build', async () => {
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
    await userEvent.click(screen.getByTestId('project-image-build'));
    expect(surface.requests[0]?.type).toBe('server.image.build');
    surface.resolveNext('server.image.build', {
      success: true,
      image: image(BUILT, 'nession-web-build'),
    });
    await screen.findByTestId('project-image-build-result');
    expect(changed).toBeNull();
    await userEvent.click(screen.getByTestId('project-image-use-build'));
    expect(changed).toEqual({
      ...draft,
      image_digest: BUILT,
    });
  });

  it('preserves the old reference when the build fails', async () => {
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
    await userEvent.click(screen.getByTestId('project-image-build'));
    surface.resolveNext('server.image.build', {
      success: false,
      error: 'source could not be packaged',
    });
    await screen.findByTestId('project-image-build-error');
    expect(screen.getByTestId('project-image-build-error')).toHaveTextContent(
      'The current reference is unchanged',
    );
    expect(changed).toBeNull();
    expect(screen.getByTestId('project-image-digest-field')).toHaveTextContent(DIGEST);
  });
});
