import { describe, it, expect } from 'vitest';
import { getViewerType, getLangKey, preloadExtensions, isViewable, parseExt } from '../viewerRegistry';

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
  it('returns javascript for .js', () => {
    expect(getLangKey('js')).toBe('javascript');
  });

  it('returns shell for .sh', () => {
    expect(getLangKey('sh')).toBe('shell');
  });

  it('returns go for .go', () => {
    expect(getLangKey('go')).toBe('go');
  });

  it('returns rust for .rs', () => {
    expect(getLangKey('rs')).toBe('rust');
  });

  it('returns cpp for .cpp', () => {
    expect(getLangKey('cpp')).toBe('cpp');
  });

  it('returns sql for .sql', () => {
    expect(getLangKey('sql')).toBe('sql');
  });

  it('returns xml for .xml', () => {
    expect(getLangKey('xml')).toBe('xml');
  });

  it('returns undefined for unknown extensions', () => {
    expect(getLangKey('xyz')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(getLangKey('SH')).toBe('shell');
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
    expect(isViewable('go')).toBe(true);
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
    expect(parseExt('.gitignore')).toBe('gitignore');
  });

  it('returns lowercase', () => {
    expect(parseExt('FILE.PDF')).toBe('pdf');
  });
});

describe('preloadExtensions', () => {
  it('extracts unique extensions from file paths', () => {
    const paths = ['a.go', 'b.go', 'c.rs', 'd.go', 'e.py'];
    const exts = preloadExtensions(paths);
    expect(exts).toContain('go');
    expect(exts).toContain('rs');
    expect(exts).toContain('py');
    expect(exts.length).toBe(3);
  });

  it('excludes unknown language extensions', () => {
    const paths = ['a.xyz', 'b.go'];
    const exts = preloadExtensions(paths);
    expect(exts).toEqual(['go']);
  });

  it('handles empty array', () => {
    expect(preloadExtensions([])).toEqual([]);
  });

  it('handles paths without extensions', () => {
    const paths = ['Makefile', 'Dockerfile', 'README'];
    expect(preloadExtensions(paths)).toEqual([]);
  });
});
