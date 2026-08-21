import { describe, expect, it } from 'vitest';
import { detectLanguage } from '@/lib/languageId';

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
    it('detects .gitignore as plaintext', () => {
      expect(detectLanguage('.gitignore')).toBe('plaintext');
    });
    it('detects .bashrc as shellscript', () => {
      expect(detectLanguage('.bashrc')).toBe('shellscript');
    });
  });
});
