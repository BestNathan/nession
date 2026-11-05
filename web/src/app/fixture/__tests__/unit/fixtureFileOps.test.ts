import { describe, expect, it } from 'vitest';
import { fixtureFileOps, fixtureFilesControl } from '../../fixtureFileOps';
import { FIXTURE_FILE_CONTENTS, FIXTURE_FILES } from '../../fixtureFiles';

const ops = fixtureFileOps();

describe('fixtureFileOps', () => {
  it('lists the root with synthesized intermediate dirs, no duplicates', async () => {
    const { entries } = await ops.listDir('');
    const paths = entries.map((e) => e.path);
    expect([...paths].sort()).toEqual(['docs', 'fixtures', 'web']);
    expect(entries.every((e) => e.is_dir)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('lists children of a nested directory', async () => {
    const { entries } = await ops.listDir('web/src/app');
    expect(entries.map((e) => e.path)).toEqual(['web/src/app/workspace']);
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

  it('mutations are real: create-only, revision conflicts and no-replace rename', async () => {
    fixtureFilesControl().reset();
    const target = fixtureFileOps();

    const created = await target.writeFile('new/dir/a.ts', 'one', { createOnly: true });
    expect(created.revision).toBeTruthy();
    const loaded = await target.readFile('new/dir/a.ts');
    expect(loaded.revision).toBe(created.revision);
    expect(target.base64Decode(loaded.content)).toBe('one');

    await expect(target.writeFile('new/dir/a.ts', 'two', { createOnly: true }))
      .rejects.toThrow('already_exists');
    await expect(target.writeFile('new/dir/a.ts', 'two', { expectedRevision: 'stale' }))
      .rejects.toThrow('conflict');

    const updated = await target.writeFile('new/dir/a.ts', 'two', {
      expectedRevision: created.revision,
    });
    expect(updated.revision).not.toBe(created.revision);

    await target.createDir('new/folder', { createOnly: true });
    await expect(target.createDir('new/folder', { createOnly: true }))
      .rejects.toThrow('already_exists');

    await target.renameFile('new/dir/a.ts', 'new/dir/b.ts', { noReplace: true });
    await expect(target.readFile('new/dir/a.ts')).rejects.toThrow('fixture: unknown file');
    expect(target.base64Decode((await target.readFile('new/dir/b.ts')).content)).toBe('two');

    await target.writeFile('new/occupied.ts', 'x', { createOnly: true });
    await expect(
      target.renameFile('new/dir/b.ts', 'new/occupied.ts', { noReplace: true }),
    ).rejects.toThrow('already_exists');

    const listing = await target.listDir('new/dir');
    expect(listing.entries.map((entry) => entry.path)).toEqual(['new/dir/b.ts']);

    fixtureFilesControl().reset();
  });

  it('getCwd answers the fixture root', async () => {
    await expect(ops.getCwd('s')).resolves.toEqual({ path: '' });
  });

  it('derives sizes from content so the size column and total_size agree', () => {
    for (const entry of FIXTURE_FILES) {
      const content = FIXTURE_FILE_CONTENTS[entry.path];
      expect(entry.size).toBe(content ? content.length : 0);
    }
  });
});
