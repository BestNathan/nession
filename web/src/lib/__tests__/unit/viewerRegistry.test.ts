import { describe, it, expect } from 'vitest';
import {
  getViewerType,
  getLangKey,
  isViewable,
  isViewablePath,
  parseExt,
  parseBasename,
  isMarkdownExt,
} from '@/lib/viewerRegistry';

describe('getViewerType', () => {
  it.each(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])('returns "image" for .%s', (ext) => {
    expect(getViewerType(ext)).toBe('image');
  });

  it.each(['mp4', 'webm', 'mov'])('returns "video" for .%s', (ext) => {
    expect(getViewerType(ext)).toBe('video');
  });

  it.each(['mp3', 'wav', 'ogg', 'flac', 'aac'])('returns "audio" for .%s', (ext) => {
    expect(getViewerType(ext)).toBe('audio');
  });

  it('returns "pdf" for .pdf', () => {
    expect(getViewerType('pdf')).toBe('pdf');
  });

  it('returns null for unknown extensions', () => {
    expect(getViewerType('exe')).toBeNull();
    expect(getViewerType('zip')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(getViewerType('PNG')).toBe('image');
    expect(getViewerType('Pdf')).toBe('pdf');
  });

  it('returns null for empty string', () => {
    expect(getViewerType('')).toBeNull();
  });
});

describe('getLangKey', () => {
  it('returns UIW keys for common extensions', () => {
    expect(getLangKey('js')).toBe('js');
    expect(getLangKey('sh')).toBe('sh');
    expect(getLangKey('go')).toBe('go');
    expect(getLangKey('rs')).toBe('rs');
    expect(getLangKey('toml')).toBe('toml');
    expect(getLangKey('ini')).toBe('ini');
  });

  it('returns undefined for unknown extensions', () => {
    expect(getLangKey('xyz')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(getLangKey('SH')).toBe('sh');
  });
});

describe('isViewable', () => {
  it('returns true for known image extensions', () => {
    expect(isViewable('png')).toBe(true);
  });

  it('returns false for unknown extensions', () => {
    expect(isViewable('exe')).toBe(false);
  });

  it('returns true for known code extensions', () => {
    expect(isViewable('js')).toBe(true);
    expect(isViewable('toml')).toBe(true);
  });
});

describe('isViewablePath', () => {
  it('returns true for Dockerfile without extension', () => {
    expect(isViewablePath('Dockerfile')).toBe(true);
  });

  it('returns true for Cargo.toml', () => {
    expect(isViewablePath('src/Cargo.toml')).toBe(true);
  });
});

describe('parseExt', () => {
  it('extracts extension from simple filename', () => {
    expect(parseExt('photo.png')).toBe('png');
  });

  it('extracts extension from path', () => {
    expect(parseExt('/home/user/file.txt')).toBe('txt');
  });

  it('handles filenames without extension', () => {
    expect(parseExt('Makefile')).toBe('');
    expect(parseExt('README')).toBe('');
  });

  it('handles hidden files', () => {
    expect(parseExt('.env')).toBe('env');
  });

  it('returns lowercase', () => {
    expect(parseExt('FILE.PDF')).toBe('pdf');
  });
});

describe('parseBasename', () => {
  it('returns the last path segment', () => {
    expect(parseBasename('/a/b/Cargo.toml')).toBe('Cargo.toml');
  });
});

describe('isMarkdownExt', () => {
  it('returns true for .md', () => {
    expect(isMarkdownExt('md')).toBe(true);
  });

  it('returns true for .markdown', () => {
    expect(isMarkdownExt('markdown')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMarkdownExt('MD')).toBe(true);
  });

  it('returns false for other extensions', () => {
    expect(isMarkdownExt('js')).toBe(false);
  });
});
