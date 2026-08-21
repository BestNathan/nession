import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveLangKey,
  scanLangKeysFromPaths,
  registerSeenLangKeys,
  getSessionSeenLangKeys,
  resetLangsModuleForTests,
  ensureLangsModule,
} from '@/lib/codeMirrorLangs';

describe('resolveLangKey', () => {
  it('maps .js to js', () => {
    expect(resolveLangKey('app.js')).toBe('js');
  });

  it('maps .ts to ts', () => {
    expect(resolveLangKey('main.ts')).toBe('ts');
  });

  it('maps .toml to toml', () => {
    expect(resolveLangKey('Cargo.toml')).toBe('toml');
  });

  it('maps .env to properties', () => {
    expect(resolveLangKey('.env')).toBe('properties');
  });

  it('maps zsh to sh', () => {
    expect(resolveLangKey('script.zsh')).toBe('sh');
  });

  it('maps fish to sh', () => {
    expect(resolveLangKey('script.fish')).toBe('sh');
  });

  it('maps Dockerfile basename to dockerfile loader key', () => {
    expect(resolveLangKey('Dockerfile')).toBe('__dockerfile__');
  });

  it('returns null for Makefile (no grammar)', () => {
    expect(resolveLangKey('Makefile')).toBeNull();
  });

  it('returns null for GNUmakefile (no grammar)', () => {
    expect(resolveLangKey('GNUmakefile')).toBeNull();
  });

  it('returns null for unknown extension', () => {
    expect(resolveLangKey('file.xyz')).toBeNull();
  });

  it('honors explicit language prop', () => {
    expect(resolveLangKey('x', 'typescript')).toBe('ts');
  });
});

describe('scanLangKeysFromPaths', () => {
  it('collects unique lang keys from paths', () => {
    const keys = scanLangKeysFromPaths(['a.go', 'b.go', 'c.rs', 'Dockerfile']);
    expect(keys).toContain('go');
    expect(keys).toContain('rs');
    expect(keys).toContain('__dockerfile__');
    expect(keys.length).toBe(3);
  });

  it('returns empty for paths without highlightable keys', () => {
    expect(scanLangKeysFromPaths(['photo.png', 'README'])).toEqual([]);
  });
});

describe('registerSeenLangKeys', () => {
  beforeEach(() => {
    resetLangsModuleForTests();
  });

  it('accumulates keys across calls', () => {
    registerSeenLangKeys(['go']);
    registerSeenLangKeys(['toml']);
    expect(getSessionSeenLangKeys().has('go')).toBe(true);
    expect(getSessionSeenLangKeys().has('toml')).toBe(true);
  });

  it('starts langs module load when keys are non-empty', async () => {
    registerSeenLangKeys(['js']);
    await expect(ensureLangsModule()).resolves.toBeDefined();
  });
});
