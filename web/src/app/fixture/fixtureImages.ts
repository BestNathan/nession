import { useEffect } from 'react';
import type { PluginSurface, SocketMessage } from '@/platform/socket/types';
import { ProtocolDirectory } from '@/platform/protocol';
import {
  IMAGE_BUILD_UPDATED_WIRE,
  imagesApi,
  type ImageBuildDescriptor,
  type ImageDescriptor,
  type ImageLibraryEntry,
  type ImageLibraryLayer,
  type ImageLibraryRepresentation,
  type ImageReferenceImpact,
} from '@/capabilities/images';

const CREATED_AT = 1_762_300_000;
const STATUSES: ImageDescriptor['status'][] = ['ready', 'ready', 'ready', 'ready', 'ready', 'building', 'failed'];
const PACKAGING = {
  compression: 'none',
  block_size: 4096,
  fixed_timestamp: 0,
  fixed_uuid: '11111111-1111-4111-8111-111111111111',
};

function digestFor(index: number): string {
  const hex = index.toString(16).padStart(4, '0');
  return `sha256:${hex}${'abcdef0123456789'.repeat(4).slice(0, 60)}`.slice(0, 71);
}

function fixtureImages(): ImageDescriptor[] {
  return Array.from({ length: 235 }, (_, index) => {
    const status = index < 200 ? 'ready' : STATUSES[index % STATUSES.length];
    const alias = index % 7 === 0 ? undefined : `fixture-image-${index}`;
    const digest = status === 'ready' ? digestFor(index + 1) : undefined;
    return {
      image_id: `image-fixture-${index}`,
      digest,
      size_bytes: 4096 + index,
      source: {
        kind: 'local_directory',
        path: `/var/lib/nession/fixture/${index}`,
      },
      packaging: PACKAGING,
      status,
      error: status === 'failed' ? 'fixture build failed' : undefined,
      alias,
      aliases: alias ? [alias] : [],
      created_at: CREATED_AT + index,
      updated_at: CREATED_AT + index + 60,
    };
  });
}

function fixtureImage(
  index: number,
  alias: string,
  status: ImageDescriptor['status'],
): ImageDescriptor {
  return {
    image_id: `image-fixture-build-${index}`,
    digest: status === 'ready' ? digestFor(900 + index) : undefined,
    size_bytes: 8192 + index,
    source: {
      kind: 'github',
      repository_url: 'https://github.com/BestNathan/nession',
      ref: 'main',
    },
    source_sha: 'a'.repeat(40),
    packaging: PACKAGING,
    status,
    error: status === 'failed' ? 'Fixture Git Source could not be packaged' : undefined,
    alias,
    aliases: [alias],
    created_at: CREATED_AT + 1000 + index,
    updated_at: CREATED_AT + 1001 + index,
  };
}

function build(
  id: string,
  source: ImageBuildDescriptor['source'],
  state: { status: ImageBuildDescriptor['status']; stage?: ImageBuildDescriptor['stage'] },
  overrides: Partial<ImageBuildDescriptor> = {},
): ImageBuildDescriptor {
  const measured = state.status !== 'queued';
  return {
    build_id: id,
    image_id: `image-${id}`,
    attempt: 1,
    source,
    source_sha: null,
    packaging: PACKAGING,
    status: state.status,
    stage: state.stage ?? null,
    progress: {
      files: measured ? 214 : null,
      bytes: measured ? 2_400_000 : null,
      elapsed_ms: measured ? 1500 : 0,
    },
    diagnostic: null,
    error: state.status === 'failed' ? 'mkfs.erofs failed: fixture packaging diagnostic' : null,
    digest: state.status === 'succeeded' ? digestFor(950) : null,
    size_bytes: state.status === 'succeeded' ? 8192 : 0,
    alias: null,
    deduplicated: false,
    created_at: CREATED_AT + 1000,
    updated_at: CREATED_AT + 1500,
    ...overrides,
  };
}

export type FixtureImagesScenario = 'canonical' | 'empty' | 'error' | 'buildfail' | 'lifecycle';

interface FixtureLibraryMeta {
  repository: string;
  tags: string[];
  manifest_digest: string;
  media_type: string;
  kind: string;
  platform: string;
  representation: ImageLibraryRepresentation;
  layers: ImageLibraryLayer[];
  closure: string[];
  impact: ImageReferenceImpact;
}

interface FixtureState {
  scenario: FixtureImagesScenario;
  images: ImageDescriptor[];
  builds: ImageBuildDescriptor[];
  nextBuild: number;
  library: Map<string, FixtureLibraryMeta>;
}

