import { describe, expect, it } from 'vitest';
import {
  emptyBuildSourceDraft,
  normalizeBuildAlias,
  normalizeGithubRepositoryUrl,
  normalizeLocalPath,
  normalizeSourceRef,
  validateBuildSource,
  type BuildSourceDraft,
} from '../../buildSource';

function draft(patch: Partial<BuildSourceDraft>): BuildSourceDraft {
  return { ...emptyBuildSourceDraft(), ...patch };
}

describe('Build source canonical preflight (#3795)', () => {
  it('normalizes only the public GitHub HTTPS repository shape', () => {
    expect(normalizeGithubRepositoryUrl('https://github.com/BestNathan/nession')).toBe(
      'https://github.com/BestNathan/nession',
    );
    expect(normalizeGithubRepositoryUrl(' https://github.com/o/r.git/ ')).toBe(
      'https://github.com/o/r',
    );
    for (const invalid of [
      'http://github.com/o/r',
      'git@github.com:o/r.git',
      'https://user:token@github.com/o/r',
      'https://github.com/o/r?ref=main',
      'https://github.com/o/r/tree/main',
      'ssh://github.com/o/r',
      'https://gitlab.com/o/r',
    ]) {
      expect(normalizeGithubRepositoryUrl(invalid), invalid).toBeNull();
    }
  });

  it('accepts a branch or a full commit and refuses unsafe refs', () => {
    expect(normalizeSourceRef('main')).toBe('main');
    expect(normalizeSourceRef('release/2026.11')).toBe('release/2026.11');
    expect(normalizeSourceRef('a'.repeat(40))).toBe('a'.repeat(40));
    for (const invalid of ['', 'HEAD', '-main', '/main', 'a..b', 'a//b', 'a b', 'a~1', 'a:1']) {
      expect(normalizeSourceRef(invalid), invalid).toBeNull();
    }
  });

  it('requires an absolute path without parent segments', () => {
    expect(normalizeLocalPath('/srv/images/root')).toBe('/srv/images/root');
    for (const invalid of ['relative/images', '/srv/../etc', '', '/srv/\nimages']) {
      expect(normalizeLocalPath(invalid), JSON.stringify(invalid)).toBeNull();
    }
  });

  it('keeps the alias rule optional and digest-shaped aliases refused', () => {
    expect(normalizeBuildAlias('')).toBeUndefined();
    expect(normalizeBuildAlias('nightly-1')).toBe('nightly-1');
    expect(normalizeBuildAlias('Nightly')).toBeNull();
    expect(normalizeBuildAlias(`sha256:${'a'.repeat(64)}`)).toBeNull();
    expect(normalizeBuildAlias('a'.repeat(129))).toBeNull();
  });

  it('projects GitHub and Directory declarations and reports field errors', () => {
    const github = validateBuildSource(
      draft({
        kind: 'github',
        repositoryUrl: 'https://github.com/o/r.git',
        reference: 'main',
      }),
    );
    expect(github.errors).toEqual({});
    expect(github.source).toEqual({
      kind: 'github',
      repository_url: 'https://github.com/o/r',
      ref: 'main',
    });

    const invalid = validateBuildSource(
      draft({ kind: 'github', repositoryUrl: 'https://github.com/o', reference: '' }),
    );
    expect(invalid.source).toBeUndefined();
    expect(invalid.errors.repository_url).toBeTruthy();
    expect(invalid.errors.ref).toBeTruthy();

    const directory = validateBuildSource(
      draft({ kind: 'local_directory', path: '/srv/images/base' }),
    );
    expect(directory.source).toEqual({
      kind: 'local_directory',
      path: '/srv/images/base',
    });
  });

  it('refuses overlapping flattened Compose destinations before submission', () => {
    const source = (destination: string) => ({
      repository: 'base',
      reference: 'latest',
      destination,
    });
    const overlapping = validateBuildSource(
      draft({
        kind: 'compose',
        sources: [source(''), source('/opt')].concat([source('/opt/tool')]),
      }),
    );
    expect(overlapping.source).toBeUndefined();
    expect(overlapping.errors.compose).toContain('overlap');

    const twoRoots = validateBuildSource(
      draft({ kind: 'compose', sources: [source(''), source('')] }),
    );
    expect(twoRoots.errors.compose).toContain('composed root');

    const valid = validateBuildSource(
      draft({
        kind: 'compose',
        representation: 'flattened',
        sources: [source(''), source('/opt/tool')],
      }),
    );
    expect(valid.errors).toEqual({});
    expect(valid.source).toEqual({
      kind: 'compose',
      representation: 'flattened',
      sources: [
        { repository: 'base', ref: 'latest', destination: '' },
        { repository: 'base', ref: 'latest', destination: '/opt/tool' },
      ],
    });
  });

  it('refuses a destination or duplicate revision in a referenced Compose', () => {
    const withDestination = validateBuildSource(
      draft({
        kind: 'compose',
        representation: 'referenced',
        sources: [{ repository: 'base', reference: 'latest', destination: '/opt' }],
      }),
    );
    expect(withDestination.source).toBeUndefined();
    expect(withDestination.errors.representation).toBeTruthy();

    const duplicate = validateBuildSource(
      draft({
        kind: 'compose',
        representation: 'referenced',
        sources: [
          { repository: 'base', reference: 'latest', destination: '' },
          { repository: 'base', reference: 'latest', destination: '/' },
        ],
      }),
    );
    expect(duplicate.source).toBeUndefined();
    expect(duplicate.errors.compose).toContain('twice');
  });

  it('reports per-row Compose field errors without projecting a source', () => {
    const invalid = validateBuildSource(
      draft({
        kind: 'compose',
        sources: [{ repository: 'Base', reference: 'LATEST', destination: 'relative' }],
      }),
    );
    expect(invalid.source).toBeUndefined();
    expect(invalid.errors['compose.0.repository']).toBeTruthy();
    expect(invalid.errors['compose.0.ref']).toBeTruthy();
    expect(invalid.errors['compose.0.destination']).toBeTruthy();
  });
});
