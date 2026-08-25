import { describe, expect, it } from 'vitest';
import { detectLanguage, detectLanguageForFile, parseLangBasename, parseLangExt } from '@/lib/languageId';
import { AUTO_APPLY_CONFIDENCE, SUGGEST_CONFIDENCE } from '@/markdown';

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
      expect(detectLanguage('makefile')).toBe('makefile');
    });

    it('Dockerfile pattern match is case-insensitive', () => {
      expect(detectLanguage('DOCKERFILE')).toBe('dockerfile');
      expect(detectLanguage('Dockerfile')).toBe('dockerfile');
      expect(detectLanguage('dockerfile')).toBe('dockerfile');
    });
  });

  describe('extension priority', () => {
    it('detects .ts as typescript', () => {
      expect(detectLanguage('foo.ts')).toBe('typescript');
    });

    it('detects .rs as rust', () => {
      expect(detectLanguage('main.rs')).toBe('rust');
    });

    it('detects .py as python', () => {
      expect(detectLanguage('script.py')).toBe('python');
    });

    it('detects .json as json', () => {
      expect(detectLanguage('package.json')).toBe('json');
    });

    it('detects .md as markdown', () => {
      expect(detectLanguage('README.md')).toBe('markdown');
    });

    it('detects .env as plaintext (breaking change)', () => {
      expect(detectLanguage('.env')).toBe('plaintext');
    });

    it('detects unknown extension as plaintext', () => {
      expect(detectLanguage('file.xyz')).toBe('plaintext');
    });

    it('detects .d.ts as typescript', () => {
      expect(detectLanguage('foo.d.ts')).toBe('typescript');
    });
  });

  describe('pattern priority', () => {
    it('detects .env.local as plaintext', () => {
      expect(detectLanguage('.env.local')).toBe('plaintext');
    });

    it('detects .env.production as plaintext', () => {
      expect(detectLanguage('.env.production')).toBe('plaintext');
    });

    it('detects foo.d.ts as typescript via pattern', () => {
      expect(detectLanguage('foo.d.ts')).toBe('typescript');
    });

    it('detects Dockerfile variant via pattern', () => {
      expect(detectLanguage('my-dockerfile')).toBe('dockerfile');
      expect(detectLanguage('Dockerfile.dev')).toBe('dockerfile');
    });
  });

  describe('shebang priority', () => {
    it('detects shellscript from shebang', () => {
      const content = '#!/usr/bin/env bash\necho hello';
      expect(detectLanguage('deploy', content)).toBe('shellscript');
    });

    it('detects python from shebang', () => {
      const content = '#!/usr/bin/python3\nprint("hi")';
      expect(detectLanguage('script', content)).toBe('python');
    });

    it('detects node from shebang', () => {
      const content = '#!/usr/bin/env node\nconsole.log("hi")';
      expect(detectLanguage('app', content)).toBe('javascript');
    });

    it('ignores shebang when extension exists', () => {
      const content = '#!/usr/bin/env bash\necho hello';
      expect(detectLanguage('script.py', content)).toBe('python');
    });

    it('returns plaintext for unrecognized shebang', () => {
      const content = '#!/usr/bin/custom-interp\nsome stuff';
      expect(detectLanguage('tool', content)).toBe('plaintext');
    });

    it('returns plaintext when no shebang and no extension', () => {
      const content = 'just some text\nno shebang';
      expect(detectLanguage('notes', content)).toBe('plaintext');
    });

    it('detects ruby from shebang', () => {
      const content = '#!/usr/bin/env ruby\nputs "hi"';
      expect(detectLanguage('runner', content)).toBe('ruby');
    });
  });

  describe('content heuristic priority', () => {
    // Content sniffing can never auto-apply a language: markdown has no magic
    // bytes and every plain-text file is valid markdown, so a content guess is
    // capped below the auto-apply confidence and detectLanguage() drops it.
    // Callers that want to *offer* markdown use detectLanguageForFile().
    it('does not resolve markdown from content alone', () => {
      const content = '# Notes\n\n- first item\n- second item\n\nSee the [docs](https://example.com).';
      expect(detectLanguage('NOTES', content)).toBe('plaintext');
    });

    it('reports content-detected markdown below the auto-apply band', () => {
      const content = '# Notes\n\n- first item\n- second item\n\nSee the [docs](https://example.com).';
      const detection = detectLanguageForFile('NOTES', content);
      expect(detection.language).toBe('markdown');
      expect(detection.source).toBe('content');
      expect(detection.confidence).toBeGreaterThanOrEqual(SUGGEST_CONFIDENCE);
      expect(detection.confidence).toBeLessThan(AUTO_APPLY_CONFIDENCE);
    });

    it('does not override basename with content heuristic', () => {
      const content = '# Title\n\nSome paragraph.';
      expect(detectLanguage('Dockerfile', content)).toBe('dockerfile');
    });

    it('does not override extension with content heuristic', () => {
      const content = '# Title\n\nSome paragraph.';
      expect(detectLanguage('README.txt', content)).toBe('markdown');
    });

    it('falls back to plaintext when no heuristic matches', () => {
      const content = 'random text without structure';
      expect(detectLanguage('unknown', content)).toBe('plaintext');
    });
  });

  describe('detectLanguageForFile', () => {
    it('trusts a markdown extension above everything else', () => {
      const detection = detectLanguageForFile('notes.md', 'plain prose, no structure');
      expect(detection.language).toBe('markdown');
      expect(detection.source).toBe('extension');
      expect(detection.confidence).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE);
    });

    it('trusts text/markdown MIME type', () => {
      const detection = detectLanguageForFile('notes', 'plain prose', 'text/markdown');
      expect(detection.language).toBe('markdown');
      expect(detection.source).toBe('mime');
      expect(detection.confidence).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE);
    });

    it('lets a specific extension win over the markdown basename convention', () => {
      // readme.json is JSON. Stripping the extension would make it "readme".
      const detection = detectLanguageForFile('readme.json', '{"a": 1}');
      expect(detection.language).toBe('json');
    });

    it('resolves conventional markdown basenames without an extension', () => {
      const detection = detectLanguageForFile('CHANGELOG', 'plain prose, no structure');
      expect(detection.language).toBe('markdown');
      expect(detection.source).toBe('filename');
      expect(detection.confidence).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE);
    });

    it('keeps justfile out of content sniffing', () => {
      const content = '# Run tests\ntest:\n    cargo test\n\n# Lint\nlint:\n    cargo clippy\n';
      const detection = detectLanguageForFile('justfile', content);
      expect(detection.language).toBe('makefile');
    });

    it('keeps LICENSE as plaintext despite list-heavy content', () => {
      const content = '---\n\n1. Redistribution is permitted\n2. No warranty\n\n---\n';
      expect(detectLanguageForFile('LICENSE', content).language).toBe('plaintext');
    });

    it('reports plaintext with zero confidence when nothing matches', () => {
      const detection = detectLanguageForFile('mystery', 'nothing structured here');
      expect(detection.language).toBe('plaintext');
      expect(detection.confidence).toBe(0);
      expect(detection.source).toBe('fallback');
    });

    it('detects a shebang ahead of markdown content signals', () => {
      const content = '#!/bin/bash\n# Heading-looking comment\n- not a list\n- really\n';
      const detection = detectLanguageForFile('deploy', content);
      expect(detection.language).toBe('shellscript');
    });

    it('works without content', () => {
      expect(detectLanguageForFile('main.rs').language).toBe('rust');
    });
  });
});
