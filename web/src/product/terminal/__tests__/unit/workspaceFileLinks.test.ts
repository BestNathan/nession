import { describe, expect, it, vi } from 'vitest';
import {
  findWorkspaceFileLinks,
  parseWorkspaceFileLink,
  workspaceFileLinkMatcher,
} from '../../workspaceFileLinks';

describe('findWorkspaceFileLinks', () => {
  it('returns the precise text and UTF-16 offsets of a path link', () => {
    const text = 'error at src/foo.rs:128:9';
    const links = findWorkspaceFileLinks(text);

    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.text).toBe('src/foo.rs:128');
    expect(link.path).toBe('src/foo.rs');
    expect(link.line).toBe(128);
    expect(text.slice(link.startIndex, link.endIndex)).toBe('src/foo.rs:128');
  });

  it('finds several links on one logical line', () => {
    const text = 'compare ./a.rs with "src/b.ts:42"';

    expect(findWorkspaceFileLinks(text).map((link) => link.path))
      .toEqual(['a.rs', 'src/b.ts']);
  });

  it('rejects parent-relative paths', () => {
    expect(findWorkspaceFileLinks('see ../secrets.txt')).toEqual([]);
  });

  it('keeps parseWorkspaceFileLink as the single-match reader', () => {
    expect(parseWorkspaceFileLink('failed in crates/agent.rs:7')).toEqual({
      path: 'crates/agent.rs',
      line: 7,
    });
    expect(parseWorkspaceFileLink('/etc/passwd')).toBeNull();
  });
});

describe('workspaceFileLinkMatcher (#2581 SC-05)', () => {
  it('maps matched offsets and activation into the emulator port shape', () => {
    const onOpen = vi.fn<(path: string, line?: number) => void>();
    const matcher = workspaceFileLinkMatcher(onOpen);
    const text = 'at src/foo.rs:3';

    const [range] = matcher({ text });

    expect(range!.startIndex).toBe(text.indexOf('src/foo.rs:3'));
    expect(range!.endIndex).toBe(text.length);
    range!.activate();
    expect(onOpen).toHaveBeenCalledWith('src/foo.rs', 3);
  });

  it('returns no ranges for a line without a workspace file', () => {
    expect(workspaceFileLinkMatcher(() => {})({ text: 'plain output' })).toEqual([]);
  });
});