function libraryMeta(
  image: ImageDescriptor,
  overrides: Partial<FixtureLibraryMeta> = {},
): FixtureLibraryMeta {
  const manifest = overrides.manifest_digest ?? digestFor(990);
  const layer = {
    digest: image.digest ?? digestFor(991),
    media_type: 'application/vnd.nession.erofs.layer.v1',
    size_bytes: image.size_bytes,
    role: 'layer',
  };
  return {
    repository: 'nession/fixtures',
    tags: [],
    manifest_digest: manifest,
    media_type: 'application/vnd.oci.image.manifest.v1+json',
    kind: 'manifest',
    platform: 'linux/amd64',
    representation: 'single_layer',
    layers: [layer],
    closure: [layer.digest],
    impact: {
      manifest_digest: manifest,
      project_pins: 0,
      session_pins: 0,
      other_tags: [],
      leases: 0,
      compose_references: 0,
      unknown: false,
    },
    ...overrides,
  };
}

function scenario(search: string): FixtureImagesScenario {
  const value = new URLSearchParams(search).get('images');
  return value === 'empty' || value === 'error' || value === 'buildfail' || value === 'lifecycle'
    ? value
    : 'canonical';
}

const GITHUB = {
  kind: 'github' as const,
  repository_url: 'https://github.com/BestNathan/nession',
  ref: 'main',
};

function initialBuilds(): ImageBuildDescriptor[] {
  return [
    build('build-fixture-running', GITHUB, { status: 'running', stage: 'packaging' }, {
      alias: 'nightly',
    }),
    build('build-fixture-failed', GITHUB, { status: 'failed' }),
    build('build-fixture-canceled', GITHUB, { status: 'canceled' }),
    build('build-fixture-succeeded', GITHUB, { status: 'succeeded' }, {
      alias: 'fixture-build-latest',
      digest: digestFor(901),
      progress: { files: 214, bytes: 2_400_000, elapsed_ms: 4200 },
    }),
  ];
}

const states = new Map<FixtureImagesScenario, FixtureState>();

function stateFor(selected: FixtureImagesScenario): FixtureState {
  const existing = states.get(selected);
  if (existing) {
    return existing;
  }
  const images = fixtureImages();
  if (selected === 'lifecycle') {
    images.push(fixtureImage(1, 'fixture-build-latest', 'ready'));
  }
  const library = new Map<string, FixtureLibraryMeta>();
  if (selected === 'lifecycle') {
    const managed = images[images.length - 1];
    library.set(
      managed.image_id,
      libraryMeta(managed, {
        tags: ['fixture-build-latest'],
        impact: {
          manifest_digest: digestFor(990),
          project_pins: 1,
          session_pins: 0,
          other_tags: [],
          leases: 1,
          compose_references: 0,
          unknown: false,
        },
      }),
    );
  }
  const state: FixtureState = {
    scenario: selected,
    images,
    builds: selected === 'lifecycle' ? initialBuilds() : [],
    nextBuild: 1,
    library,
  };
  states.set(selected, state);
  return state;
}

function matches(
  image: ImageDescriptor,
  query: string,
  tags: readonly string[] = [],
): boolean {
  if (!query) {
    return true;
  }
  const target = query.toLowerCase();
  return (
    image.image_id.toLowerCase().includes(target)
    || (image.alias ?? '').toLowerCase().includes(target)
    || image.aliases.some((alias) => alias.toLowerCase().includes(target))
    || tags.some((tag) => tag.toLowerCase().includes(target))
    || (image.digest ?? '').toLowerCase().includes(target)
    || sourceText(image.source).toLowerCase().includes(target)
  );
}

function sourceText(source: ImageDescriptor['source']): string {
  switch (source.kind) {
    case 'github':
      return `${source.repository_url}@${source.ref}`;
    case 'local_directory':
      return source.path;
    case 'compose':
      return source.sources
        .map((entry) => `${entry.repository}@${entry.ref} ${entry.destination}`)
        .join(' ');
  }
}

type Emit = (build: ImageBuildDescriptor) => void;

function replaceBuild(state: FixtureState, next: ImageBuildDescriptor): void {
  const position = state.builds.findIndex((candidate) => candidate.build_id === next.build_id);
  if (position >= 0) {
    state.builds[position] = next;
  } else {
    state.builds.unshift(next);
  }
}

