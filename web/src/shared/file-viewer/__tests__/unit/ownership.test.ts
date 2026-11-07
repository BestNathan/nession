import { describe, expect, it } from 'vitest';

/**
 * #2876 SC-07: one presentation owner, consumed by both capabilities.
 *
 * This is the static half of the proof: Files and Git import the shared entry
 * point (and supply the platform-owned editor), while the shared package
 * imports no capability, app, product or platform IO. The behavioural half is
 * the component tests beside this file.
 *
 * Sources are read through Vite's raw glob rather than `node:fs` so the test
 * stays inside the web TypeScript program.
 */
const SOURCES = import.meta.glob<string>(
  [
    '../../**/*.{ts,tsx}',
    '../../../../capabilities/files/components/FileViewer.tsx',
    '../../../../capabilities/git/components/GitFilePreviewView.tsx',
    '../../../../capabilities/files/model/viewerRegistry.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
);

function sourceEndingWith(suffix: string): string {
  const key = Object.keys(SOURCES).find((candidate) => candidate.endsWith(suffix));
  if (!key) {
    throw new Error(`source not found: ${suffix}`);
  }
  return SOURCES[key];
}

const sharedSources = () =>
  Object.entries(SOURCES).filter(
    ([path]) =>
      path.startsWith('../../') &&
      !path.startsWith('../../../../') &&
      !path.includes('__tests__'),
  );

describe('shared file-viewer ownership (#2876 SC-07)', () => {
  it('is consumed by both Files and Git Changes', () => {
    for (const suffix of [
      'capabilities/files/components/FileViewer.tsx',
      'capabilities/git/components/GitFilePreviewView.tsx',
    ]) {
      const source = sourceEndingWith(suffix);
      expect(source, suffix).toContain("from '@/shared/file-viewer'");
      expect(source, suffix).toContain('<FileContentViewer');
      // The platform editor primitive is supplied by the caller because the
      // layer rule forbids `shared -> platform`.
      expect(source, suffix).toContain('sourceEditor={CodeMirrorEditor}');
    }
  });

  it('has exactly one format policy', () => {
    const policy = sourceEndingWith('presentation.ts');
    expect(policy).toContain('export function resolveFilePresentation');

    // The Files path is a compatibility re-export, not a second table.
    const compat = sourceEndingWith('capabilities/files/model/viewerRegistry.ts');
    expect(compat).toContain("export * from '@/shared/file-viewer/model/viewerRegistry'");
    expect(compat).not.toContain('EXT_VIEWER_MAP');
  });

  it('has no capability, app, product or provider IO imports', () => {
    const forbidden = [
      /from\s+['"]@\/capabilities\//,
      /from\s+['"]@\/(app|product)\//,
      /from\s+['"]@\/platform\//,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bgitApi\b/,
      /\bfileOps\b/,
    ];
    const files = sharedSources();
    expect(files.length).toBeGreaterThan(5);
    for (const [path, source] of files) {
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path} matches ${pattern}`).toBe(false);
      }
    }
  });
});
