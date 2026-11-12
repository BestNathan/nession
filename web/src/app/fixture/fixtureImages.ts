import { useEffect } from 'react';
import type { PluginSurface } from '@/platform/socket/types';
import { ProtocolDirectory } from '@/platform/protocol';
import { imagesApi, type ImageDescriptor } from '@/capabilities/images';

const CREATED_AT = 1_762_300_000;
const STATUSES: ImageDescriptor['status'][] = ['ready', 'ready', 'ready', 'ready', 'ready', 'building', 'failed'];

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
      packaging: {
        compression: 'none',
        block_size: 4096,
        fixed_timestamp: 0,
        fixed_uuid: '11111111-1111-4111-8111-111111111111',
      },
      status,
      error: status === 'failed' ? 'fixture build failed' : undefined,
      alias,
      aliases: alias ? [alias] : [],
      created_at: CREATED_AT + index,
      updated_at: CREATED_AT + index + 60,
    };
  });
}

export type FixtureImagesScenario = 'canonical' | 'empty' | 'error' | 'buildfail';

function scenario(search: string): FixtureImagesScenario {
  const value = new URLSearchParams(search).get('images');
  return value === 'empty' || value === 'error' || value === 'buildfail'
    ? value
    : 'canonical';
}

function matches(image: ImageDescriptor, query: string): boolean {
  if (!query) {
    return true;
  }
  const target = query.toLowerCase();
  return (
    image.image_id.toLowerCase().includes(target)
    || (image.alias ?? '').toLowerCase().includes(target)
    || image.aliases.some((alias) => alias.toLowerCase().includes(target))
    || (image.digest ?? '').toLowerCase().includes(target)
    || (image.source.kind === 'local_directory'
      ? image.source.path.toLowerCase().includes(target)
      : image.source.repository_url.toLowerCase().includes(target))
  );
}

export function fixtureImagesSurface(search: string): PluginSurface {
  const selectedScenario = scenario(search);
  const registry = fixtureImages();
  return {
    connectionState: 'connected',
    protocols: new ProtocolDirectory(),
    send: () => undefined,
    subscribe: () => () => undefined,
    onBinary: () => () => undefined,
    waitForConnection: () => Promise.resolve(),
    onConnectionStateChange: () => () => undefined,
    request: <T,>(type: string, payload: Record<string, unknown>): Promise<T> => {
      if (type === 'server.image.list') {
        if (selectedScenario === 'error') {
          return Promise.resolve({
            images: [],
            total: 0,
            error: 'Fixture image registry unavailable',
          } as T);
        }
        const offset = Number(payload.offset ?? 0);
        const limit = Number(payload.limit ?? 50);
        const query = String(payload.query ?? '');
        const rows = selectedScenario === 'empty' ? [] : registry.filter((image) => matches(image, query));
        const page = rows.slice(offset, offset + limit);
        return Promise.resolve({
          images: page,
          total: rows.length,
          ...(offset + page.length < rows.length
            ? { next_offset: offset + page.length }
            : {}),
        } as T);
      }
      if (type === 'server.image.get') {
        const digest = typeof payload.digest === 'string' ? payload.digest : '';
        const alias = typeof payload.alias === 'string' ? payload.alias : '';
        const image = registry.find(
          (candidate) =>
            (digest !== '' && candidate.digest === digest)
            || (alias !== '' && (candidate.alias === alias || candidate.aliases.includes(alias))),
        );
        return Promise.resolve(
          image
            ? { success: true, image }
            : { success: false, error: 'Image not found' },
        ) as Promise<T>;
      }
      if (type === 'server.image.build') {
        if (selectedScenario === 'buildfail') {
          return Promise.resolve({
            success: false,
            error: 'Fixture Git Source could not be packaged',
          }) as Promise<T>;
        }
        const image: ImageDescriptor = {
          image_id: 'image-fixture-built',
          digest: digestFor(900),
          size_bytes: 8192,
          source: {
            kind: 'github',
            repository_url: 'https://github.com/BestNathan/nession',
            ref: 'main',
          },
          source_sha: 'a'.repeat(40),
          packaging: {
            compression: 'none',
            block_size: 4096,
            fixed_timestamp: 0,
            fixed_uuid: '11111111-1111-4111-8111-111111111111',
          },
          status: 'ready',
          alias: 'fixture-project-build',
          aliases: ['fixture-project-build'],
          created_at: CREATED_AT + 1000,
          updated_at: CREATED_AT + 1001,
        };
        return Promise.resolve({ success: true, image }) as Promise<T>;
      }
      if (type === 'server.image.access') {
        const digest = String(payload.digest ?? '');
        return Promise.resolve({
          success: true,
          token: 'fixture-image-token',
          expires_at: CREATED_AT + 3600,
          path: `/images/blobs/${digest}`,
        }) as Promise<T>;
      }
      return Promise.reject(new Error(`Unsupported fixture Images request: ${type}`));
    },
  };
}

/** Bind the Images transport for a fixture route's lifetime. */
export function useFixtureImages(search: string): void {
  useEffect(() => imagesApi.install(fixtureImagesSurface(search)), [search]);
}