function completeBuild(
  state: FixtureState,
  emitted: ImageBuildDescriptor,
  emit: Emit,
  status: 'succeeded' | 'failed',
): void {
  if (status === 'failed') {
    const failed: ImageBuildDescriptor = {
      ...emitted,
      status,
      stage: null,
      error: 'mkfs.erofs failed: fixture packaging diagnostic',
      updated_at: emitted.updated_at + 10,
    };
    replaceBuild(state, failed);
    emit(failed);
    return;
  }
  const index = state.nextBuild;
  state.nextBuild += 1;
  const image = fixtureImage(index, emitted.alias ?? `fixture-build-${index}`, 'ready');
  state.images.push(image);
  const done: ImageBuildDescriptor = {
    ...emitted,
    status,
    stage: null,
    digest: image.digest ?? null,
    size_bytes: image.size_bytes,
    progress: { files: 214, bytes: 2_400_000, elapsed_ms: 4200 },
    updated_at: emitted.updated_at + 10,
  };
  replaceBuild(state, done);
  emit(done);
}

function libraryMetaForRepository(
  state: FixtureState,
  repository: string,
): FixtureLibraryMeta | null {
  for (const meta of state.library.values()) {
    if (meta.repository === repository) {
      return meta;
    }
  }
  return null;
}

function libraryMetaForTag(
  state: FixtureState,
  repository: string,
  tag: string,
): FixtureLibraryMeta | null {
  for (const meta of state.library.values()) {
    if (meta.repository === repository && meta.tags.includes(tag)) {
      return meta;
    }
  }
  return null;
}

function libraryImpact(meta: FixtureLibraryMeta, tag: string | null): ImageReferenceImpact {
  return {
    ...meta.impact,
    other_tags: meta.tags.filter((candidate) => candidate !== tag),
  };
}

function libraryEntries(state: FixtureState, query: string, repository: string): ImageLibraryEntry[] {
  return state.images
    .filter((image) =>
      matches(image, query, state.library.get(image.image_id)?.tags ?? []),
    )
    .map((image) => {
      const meta = state.library.get(image.image_id);
      if (!meta) {
        return {
          image,
          repository: '',
          tags: [],
          manifest_digest: null,
          media_type: null,
          kind: null,
          platform: null,
          representation: 'unknown' as const,
          layers: [],
          closure: [],
        };
      }
      return {
        image,
        repository: meta.repository,
        tags: [...meta.tags],
        manifest_digest: meta.manifest_digest,
        media_type: meta.media_type,
        kind: meta.kind,
        platform: meta.platform,
        representation: meta.representation,
        layers: [...meta.layers],
        closure: [...meta.closure],
        impact: { ...libraryImpact(meta, null), other_tags: [] },
      };
    })
    .filter((entry) => repository === '' || entry.repository === repository);
}

function requestLibrary(
  state: FixtureState,
  type: string,
  payload: Record<string, unknown>,
): Promise<unknown> | null {

  if (type === 'server.image.library.list') {
    const offset = Number(payload.offset ?? 0);
    const limit = Number(payload.limit ?? 50);
    const query = String(payload.query ?? '');
    const repository = String(payload.repository ?? '');
    const entries = libraryEntries(state, query, repository);
    const page = entries.slice(offset, offset + limit);
    return Promise.resolve({
      success: true,
      entries: page,
      total: entries.length,
      ...(offset + page.length < entries.length ? { next_offset: offset + page.length } : {}),
    });
  }
  if (type === 'server.image.impact.get') {
    const repository = String(payload.repository ?? '');
    const tag = String(payload.tag ?? '');
    const meta = libraryMetaForTag(state, repository, tag);
    return Promise.resolve(
      meta
        ? { success: true, impact: libraryImpact(meta, tag) }
        : { success: false, error: 'Tag not found', error_kind: 'not_found' },
    );
  }
  return null;
}

function requestTagSet(
  state: FixtureState,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const repository = String(payload.repository ?? '');
  const tag = String(payload.tag ?? '');
  const digest = String(payload.digest ?? '');
  const expected = typeof payload.expected_digest === 'string' ? payload.expected_digest : null;
  const meta = libraryMetaForRepository(state, repository);
  if (!meta) {
    return Promise.resolve({ success: false, error: 'repository not found', error_kind: 'not_found' });
  }
  if (expected === null) {
    if (meta.tags.includes(tag)) {
      return Promise.resolve({
        success: false,
        error: `tag ${repository}:${tag} already exists`,
        error_kind: 'conflict',
        current_digest: meta.manifest_digest,
      });
    }
    meta.tags = [...meta.tags, tag].sort();
    return Promise.resolve({
      success: true,
      update: { repository, tag, digest, previous: null },
    });
  }
  if (!meta.tags.includes(tag)) {
    return Promise.resolve({ success: false, error: 'Tag not found', error_kind: 'not_found' });
  }
  if (expected !== meta.manifest_digest || digest !== meta.manifest_digest) {
    return Promise.resolve({
      success: false,
      error: `tag conflict for ${repository}:${tag}: expected ${expected}`,
      error_kind: 'conflict',
      current_digest: meta.manifest_digest,
    });
  }
  return Promise.resolve({
    success: true,
    update: { repository, tag, digest, previous: expected },
  });
}

