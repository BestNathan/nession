import { describe, expect, it } from 'vitest';
import type {
  ImageDescriptor,
  ImageLibraryEntry,
} from '@/capabilities/images';
import type { Project } from '@/product/project/types';
import {
  imageCandidateBlockReason,
  managedCreateRequest,
  projectSourceIsStale,
  validateManagedCreate,
} from '@/product/session/model/managedCreate';

const BASE = `sha256:${'a'.repeat(64)}`;
const TOOL = `sha256:${'b'.repeat(64)}`;
const SOURCE = `sha256:${'c'.repeat(64)}`;

function descriptor(overrides: Partial<ImageDescriptor> = {}): ImageDescriptor {
  return {
    image_id: 'image-source',
    digest: SOURCE,
    size_bytes: 128,
    source: {
      kind: 'github',
      repository_url: 'https://github.com/BestNathan/nession',
      ref: 'main',
    },
    source_sha: 'd'.repeat(40),
    packaging: {
      compression: 'zstd',
      block_size: 4096,
      fixed_timestamp: 1,
      fixed_uuid: '00000000-0000-4000-8000-000000000000',
    },
    status: 'ready',
    aliases: [],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function libraryEntry(
  digest: string,
  overrides: Partial<ImageLibraryEntry> = {},
): ImageLibraryEntry {
  return {
    image: descriptor({ image_id: `image-${digest.slice(-4)}`, digest }),
    repository: '',
    tags: [],
    manifest_digest: digest,
    representation: 'single_layer',
    layers: [],
    closure: [],
    ...overrides,
  };
}

const PROJECT: Project = {
  project_id: 'project-1',
  name: 'Nession',
  source: {
    repository_url: 'https://github.com/BestNathan/nession.git',
    ref: 'main',
  },
  locations: [],
  image_digest: SOURCE,
  created_at: 1,
  updated_at: 1,
};

const AGENT = {
  agent_id: 'a1',
  hostname: 'devbox',
  ip_address: '10.0.0.1',
  port: 1,
  status: 'online' as const,
  session_count: 0,
  last_heartbeat: '2026-01-01T00:00:00Z',
  metadata: {
    tmux_version: '3.6b',
    os_version: 'Ubuntu',
    nession_version: '0.35.0',
    os: 'linux',
    architecture: 'amd64',
  },
};

describe('managed create selection', () => {
  it('refuses a referenced Composite, a wrong role and a foreign platform', () => {
    const base = libraryEntry(BASE, {
      image_kind: 'base_runtime',
      platform: 'linux/amd64',
    });
    expect(imageCandidateBlockReason(base, 'base_runtime', 'linux/amd64')).toBeNull();

    const referenced = libraryEntry(BASE, {
      image_kind: 'base_runtime',
      platform: 'linux/amd64',
      representation: 'referenced',
    });
    expect(imageCandidateBlockReason(referenced, 'base_runtime', 'linux/amd64')).toContain(
      'Referenced composite',
    );

    const wrongRole = libraryEntry(TOOL, {
      image_kind: 'tool',
      platform: 'linux/amd64',
    });
    expect(imageCandidateBlockReason(wrongRole, 'base_runtime', 'linux/amd64')).toContain(
      'Toolchain',
    );

    const wrongPlatform = libraryEntry(BASE, {
      image_kind: 'base_runtime',
      platform: 'linux/arm64',
    });
    expect(
      imageCandidateBlockReason(wrongPlatform, 'base_runtime', 'linux/amd64'),
    ).toContain('linux/arm64');
  });

  it('orders the toolchain digests exactly as selected', () => {
    expect(managedCreateRequest(BASE, [TOOL, SOURCE])).toEqual({
      base_digest: BASE,
      toolchains: [{ digest: TOOL }, { digest: SOURCE }],
    });
  });
});

describe('Project source staleness', () => {
  it('normalizes the .git suffix and compares the declared ref', () => {
    expect(projectSourceIsStale(PROJECT, descriptor())).toBe(false);
    expect(
      projectSourceIsStale(PROJECT, descriptor({
        source: {
          kind: 'github',
          repository_url: 'https://github.com/BestNathan/other',
          ref: 'main',
        },
      })),
    ).toBe(true);
    expect(
      projectSourceIsStale(PROJECT, descriptor({
        source: {
          kind: 'github',
          repository_url: 'https://github.com/BestNathan/nession',
          ref: 'release',
        },
      })),
    ).toBe(true);
  });

  it('matches a full commit against the image source_sha', () => {
    const pinned: Project = {
      ...PROJECT,
      source: {
        repository_url: 'https://github.com/BestNathan/nession',
        ref: 'd'.repeat(40),
      },
    };
    expect(projectSourceIsStale(pinned, descriptor())).toBe(false);
    const different: Project = {
      ...pinned,
      source: { ...pinned.source!, ref: 'e'.repeat(40) },
    };
    expect(projectSourceIsStale(different, descriptor())).toBe(true);
  });
});

describe('Managed create validation', () => {
  const valid = {
    sessionName: 'managed-one',
    project: PROJECT,
    agent: AGENT,
    baseDigest: BASE,
    toolchains: [],
    projectSource: descriptor(),
    projectSourceError: null,
    envSelectionMode: 'inherit' as const,
    selectedEnv: [],
    unavailableEnv: [],
  };

  it('accepts a ready pinned Source and a selected Base', () => {
    expect(validateManagedCreate(valid)).toBeNull();
  });

  it('refuses a missing Base, a stale Source and an unresolved Source', () => {
    expect(validateManagedCreate({ ...valid, baseDigest: '' })).toContain(
      'Base Runtime',
    );
    expect(
      validateManagedCreate({
        ...valid,
        project: {
          ...PROJECT,
          source: { ...PROJECT.source!, ref: 'release' },
        },
      }),
    ).toContain('Git Source changed');
    expect(
      validateManagedCreate({ ...valid, projectSourceError: 'not found' }),
    ).toContain('cannot be resolved');
    expect(validateManagedCreate({ ...valid, projectSource: null })).toContain(
      'not loaded',
    );
  });
});
