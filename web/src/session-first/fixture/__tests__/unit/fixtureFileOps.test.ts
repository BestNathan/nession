import { describe, expect, it } from 'vitest';
import { fixtureFileOps } from '../../fixtureFileOps';
import { FIXTURE_FILE_CONTENTS, FIXTURE_FILES } from '../../fixtureFiles';

const ops = fixtureFileOps();

describe('fixtureFileOps', () => {
  it('lists the root with synthesized intermediate dirs, no duplicates', async () => {
    const { entries } = await ops.listDir('');
    const paths = entries.map((e) => e.path);
    expect([...paths].sort()).toEqual(['docs', 'web']);
    expect(entries.every((e) => e.is_dir)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('lists children of a nested directory', async () => {
    const { entries } = await ops.listDir('web/src/session-first');
    expect(entries.map((e) => e.path)).toEqual(['web/src/session-first/workspace']);
  });

  it('lists leaf files under docs/design', async () => {
    const { entries } = await ops.listDir('docs/design');
    expect(entries.map((e) => e.path).sort()).toEqual([
      'docs/design/composition.md',
      'docs/design/visual-language.md',
    ]);
  });

  it('returns an empty listing for an unknown path', async () => {
    await expect(ops.listDir('nope')).resolves.toEqual({ entries: [] });
  });

  it('serves file contents as base64 with chunked-read metadata', async () => {
    const path = 'web/src/App.tsx';
    const content = FIXTURE_FILE_CONTENTS[path];
    const data = await ops.readFile(path);
    expect(ops.base64Decode(data.content)).toBe(content);
    expect(data.total_size).toBe(content.length);
    expect(data.has_more).toBe(false);
  });

  it('applies offset/limit with has_more flags', async () => {
    const path = 'web/src/App.tsx';
    const content = FIXTURE_FILE_CONTENTS[path];
    const first = await ops.readFile(path, { offset: 0, limit: 10 });
    expect(ops.base64Decode(first.content)).toBe(content.slice(0, 10));
    expect(first.offset).toBe(0);
    expect(first.total_size).toBe(content.length);
    expect(first.has_more).toBe(true);
    const atEnd = await ops.readFile(path, { offset: content.length });
    expect(ops.base64Decode(atEnd.content)).toBe('');
    expect(atEnd.has_more).toBe(false);
  });

  it('rejects unknown file paths', async () => {
    await expect(ops.readFile('nope.md')).rejects.toThrow('fixture: unknown file');
  });

  it('round-trips base64 including unicode', () => {
    expect(ops.base64Decode(ops.base64Encode('hello 终端'))).toBe('hello 终端');
  });

  it('rejects mutating operations as not supported', async () => {
    await expect(ops.writeFile('a.ts', 'x')).rejects.toThrow('fixture: not supported');
    await expect(ops.deleteFile('a.ts')).rejects.toThrow('fixture: not supported');
    await expect(ops.createDir('d')).rejects.toThrow('fixture: not supported');
    await expect(ops.renameFile('a', 'b')).rejects.toThrow('fixture: not supported');
    await expect(ops.getCwd('s')).rejects.toThrow('fixture: not supported');
    await expect(ops.uploadFile('a.ts', {} as File)).rejects.toThrow('fixture: not supported');
  });

  it('derives sizes from content so the size column and total_size agree', () => {
    for (const entry of FIXTURE_FILES) {
      const content = FIXTURE_FILE_CONTENTS[entry.path];
      expect(entry.size).toBe(content ? content.length : 0);
    }
  });
});