function requestTagRemove(
  state: FixtureState,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const repository = String(payload.repository ?? '');
  const tag = String(payload.tag ?? '');
  const expected = String(payload.expected_digest ?? '');
  const accept = payload.accept_reference_impact === true;
  const meta = libraryMetaForTag(state, repository, tag);
  if (!meta) {
    return Promise.resolve({ success: false, error: 'Tag not found', error_kind: 'not_found' });
  }
  if (meta.manifest_digest !== expected) {
    return Promise.resolve({
      success: false,
      error: `tag conflict for ${repository}:${tag}: expected ${expected}`,
      error_kind: 'conflict',
      current_digest: meta.manifest_digest,
    });
  }
  const impact = libraryImpact(meta, tag);
  const referenced =
    impact.project_pins > 0
    || impact.session_pins > 0
    || impact.leases > 0
    || impact.compose_references > 0;
  if (impact.unknown || (referenced && !accept)) {
    return Promise.resolve({
      success: false,
      error: impact.unknown
        ? 'Reference impact is unknown; refusing to unlink'
        : 'Tag removal has references; review and confirm the reference impact',
      error_kind: impact.unknown ? 'impact_unknown' : 'impact_required',
      impact,
    });
  }
  meta.tags = meta.tags.filter((candidate) => candidate !== tag);
  return Promise.resolve({ success: true, removed: true, impact });
}

function requestTagMutation(
  state: FixtureState,
  type: string,
  payload: Record<string, unknown>,
): Promise<unknown> | null {
  if (type === 'server.image.tag.set') {
    return requestTagSet(state, payload);
  }
  if (type === 'server.image.tag.remove') {
    return requestTagRemove(state, payload);
  }
  return null;
}

function requestRegistry(
  state: FixtureState,
  type: string,
  payload: Record<string, unknown>,
): Promise<unknown> | null {
  const handled = requestLibrary(state, type, payload) ?? requestTagMutation(state, type, payload);
  if (handled) {
    return handled;
  }
  if (type === 'server.image.list') {
    if (state.scenario === 'error') {
      return Promise.resolve({
        images: [],
        total: 0,
        error: 'Fixture image registry unavailable',
      });
    }
    const offset = Number(payload.offset ?? 0);
    const limit = Number(payload.limit ?? 50);
    const query = String(payload.query ?? '');
    const rows = state.scenario === 'empty'
      ? []
      : state.images.filter((image) => matches(image, query));
    const page = rows.slice(offset, offset + limit);
    return Promise.resolve({
      images: page,
      total: rows.length,
      ...(offset + page.length < rows.length ? { next_offset: offset + page.length } : {}),
    });
  }
  if (type === 'server.image.get') {
    const digest = typeof payload.digest === 'string' ? payload.digest : '';
    const alias = typeof payload.alias === 'string' ? payload.alias : '';
    const image = state.images.find(
      (candidate) =>
        (digest !== '' && candidate.digest === digest)
        || (alias !== '' && (candidate.alias === alias || candidate.aliases.includes(alias))),
    );
    return Promise.resolve(
      image ? { success: true, image } : { success: false, error: 'Image not found' },
    );
  }
  return null;
}

function requestBuildInventory(
  state: FixtureState,
  type: string,
  payload: Record<string, unknown>,
  emit: Emit,
): Promise<unknown> | null {
  if (type === 'server.image.build.get' || type === 'server.image.build.list') {
    return Promise.resolve(
      type === 'server.image.build.get'
        ? buildReadReply(state, String(payload.build_id ?? ''))
        : buildListReply(state, payload),
    );
  }
  if (type === 'server.image.build.cancel' || type === 'server.image.build.retry') {
    return Promise.resolve(buildActionReply(state, type, String(payload.build_id ?? ''), emit));
  }
  return null;
}

function buildReadReply(state: FixtureState, buildId: string): unknown {
  const found = state.builds.find((candidate) => candidate.build_id === buildId);
  return found
    ? { success: true, build: found }
    : { success: false, error: 'build not found', error_kind: 'not_found' };
}

