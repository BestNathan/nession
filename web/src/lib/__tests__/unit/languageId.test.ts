import { describe, expect, it } from 'vitest';
import { detectLanguage, parseLangBasename, parseLangExt } from '@/lib/languageId';

describe('parseLangBasename', () => {
  it('extracts basename from absolute path', () => {
    expect(parseLangBasename('/path/to/file.txt')).toBe('file.txt');
  });

  it('extracts basename from relative path', () => {
    expect(parseLangBasename('path/to/file.txt')).toBe('file.txt');
  });

  it('returns input when no slash present', () => {
    expect(parseLangBasename('file.txt')).toBe('file.txt');
  });

  it('handles dotfiles', () => {
    expect(parseLangBasename('.gitignore')).toBe('.gitignore');
    expect(parseLangBasename('/home/user/.bashrc')).toBe('.bashrc');
  });

  it('handles empty string', () => {
    expect(parseLangBasename('')).toBe('');
  });

  it('handles trailing slash', () => {
    expect(parseLangBasename('/path/to/')).toBe('');
  });

  it('handles multiple slashes', () => {
    expect(parseLangBasename('/a/b/c/d/file.txt')).toBe('file.txt');
  });
});

describe('parseLangExt', () => {
  it('extracts simple extension', () => {
    expect(parseLangExt('file.txt')).toBe('txt');
  });

  it('extracts last extension from multiple dots', () => {
    expect(parseLangExt('file.test.ts')).toBe('ts');
  });

  it('returns empty for no extension', () => {
    expect(parseLangExt('Makefile')).toBe('');
  });

  it('returns empty for dotfiles (hidden files)', () => {
    expect(parseLangExt('.gitignore')).toBe('');
    expect(parseLangExt('.bashrc')).toBe('');
    expect(parseLangExt('.zshrc')).toBe('');
  });

  it('preserves case (unlike viewerRegistry.parseExt)', () => {
    expect(parseLangExt('file.MAKEFILE')).toBe('MAKEFILE');
    expect(parseLangExt('README.MD')).toBe('MD');
  });

  it('handles empty string', () => {
    expect(parseLangExt('')).toBe('');
  });

  it('handles path with dotfile in directory', () => {
    expect(parseLangExt('/home/user/.bashrc')).toBe('');
  });

  it('extracts extension from path', () => {
    expect(parseLangExt('/path/to/file.ts')).toBe('ts');
  });
});

describe('detectLanguage', () => {
  describe('basename priority', () => {
    it('detects Dockerfile', () => {
      expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    });

    it('detects Makefile', () => {
      expect(detectLanguage('Makefile')).toBe('makefile');
    });

    it('detects README as markdown', () => {
      expect(detectLanguage('README')).toBe('markdown');
    });

    it('detects .gitignore as ignore', () => {
      expect(detectLanguage('.gitignore')).toBe('ignore');
    });

    it('detects .bashrc as shellscript', () => {
      expect(detectLanguage('.bashrc')).toBe('shellscript');
    });

    it('detects Gemfile as ruby', () => {
      expect(detectLanguage('Gemfile')).toBe('ruby');
    });

    it('detects Jenkinsfile as groovy', () => {
      expect(detectLanguage('Jenkinsfile')).toBe('groovy');
    });

    it('detects CMakeLists.txt as cmake', () => {
      expect(detectLanguage('CMakeLists.txt')).toBe('cmake');
    });
  });

  describe('path handling', () => {
    it('extracts basename from path before matching', () => {
      expect(detectLanguage('/home/user/project/Makefile')).toBe('makefile');
      expect(detectLanguage('src/Dockerfile')).toBe('dockerfile');
    });
  });

  describe('fallback behavior', () => {
    it('returns plaintext for unknown files', () => {
      expect(detectLanguage('unknown.xyz')).toBe('plaintext');
      expect(detectLanguage('random')).toBe('plaintext');
    });

    it('returns plaintext for empty string', () => {
      expect(detectLanguage('')).toBe('plaintext');
    });
  });

  describe('case sensitivity', () => {
    it('basename matching is case-sensitive', () => {
      expect(detectLanguage('MAKEFILE')).toBe('plaintext');
      expect(detectLanguage('DOCKERFILE')).toBe('plaintext');
      expect(detectLanguage('makefile')).toBe('makefile');
    });
  });
});
