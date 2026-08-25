import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_BASENAMES,
  MARKDOWN_EXTENSIONS,
  basenameOf,
  isMarkdownBasename,
  isMarkdownExt,
  isMarkdownMimeType,
} from '@/markdown/extensions';

describe('isMarkdownExt', () => {
  it('accepts every registered extension', () => {
    for (const ext of MARKDOWN_EXTENSIONS) {
      expect(isMarkdownExt(ext), ext).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isMarkdownExt('MD')).toBe(true);
    expect(isMarkdownExt('Markdown')).toBe(true);
  });

  it('rejects non-markdown extensions', () => {
    for (const ext of ['js', 'txt', 'rst', 'html', '']) {
      expect(isMarkdownExt(ext), ext).toBe(false);
    }
  });
});

describe('isMarkdownMimeType', () => {
  it('accepts markdown media types', () => {
    expect(isMarkdownMimeType('text/markdown')).toBe(true);
    expect(isMarkdownMimeType('text/x-markdown')).toBe(true);
  });

  it('ignores parameters and surrounding whitespace', () => {
    expect(isMarkdownMimeType('text/markdown; charset=utf-8')).toBe(true);
    expect(isMarkdownMimeType('  TEXT/MARKDOWN  ')).toBe(true);
  });

  it('rejects other media types', () => {
    expect(isMarkdownMimeType('text/plain')).toBe(false);
    expect(isMarkdownMimeType('application/json')).toBe(false);
    expect(isMarkdownMimeType('')).toBe(false);
  });
});

describe('basenameOf', () => {
  it('strips directories', () => {
    expect(basenameOf('/a/b/c.md')).toBe('c.md');
    expect(basenameOf('c.md')).toBe('c.md');
    expect(basenameOf('')).toBe('');
  });

  it('handles a trailing slash', () => {
    expect(basenameOf('/a/b/')).toBe('');
  });
});

describe('isMarkdownBasename', () => {
  it('accepts every registered basename, with or without an extension', () => {
    for (const name of MARKDOWN_BASENAMES) {
      expect(isMarkdownBasename(name), name).toBe(true);
      expect(isMarkdownBasename(`${name}.md`), `${name}.md`).toBe(true);
    }
  });

  it('is case-insensitive and path-aware', () => {
    expect(isMarkdownBasename('README')).toBe(true);
    expect(isMarkdownBasename('/repo/docs/Readme.md')).toBe(true);
  });

  it('rejects names that only contain a convention word', () => {
    expect(isMarkdownBasename('READMEISH')).toBe(false);
    expect(isMarkdownBasename('my-readme-notes')).toBe(false);
  });

  it('rejects conventionally plain-text names', () => {
    // These carry `---` rules and numbered clauses that used to read as markdown.
    for (const name of ['LICENSE', 'AUTHORS', 'NOTICE', 'COPYING', 'TODO']) {
      expect(isMarkdownBasename(name), name).toBe(false);
    }
  });

  it('rejects a dotfile whose whole name looks like an extension', () => {
    expect(isMarkdownBasename('.md')).toBe(false);
  });
});
