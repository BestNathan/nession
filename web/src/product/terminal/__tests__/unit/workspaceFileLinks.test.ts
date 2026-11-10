import { describe, expect, it, vi } from 'vitest';
import {
  findWorkspaceFileLinks,
  normalizeTerminalFilePath,
  parseWorkspaceFileLink,
  workspaceFileLinkMatcher,
} from '../../workspaceFileLinks';

describe('findWorkspaceFileLinks', () => {
  it('returns the precise text and UTF-16 offsets of a path link', () => {
    const text = 'error at src/foo.rs:128:9';
    const links = findWorkspaceFileLinks(text);

    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.text).toBe('src/foo.rs:128:9');
    expect(link.rawPath).toBe('src/foo.rs');
    expect(link.path).toBe('src/foo.rs');
    expect(link.line).toBe(128);
    expect(link.column).toBe(9);
    expect(text.slice(link.startIndex, link.endIndex)).toBe('src/foo.rs:128:9');
  });

  it('finds several links on one logical line', () => {
    const text = 'compare ./a.rs with "src/b.ts:42"';

    expect(findWorkspaceFileLinks(text).map((link) => link.path))
      .toEqual(['a.rs', 'src/b.ts']);
  });

  it('excludes the quote from the underlined span of a quoted reference', () => {
    const text = 'see "src/a.ts:7:2" now';
    const [link] = findWorkspaceFileLinks(text);

    expect(link!.text).toBe('src/a.ts:7:2');
    expect(text.slice(link!.startIndex, link!.endIndex)).toBe('src/a.ts:7:2');
  });

  it('keeps an absolute path absolute instead of stripping its root', () => {
    expect(findWorkspaceFileLinks('at /var/log/app.log:5')[0]).toMatchObject({
      path: '/var/log/app.log',
      line: 5,
    });
  });

  it('accepts ./ and ../ references for the resolver to join against the CWD', () => {
    expect(findWorkspaceFileLinks('see ../shared/type.ts')[0]).toMatchObject({
      path: '../shared/type.ts',
    });
    expect(findWorkspaceFileLinks('see ./local.ts:2')[0]).toMatchObject({
      path: 'local.ts',
      line: 2,
    });
  });

  it('rejects URL schemes, timestamps and extensionless tokens', () => {
    expect(findWorkspaceFileLinks('open https://example.com/a.py now')).toEqual([]);
    expect(findWorkspaceFileLinks('file:///tmp/a.py')).toEqual([]);
    expect(findWorkspaceFileLinks('at 12:34:56 today')).toEqual([]);
    expect(findWorkspaceFileLinks('run make install')).toEqual([]);
  });

  it('keeps parseWorkspaceFileLink as the single-match reader', () => {
    expect(parseWorkspaceFileLink('failed in crates/agent.rs:7:3')).toEqual({
      rawPath: 'crates/agent.rs',
      path: 'crates/agent.rs',
      line: 7,
      column: 3,
    });
    expect(parseWorkspaceFileLink('/etc/app.conf')).toMatchObject({ path: '/etc/app.conf' });
    expect(parseWorkspaceFileLink('no file here')).toBeNull();
  });
});

describe('normalizeTerminalFilePath', () => {
  it('collapses . and .. segments without losing an absolute root', () => {
    expect(normalizeTerminalFilePath('./a/./b.ts')).toBe('a/b.ts');
    expect(normalizeTerminalFilePath('a/../b.ts')).toBe('b.ts');
    expect(normalizeTerminalFilePath('../a.ts')).toBe('../a.ts');
    expect(normalizeTerminalFilePath('/tmp/../etc/a.conf')).toBe('/etc/a.conf');
  });
});

describe('workspaceFileLinkMatcher (#2581 SC-05)', () => {
  it('maps matched offsets and activation into the emulator port shape', () => {
    const onOpen = vi.fn<(path: string, line?: number, column?: number) => void>();
    const matcher = workspaceFileLinkMatcher(onOpen);
    const text = 'at src/foo.rs:3';

    const [range] = matcher({ text });

    expect(range!.startIndex).toBe(text.indexOf('src/foo.rs:3'));
    expect(range!.endIndex).toBe(text.length);
    range!.activate();
    expect(onOpen).toHaveBeenCalledWith('src/foo.rs', 3, undefined);
  });

  it('passes a column through activation', () => {
    const onOpen = vi.fn<(path: string, line?: number, column?: number) => void>();
    const [range] = workspaceFileLinkMatcher(onOpen)({ text: 'at src/a.py:8:4' });

    range!.activate();
    expect(onOpen).toHaveBeenCalledWith('src/a.py', 8, 4);
  });

  it('returns no ranges for a line without a workspace file', () => {
    expect(workspaceFileLinkMatcher(() => {})({ text: 'plain output' })).toEqual([]);
  });
});
