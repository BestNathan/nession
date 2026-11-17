import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import { ImagesWorkspace } from '../../components/ImagesWorkspace';
import {
  imagesApi,
  type ImageDescriptor,
  type ImageLibraryEntry,
} from '../../ImagesPlugin';

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

function libraryEntry(index: number): ImageLibraryEntry {
  const descriptor = image(index);
  const manifest = `sha256:${(900 + index).toString(16).padStart(64, '0')}`;
  return {
    image: descriptor,
    repository: 'nession/fixtures',
    tags: [`image-${index}`],
    manifest_digest: manifest,
    media_type: 'application/vnd.oci.image.manifest.v1+json',
    kind: 'manifest',
    platform: 'linux/amd64',
    representation: 'single_layer',
    layers: [
      {
        digest: descriptor.digest ?? '',
        media_type: 'application/vnd.nession.erofs.layer.v1',
        size_bytes: descriptor.size_bytes,
        role: 'layer',
      },
    ],
    closure: descriptor.digest ? [descriptor.digest] : [],
    impact: {
      manifest_digest: manifest,
      project_pins: 0,
      session_pins: 0,
      other_tags: [],
      leases: 0,
      compose_references: 0,
      unknown: false,
    },
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
  return surface.requests.find((request) => request.type === 'server.image.library.list');
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
    expect(request?.payload).toEqual({ offset: 0, limit: 50, query: '', repository: '' });
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [libraryEntry(1), libraryEntry(2)],
      total: 235,
      next_offset: 50,
    });
    await screen.findByText('image-1');
    expect(screen.getByTestId('images-page-label')).toHaveTextContent('1–2 of 235');
    await userEvent.click(screen.getAllByTestId('image-row')[0]);
    const detail = await screen.findByTestId('images-detail');
    expect(detail).toHaveTextContent('sha256:');
    expect(detail).toHaveTextContent('Server-owned immutable image');
  });

  it('pages forward and searches through the Server registry', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [libraryEntry(1)],
      total: 235,
      next_offset: 50,
    });
    await screen.findByText('image-1');
    await waitFor(() => expect(screen.getByTestId('images-next')).toBeEnabled());
    await userEvent.click(screen.getByTestId('images-next'));
    await waitFor(() =>
      expect(imageListRequest(surface)?.payload).toEqual({
        offset: 50,
        limit: 50,
        query: '',
        repository: '',
      }),
    );
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [libraryEntry(51)],
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
        repository: '',
      });
    });
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [libraryEntry(2)],
      total: 1,
    });
    await screen.findByText('image-2');
    expect(screen.getByTestId('images-page-label')).toHaveTextContent('1–1 of 1');
  });

  it('shows a truthful empty registry', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    await waitFor(() => expect(surface.requests).toHaveLength(2));
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [],
      total: 0,
    });
    await screen.findByTestId('images-empty');
    expect(screen.getByTestId('images-page-label')).toHaveTextContent('0 images');
  });

  it('shows a failed registry read', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    await waitFor(() => expect(surface.requests).toHaveLength(2));
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.library.list', {
      success: false,
      entries: [],
      total: 0,
      error: 'Registry unavailable',
    });
    await screen.findByTestId('images-error');
    expect(screen.getByText('Registry unavailable')).toBeInTheDocument();
  });

  it('expands one Library row inline at a time without pushing history', async () => {
    render(<ImagesWorkspace ctx={context('app')} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [libraryEntry(1), libraryEntry(2)],
      total: 2,
    });
    await screen.findByText('image-1');
    expect(screen.queryByTestId('images-detail')).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByTestId('image-row')[0]);
    expect(screen.getByTestId('images-detail')).toHaveTextContent('image-1');
    expect(screen.getByTestId('image-detail-row')).toBeInTheDocument();

    // Opening another row closes the previous inline detail.
    await userEvent.click(screen.getAllByTestId('image-row')[1]);
    expect(screen.getByTestId('images-detail')).toHaveTextContent('image-2');
    expect(screen.getAllByTestId('image-detail-row')).toHaveLength(1);

    // Activating the same row again collapses it.
    await userEvent.click(screen.getAllByTestId('image-row')[1]);
    expect(screen.queryByTestId('images-detail')).not.toBeInTheDocument();
  });

  it('observes a running durable build, cancels it and offers retry', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [],
      total: 0,
    });
    surface.resolveNext('server.image.build.list', {
      builds: [runningBuild()],
      total: 1,
    });
    await userEvent.click(screen.getByTestId('images-section-builds'));
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

  it('refuses an invalid Build source without submitting a Server job', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.list', { images: [], total: 0 });
    await userEvent.click(screen.getByTestId('images-section-builds'));
    await screen.findByTestId('image-build-form');

    fireEvent.change(screen.getByTestId('image-build-repository'), {
      target: { value: 'https://gitlab.com/owner/repo' },
    });
    fireEvent.change(screen.getByTestId('image-build-ref'), { target: { value: '' } });
    await userEvent.click(screen.getByTestId('image-build-submit'));

    await screen.findByTestId('image-build-error-repository-url');
    expect(screen.getByTestId('image-build-error-ref')).toBeInTheDocument();
    expect(
      surface.requests.filter((request) => request.type === 'server.image.build.submit'),
    ).toHaveLength(0);
    // The draft is preserved rather than silently reset.
    expect(screen.getByTestId('image-build-repository')).toHaveValue(
      'https://gitlab.com/owner/repo',
    );
  });

  it('submits a canonical GitHub source with an alias', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.list', { images: [], total: 0 });
    await userEvent.click(screen.getByTestId('images-section-builds'));
    await screen.findByTestId('image-build-form');

    fireEvent.change(screen.getByTestId('image-build-repository'), {
      target: { value: ' https://github.com/BestNathan/nession.git ' },
    });
    fireEvent.change(screen.getByTestId('image-build-ref'), { target: { value: 'main' } });
    fireEvent.change(screen.getByTestId('image-build-alias'), {
      target: { value: 'nightly' },
    });
    await userEvent.click(screen.getByTestId('image-build-submit'));

    await waitFor(() => {
      expect(
        surface.requests.some((request) => request.type === 'server.image.build.submit'),
      ).toBe(true);
    });
    const submit = surface.requests.find(
      (request) => request.type === 'server.image.build.submit',
    );
    expect(submit?.payload).toEqual({
      source: {
        kind: 'github',
        repository_url: 'https://github.com/BestNathan/nession',
        ref: 'main',
      },
      alias: 'nightly',
    });
    surface.resolveNext('server.image.build.submit', {
      success: true,
      build: runningBuild(),
    });
    await waitFor(() =>
      expect(
        surface.requests.some((request) => request.type === 'server.image.build.list'),
      ).toBe(true),
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });
  });

  it('offers only supported adapters and validates a Directory path', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.list', { images: [], total: 0 });
    await userEvent.click(screen.getByTestId('images-section-builds'));
    await screen.findByTestId('image-build-form');

    expect(screen.getByTestId('image-build-source-github')).toBeInTheDocument();
    expect(screen.getByTestId('image-build-source-local_directory')).toBeInTheDocument();
    expect(screen.getByTestId('image-build-source-compose')).toBeInTheDocument();
    expect(screen.queryByTestId('image-build-source-archive')).not.toBeInTheDocument();
    expect(screen.queryByTestId('image-build-source-oci')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('image-build-source-local_directory'));
    fireEvent.change(screen.getByTestId('image-build-path'), {
      target: { value: 'relative/path' },
    });
    await userEvent.click(screen.getByTestId('image-build-submit'));
    await screen.findByTestId('image-build-error-path');
    expect(
      surface.requests.filter((request) => request.type === 'server.image.build.submit'),
    ).toHaveLength(0);

    fireEvent.change(screen.getByTestId('image-build-path'), {
      target: { value: '/srv/nession/sources/base' },
    });
    await userEvent.click(screen.getByTestId('image-build-submit'));
    await waitFor(() => {
      expect(
        surface.requests.some((request) => request.type === 'server.image.build.submit'),
      ).toBe(true);
    });
    const submit = surface.requests.find(
      (request) => request.type === 'server.image.build.submit',
    );
    expect(submit?.payload).toEqual({
      source: { kind: 'local_directory', path: '/srv/nession/sources/base' },
    });
    surface.resolveNext('server.image.build.submit', {
      success: true,
      build: runningBuild(),
    });
    await waitFor(() =>
      expect(
        surface.requests.some((request) => request.type === 'server.image.build.list'),
      ).toBe(true),
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });
  });

  it('composes flat and referenced sources with distinct validation', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.list', { images: [], total: 0 });
    await userEvent.click(screen.getByTestId('images-section-builds'));
    await screen.findByTestId('image-build-form');

    await userEvent.click(screen.getByTestId('image-build-source-compose'));
    fireEvent.change(screen.getByTestId('image-build-compose-repository'), {
      target: { value: 'base' },
    });
    fireEvent.change(screen.getByTestId('image-build-compose-ref'), {
      target: { value: 'latest' },
    });
    fireEvent.change(screen.getByTestId('image-build-compose-destination'), {
      target: { value: '' },
    });
    await userEvent.click(screen.getByTestId('image-build-compose-add'));
    const repositories = screen.getAllByTestId('image-build-compose-repository');
    fireEvent.change(repositories[1]!, { target: { value: 'tools' } });
    const references = screen.getAllByTestId('image-build-compose-ref');
    fireEvent.change(references[1]!, { target: { value: 'v1' } });
    const destinations = screen.getAllByTestId('image-build-compose-destination');
    fireEvent.change(destinations[1]!, { target: { value: '/opt/tools' } });

    await userEvent.click(screen.getByTestId('image-build-submit'));
    await waitFor(() => {
      expect(
        surface.requests.some((request) => request.type === 'server.image.build.submit'),
      ).toBe(true);
    });
    const submit = surface.requests.find(
      (request) => request.type === 'server.image.build.submit',
    );
    expect(submit?.payload).toEqual({
      source: {
        kind: 'compose',
        representation: 'flattened',
        sources: [
          { repository: 'base', ref: 'latest', destination: '' },
          { repository: 'tools', ref: 'v1', destination: '/opt/tools' },
        ],
      },
    });
    surface.resolveNext('server.image.build.submit', {
      success: true,
      build: runningBuild(),
    });
    await waitFor(() =>
      expect(
        surface.requests.some((request) => request.type === 'server.image.build.list'),
      ).toBe(true),
    );
    surface.resolveNext('server.image.build.list', { builds: [], total: 0 });

    // A successful submit resets the draft. Build the referenced shape
    // explicitly: choosing it clears destinations rather than submitting a
    // shape the Server refuses.
    await userEvent.click(screen.getByTestId('image-build-source-compose'));
    const fillRow = (index: number, repository: string, reference: string) => {
      fireEvent.change(screen.getAllByTestId('image-build-compose-repository')[index]!, {
        target: { value: repository },
      });
      fireEvent.change(screen.getAllByTestId('image-build-compose-ref')[index]!, {
        target: { value: reference },
      });
    };
    fillRow(0, 'base', 'latest');
    fireEvent.change(screen.getByTestId('image-build-compose-destination'), {
      target: { value: '/opt/base' },
    });
    await userEvent.click(screen.getByTestId('image-build-representation-referenced'));
    expect(screen.queryByTestId('image-build-compose-destination')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('image-build-compose-add'));
    fillRow(1, 'base', 'latest');
    await userEvent.click(screen.getByTestId('image-build-submit'));
    await screen.findByTestId('image-build-error-compose');
    expect(
      surface.requests.filter((request) => request.type === 'server.image.build.submit'),
    ).toHaveLength(0);
  });

  it('re-reads the durable build inventory after a reconnect', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [],
      total: 0,
    });
    await screen.findByTestId('images-empty');
    await userEvent.click(screen.getByTestId('images-section-builds'));
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

  it('creates a Tag and surfaces a CAS conflict with the current digest', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [libraryEntry(1)],
      total: 1,
    });
    await screen.findByText('image-1');
    await userEvent.click(screen.getAllByTestId('image-row')[0]);
    await userEvent.click(screen.getByTestId('images-tag-create'));
    fireEvent.change(screen.getByTestId('images-tag-name'), {
      target: { value: 'stable' },
    });
    await userEvent.click(screen.getByTestId('images-tag-confirm'));

    const request = surface.requests.find(
      (candidate) => candidate.type === 'server.image.tag.set',
    );
    expect(request?.payload).toEqual({
      repository: 'nession/fixtures',
      tag: 'stable',
      digest: libraryEntry(1).manifest_digest,
    });
    surface.resolveNext('server.image.tag.set', {
      success: false,
      error: 'tag conflict for nession/fixtures:stable',
      error_kind: 'conflict',
      current_digest: 'sha256:abcdef',
    });
    const conflict = await screen.findByTestId('images-tag-conflict');
    expect(conflict).toHaveTextContent('sha256:abcdef');
    expect(conflict).toHaveTextContent('review the operation again');
  });

  it('requires a reference-impact review before unlinking a Tag', async () => {
    render(<ImagesWorkspace ctx={context()} />);
    resolveEmptyBuilds(surface);
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [libraryEntry(1)],
      total: 1,
    });
    await screen.findByText('image-1');
    await userEvent.click(screen.getAllByTestId('image-row')[0]);
    await userEvent.click(screen.getByTestId('images-tag-remove-image-1'));

    const impactRequest = surface.requests.find(
      (candidate) => candidate.type === 'server.image.impact.get',
    );
    expect(impactRequest?.payload).toEqual({
      repository: 'nession/fixtures',
      tag: 'image-1',
    });
    const impact = {
      ...libraryEntry(1).impact,
      project_pins: 1,
      leases: 1,
    };
    surface.resolveNext('server.image.impact.get', { success: true, impact });
    await screen.findByTestId('images-tag-impact-confirm');
    expect(screen.getByTestId('images-tag-confirm')).toBeDisabled();
    await userEvent.click(screen.getByTestId('images-tag-impact-confirm'));
    expect(screen.getByTestId('images-tag-confirm')).toBeEnabled();
    await userEvent.click(screen.getByTestId('images-tag-confirm'));

    const remove = surface.requests.find(
      (candidate) => candidate.type === 'server.image.tag.remove',
    );
    expect(remove?.payload).toEqual({
      repository: 'nession/fixtures',
      tag: 'image-1',
      expected_digest: libraryEntry(1).manifest_digest,
      accept_reference_impact: true,
    });
    surface.resolveNext('server.image.tag.remove', {
      success: true,
      removed: true,
      impact,
    });
    await waitFor(() =>
      expect(
        surface.requests.some((candidate) => candidate.type === 'server.image.library.list'),
      ).toBe(true),
    );
    surface.resolveNext('server.image.library.list', {
      success: true,
      entries: [{ ...libraryEntry(1), tags: [] }],
      total: 1,
    });
    await waitFor(() => expect(screen.queryByTestId('images-tag-operation')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('images-tag')).toBeNull());
  });
});
