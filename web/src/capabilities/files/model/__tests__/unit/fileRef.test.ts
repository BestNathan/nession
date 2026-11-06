import { describe, expect, it } from 'vitest';
import {
  fileRefEquals,
  fileRefKey,
  isRefInSource,
  makeFileRef,
  normalizeFilePath,
  resolveFileSource,
} from '@/capabilities/files/model/fileRef';
import type { FileOps } from '@/capabilities/files';

const ops = {} as FileOps;

describe('file identity and source resolution', () => {
  it('prefers the Session id and falls back to the Agent for the source identity', () => {
    expect(resolveFileSource({ sessionId: 's1', agentId: 'a1', fileOps: ops }).id).toBe('session:s1');
    expect(resolveFileSource({ agentId: 'a1', fileOps: ops }).id).toBe('agent:a1');
    expect(resolveFileSource({ fileOps: ops }).id).toBe('unbound');
  });

  it('an absent provider is explicitly unavailable, with no fallback', () => {
    const source = resolveFileSource({ sessionId: 's1', fileOps: null });
    expect(source.available).toBe(false);
    expect(source.fileOps).toBeNull();
    expect(source.reason).toContain('No file provider');
    expect(makeFileRef(source, 'a.ts')).toBeNull();
  });

  it('refs are scoped to the source and normalize only the separators the wire does not own', () => {
    const source = resolveFileSource({ sessionId: 's1', fileOps: ops });
    const ref = makeFileRef(source, '/src/a.ts/');
    expect(ref).toEqual({ sourceId: 'session:s1', path: 'src/a.ts' });
    expect(normalizeFilePath('//a/b//')).toBe('a/b');
    expect(fileRefKey(ref!)).toBe('session:s1:src/a.ts');
  });

  it('a ref from another source is not in the current source', () => {
    const first = resolveFileSource({ sessionId: 's1', fileOps: ops });
    const second = resolveFileSource({ sessionId: 's2', fileOps: ops });
    const ref = makeFileRef(first, 'src/a.ts');
    expect(isRefInSource(ref, first)).toBe(true);
    expect(isRefInSource(ref, second)).toBe(false);
    expect(fileRefEquals(ref, makeFileRef(first, 'src/a.ts'))).toBe(true);
    expect(fileRefEquals(ref, makeFileRef(second, 'src/a.ts'))).toBe(false);
  });
});
