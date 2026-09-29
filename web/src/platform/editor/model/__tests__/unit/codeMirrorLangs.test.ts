import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSessionSeenLangKeys,
  resetLangsModuleForTests,
  ensureLangsModule,
  scanLanguageIdsFromPaths,
  registerSeenLanguageIds,
} from '@/platform/editor/model/codeMirrorLangs';

describe('scanLanguageIdsFromPaths', () => {
  it('scans LanguageIds from directory listing', () => {
    const paths = ['foo.ts', 'bar.rs', 'Dockerfile', 'README'];
    const ids = scanLanguageIdsFromPaths(paths);
    expect(ids).toContain('typescript');
    expect(ids).toContain('rust');
    expect(ids).toContain('dockerfile');
    expect(ids).toContain('markdown');
  });

  it('excludes plaintext from prefetch', () => {
    const paths = ['.env', 'file.csv', 'data.lock'];
    const ids = scanLanguageIdsFromPaths(paths);
    expect(ids).toEqual([]);
  });
});

describe('registerSeenLanguageIds', () => {
  beforeEach(() => {
    resetLangsModuleForTests();
  });

  it('registers LanguageIds as CodeMirror keys', () => {
    registerSeenLanguageIds(['typescript', 'rust']);
    expect(getSessionSeenLangKeys().has('ts')).toBe(true);
    expect(getSessionSeenLangKeys().has('rs')).toBe(true);
  });

  it('starts langs module load when ids are non-empty', async () => {
    registerSeenLanguageIds(['javascript']);
    await expect(ensureLangsModule()).resolves.toBeDefined();
  });
});