function buildListReply(state: FixtureState, payload: Record<string, unknown>): unknown {
  const offset = Number(payload.offset ?? 0);
  const limit = Number(payload.limit ?? 50);
  const page = state.builds.slice(offset, offset + limit);
  return {
    builds: page,
    total: state.builds.length,
    ...(offset + page.length < state.builds.length
      ? { next_offset: offset + page.length }
      : {}),
  };
}

function buildActionReply(
  state: FixtureState,
  type: string,
  buildId: string,
  emit: Emit,
): unknown {
  const position = state.builds.findIndex((candidate) => candidate.build_id === buildId);
  if (position < 0) {
    return { success: false, error: 'build not found', error_kind: 'not_found' };
  }
  const previous = state.builds[position];
  if (type === 'server.image.build.cancel') {
    const canceled: ImageBuildDescriptor = {
      ...previous,
      status: 'canceled',
      stage: null,
      error: null,
      updated_at: previous.updated_at + 5,
    };
    state.builds[position] = canceled;
    emit(canceled);
    return { success: true, build: canceled };
  }
  const retried: ImageBuildDescriptor = {
    ...previous,
    attempt: previous.attempt + 1,
    status: 'running',
    stage: 'packaging',
    error: null,
    digest: null,
    size_bytes: 0,
    updated_at: previous.updated_at + 5,
  };
  state.builds[position] = retried;
  emit(retried);
  setTimeout(() => completeBuild(state, retried, emit, 'succeeded'), 40);
  return { success: true, build: retried };
}

function requestBuild(
  state: FixtureState,
  type: string,
  payload: Record<string, unknown>,
  emit: Emit,
): Promise<unknown> | null {
  if (type === 'server.image.build.submit') {
    const source = payload.source as ImageBuildDescriptor['source'];
    const index = state.nextBuild;
    state.nextBuild += 1;
    const submitted: ImageBuildDescriptor = {
      ...build(`build-fixture-submit-${index}`, source, {
        status: 'running',
        stage: 'packaging',
      }),
      image_id: `image-fixture-submit-${index}`,
      alias: typeof payload.alias === 'string' ? payload.alias : null,
      created_at: CREATED_AT + 2000 + index,
      updated_at: CREATED_AT + 2000 + index,
    };
    state.builds.unshift(submitted);
    // The fixture runs the transition through the same push channel the real
    // Server uses, so a client never treats submit as completion.
    setTimeout(
      () => completeBuild(
        state,
        submitted,
        emit,
        state.scenario === 'buildfail' ? 'failed' : 'succeeded',
      ),
      40,
    );
    return Promise.resolve({ success: true, build: submitted });
  }
  if (type === 'server.image.build') {
    if (state.scenario === 'buildfail') {
      return Promise.resolve({
        success: false,
        error: 'Fixture Git Source could not be packaged',
      });
    }
    const image = fixtureImage(0, 'fixture-project-build', 'ready');
    image.digest = digestFor(900);
    return Promise.resolve({ success: true, image });
  }
  return requestBuildInventory(state, type, payload, emit);
}

export function fixtureImagesSurface(search: string): PluginSurface {
  const selectedScenario = scenario(search);
  const state = stateFor(selectedScenario);
  const listeners = new Map<
    string,
    Set<(payload: unknown, raw: SocketMessage) => void>
  >();
  const emit: Emit = (buildValue) => {
    const raw: SocketMessage = {
      msg_type: IMAGE_BUILD_UPDATED_WIRE,
      id: '',
      timestamp: CREATED_AT,
      payload: { build: buildValue },
    };
    for (const handler of listeners.get(IMAGE_BUILD_UPDATED_WIRE) ?? []) {
      handler(raw.payload, raw);
    }
  };

  return {
    connectionState: 'connected',
    protocols: new ProtocolDirectory(),
    send: () => undefined,
    subscribe: (type, handler) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(handler);
      return () => {
        listeners.get(type)?.delete(handler);
      };
    },
    onBinary: () => () => undefined,
    waitForConnection: () => Promise.resolve(),
    onConnectionStateChange: () => () => undefined,
    request: <T,>(type: string, payload: Record<string, unknown>): Promise<T> => {
      const result =
        requestRegistry(state, type, payload)
        ?? requestBuild(state, type, payload, emit);
      return result
        ? (result as Promise<T>)
        : Promise.reject(new Error(`Unsupported fixture Images request: ${type}`));
    },
  };
}

/** Bind the Images transport for a fixture route's lifetime. */
export function useFixtureImages(search: string): void {
  useEffect(() => imagesApi.install(fixtureImagesSurface(search)), [search]);
}
