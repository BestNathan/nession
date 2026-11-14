import { describe, expect, it, vi } from 'vitest';
import type { FileEntry, FileOps } from '@/capabilities/files';
import {
  joinTerminalFileReference,
  resolveTerminalFileReference,
  sourceParentDirectory,
} from '../../terminalFileReference';

function entry(path: string, options: Partial<FileEntry> = {}): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    name,
    path,
    full_path: path.startsWith('/') ? path : `/${path}`,
    is_dir: false,
    size: 10,
    modified: 0,
    ...options,
  };
}

function makeFileOps(options: {
  cwd?: string | Error;
  entries?: FileEntry[];
  listError?: Error;
}): FileOps {
  return {
    listDir: vi.fn(async () => {
      if (options.listError) {
        throw options.listError;
      }
      return { entries: options.entries ?? [] };
    }),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    createDir: vi.fn(),
    renameFile: vi.fn(),
    getCwd: vi.fn(async () => {
      if (options.cwd instanceof Error) {
        throw options.cwd;
      }
      return { path: options.cwd ?? '' };
    }),
    uploadFile: vi.fn(),
    base64Decode: (value: string) => atob(value),
    base64Encode: (value: string) => btoa(value),
  } as unknown as FileOps;
}

describe('terminalFileReference', () => {
  it('joins a relative reference onto the source-relative CWD', () => {
    expect(joinTerminalFileReference('src/app', 'components/a.ts')).toBe(
      'src/app/components/a.ts',
    );
    expect(joinTerminalFileReference('src/app', './components/../b.ts')).toBe('src/app/b.ts');
    expect(joinTerminalFileReference('src/app', '../root.ts')).toBe('src/root.ts');
    expect(joinTerminalFileReference('', 'a.ts')).toBe('a.ts');
    expect(joinTerminalFileReference('/tmp/work', 'a.ts')).toBe('/tmp/work/a.ts');
  });

  it('keeps the source-relative root and the filesystem root distinct (#3414)', () => {
    // `''` means "the source root"; `'/'` means the host filesystem root. The
    // join must not conflate them: only `''` leaves the reference relative.
    expect(joinTerminalFileReference('', 'src/foo.rs')).toBe('src/foo.rs');
    expect(joinTerminalFileReference('/', 'src/foo.rs')).toBe('/src/foo.rs');
    expect(joinTerminalFileReference('/', './src/../foo.rs')).toBe('/foo.rs');
    expect(joinTerminalFileReference('/', '/src/foo.rs')).toBe('/src/foo.rs');
  });

  it('keeps an absolute reference absolute on the same source', () => {
    expect(joinTerminalFileReference('src/app', '/etc/app.conf')).toBe('/etc/app.conf');
  });

  it('resolves a relative reference against the Session CWD at activation time', async () => {
    const fileOps = makeFileOps({
      cwd: 'src/deep',
      entries: [entry('src/deep/target.py')],
    });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: 'target.py',
      line: 7,
      column: 3,
    });

    expect(fileOps.getCwd).toHaveBeenCalledWith('sess');
    expect(fileOps.listDir).toHaveBeenCalledWith('src/deep');
    expect(resolution).toEqual({
      ok: true,
      target: {
        path: 'src/deep/target.py',
        name: 'target.py',
        size: 10,
        line: 7,
        column: 3,
      },
    });
  });

  it('resolves a relative reference from a filesystem-root CWD against the absolute parent (#3414)', async () => {
    const relativeLookalike = entry('src/foo.rs');
    const absoluteTarget = {
      ...entry('src/foo.rs'),
      path: '/src/foo.rs',
      full_path: '/src/foo.rs',
    };
    const fileOps = makeFileOps({ cwd: '/' });
    vi.mocked(fileOps.listDir).mockImplementation(async (dir: string) => {
      if (dir === '/src') {
        return { entries: [absoluteTarget] };
      }
      if (dir === 'src') {
        return { entries: [relativeLookalike] };
      }
      throw new Error(`not_found: ${dir}`);
    });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: 'src/foo.rs',
      line: 42,
    });

    expect(fileOps.listDir).toHaveBeenCalledWith('/src');
    expect(fileOps.listDir).not.toHaveBeenCalledWith('src');
    expect(resolution).toEqual({
      ok: true,
      target: {
        path: '/src/foo.rs',
        name: 'foo.rs',
        size: 10,
        line: 42,
        column: undefined,
      },
    });
  });

  it('does not fall back to a source-relative lookalike when the root target is absent (#3414)', async () => {
    const fileOps = makeFileOps({ cwd: '/' });
    vi.mocked(fileOps.listDir).mockImplementation(async (dir: string) => {
      if (dir === 'src') {
        // The wrong target the pre-#3414 join would have selected.
        return { entries: [entry('src/foo.rs')] };
      }
      throw new Error(`not_found: ${dir}`);
    });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: 'src/foo.rs',
    });

    expect(resolution).toEqual({
      ok: false,
      reason: expect.stringContaining('/src/foo.rs'),
    });
    expect(fileOps.listDir).toHaveBeenCalledWith('/src');
    expect(fileOps.listDir).not.toHaveBeenCalledWith('src');
  });

  it('normalizes ./ and ../ before listing the target directory', async () => {
    const fileOps = makeFileOps({
      cwd: 'src/deep',
      entries: [entry('src/root.py')],
    });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: '../root.py',
    });

    expect(fileOps.listDir).toHaveBeenCalledWith('src');
    expect(resolution.ok && resolution.target.path).toBe('src/root.py');
  });

  it('rejects a missing file instead of choosing a same-basename target', async () => {
    const fileOps = makeFileOps({
      cwd: '',
      entries: [entry('other/target.py')],
    });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: 'target.py',
    });

    expect(resolution).toEqual({
      ok: false,
      reason: expect.stringContaining('may have been moved or deleted'),
    });
  });

  it('rejects a directory target', async () => {
    const fileOps = makeFileOps({
      cwd: '',
      entries: [entry('generated.py', { is_dir: true })],
    });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: 'generated.py',
    });

    expect(resolution).toEqual({
      ok: false,
      reason: expect.stringContaining('it is a directory, not a file'),
    });
  });

  it('matches an in-source absolute reference through the source full path', async () => {
    const fileOps = makeFileOps({
      cwd: '',
      entries: [entry('src/deep/target.py')],
    });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: '/src/deep/target.py',
      line: 2,
    });

    expect(fileOps.getCwd).not.toHaveBeenCalled();
    expect(resolution.ok && resolution.target.path).toBe('src/deep/target.py');
  });

  it('matches the exact child when the source spells the parent differently', async () => {
    // macOS reports /tmp as /private/tmp; the listing is of the referenced
    // parent, so the one child with that name is still the exact target.
    const fileOps = makeFileOps({
      cwd: '',
      entries: [{
        ...entry('src/deep/target.py'),
        full_path: '/private/tmp/work/src/deep/target.py',
      }],
    });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: '/tmp/work/src/deep/target.py',
    });

    expect(resolution.ok && resolution.target.path).toBe('src/deep/target.py');
  });

  it('treats a not-found parent listing as a missing file', async () => {
    const fileOps = makeFileOps({
      cwd: '',
      listError: new Error('not_found: missing (resolved to /missing)'),
    });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: 'missing/a.py',
    });

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toContain('may have been moved or deleted');
    }
  });

  it('refuses to guess when the CWD cannot be read', async () => {
    const fileOps = makeFileOps({ cwd: new Error('cwd_failed') });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: 'a.py',
    });

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toContain('working directory');
    }
  });

  it('refuses an ambiguous match rather than picking one', async () => {
    const fileOps = makeFileOps({
      cwd: '',
      entries: [
        entry('a.py'),
        entry('/a.py', { full_path: 'a.py' }),
      ],
    });

    const resolution = await resolveTerminalFileReference(fileOps, 'sess', {
      path: 'a.py',
    });

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toContain('ambiguous');
    }
  });

  it('derives the source parent without losing an absolute root', () => {
    expect(sourceParentDirectory('a.ts')).toBe('');
    expect(sourceParentDirectory('src/a.ts')).toBe('src');
    expect(sourceParentDirectory('/a.ts')).toBe('/');
    expect(sourceParentDirectory('/tmp/a.ts')).toBe('/tmp');
  });
});
