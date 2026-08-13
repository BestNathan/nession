import { describe, it, expect } from 'vitest';
import { detectLanguage, preload, getLanguage, ensureLanguage } from '../codeMirrorLanguages';

describe('detectLanguage', () => {
  it('returns "javascript" for .js', () => {
    expect(detectLanguage('app.js')).toBe('javascript');
  });

  it('returns "shell" for .sh', () => {
    expect(detectLanguage('deploy.sh')).toBe('shell');
  });

  it('returns "go" for .go', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('returns "rust" for .rs', () => {
    expect(detectLanguage('lib.rs')).toBe('rust');
  });

  it('returns "cpp" for .cpp', () => {
    expect(detectLanguage('main.cpp')).toBe('cpp');
  });

  it('returns "sql" for .sql', () => {
    expect(detectLanguage('query.sql')).toBe('sql');
  });

  it('returns "xml" for .xml', () => {
    expect(detectLanguage('config.xml')).toBe('xml');
  });

  it('returns "text" for unknown extensions', () => {
    expect(detectLanguage('file.xyz')).toBe('text');
  });

  it('returns "text" for files without extension', () => {
    expect(detectLanguage('Makefile')).toBe('text');
  });

  it('is case-insensitive', () => {
    expect(detectLanguage('APP.JS')).toBe('javascript');
  });
});

describe('getLanguage', () => {
  it('returns extensions for static languages immediately', () => {
    const exts = getLanguage('javascript');
    expect(exts).toBeTruthy();
    expect(exts!.length).toBeGreaterThan(0);
  });

  it('returns extensions for static languages (python, json, html, css)', () => {
    expect(getLanguage('python')).toBeTruthy();
    expect(getLanguage('json')).toBeTruthy();
    expect(getLanguage('html')).toBeTruthy();
    expect(getLanguage('css')).toBeTruthy();
    expect(getLanguage('markdown')).toBeTruthy();
    expect(getLanguage('yaml')).toBeTruthy();
    expect(getLanguage('typescript')).toBeTruthy();
  });

  it('returns undefined for lazy languages before preload', () => {
    expect(getLanguage('go')).toBeUndefined();
    expect(getLanguage('rust')).toBeUndefined();
    expect(getLanguage('cpp')).toBeUndefined();
    expect(getLanguage('sql')).toBeUndefined();
    expect(getLanguage('xml')).toBeUndefined();
    expect(getLanguage('shell')).toBeUndefined();
  });

  it('returns undefined for unknown language keys', () => {
    expect(getLanguage('unknown_lang')).toBeUndefined();
  });
});

describe('preload', () => {
  it('does not throw for any input', () => {
    expect(() => preload([])).not.toThrow();
    expect(() => preload(['go', 'rs', 'xyz'])).not.toThrow();
  });

  it('skips extensions with no language key', () => {
    expect(() => preload(['xyz', 'abc'])).not.toThrow();
  });

  it('skips extensions that are static languages', () => {
    // js is a static language — preload should be a no-op for it
    expect(() => preload(['js', 'py', 'json'])).not.toThrow();
  });
});

describe('ensureLanguage', () => {
  it('resolves static languages immediately', async () => {
    const exts = await ensureLanguage('javascript');
    expect(exts).toBeDefined();
    expect(exts!.length).toBeGreaterThan(0);
  });

  it('resolves undefined for text and unknown keys', async () => {
    expect(await ensureLanguage('text')).toBeUndefined();
    expect(await ensureLanguage('unknown_lang')).toBeUndefined();
  });

  it('resolves every legacy language after its async load', async () => {
    // Each legacy loader uses a literal import specifier (not a template
    // literal) so the bundler can code-split it; this test exercises all ten,
    // catching any typo in the import path or exported symbol name.
    const legacyLangs = ['shell', 'ruby', 'swift', 'haskell', 'clojure', 'r', 'julia', 'lua', 'perl', 'groovy'];
    for (const lang of legacyLangs) {
      expect(getLanguage(lang), `${lang} starts unloaded`).toBeUndefined();
      const exts = await ensureLanguage(lang);
      expect(exts, `${lang} resolves`).toBeDefined();
      expect(exts!.length, `${lang} returns extensions`).toBeGreaterThan(0);
      expect(getLanguage(lang), `${lang} is cached after load`).toBeDefined();
    }

    // A second call resolves through the already-loaded fast path.
    const again = await ensureLanguage('shell');
    expect(again).toBeDefined();
    expect(again!.length).toBeGreaterThan(0);
  });
});
