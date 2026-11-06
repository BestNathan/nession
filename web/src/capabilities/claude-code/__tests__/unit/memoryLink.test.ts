import { describe, expect, it } from 'vitest';
import {
  headingMatchesFragment,
  headingSlug,
  resolveMemoryLink,
} from '../../model/memoryLink';

const files = [
  { path: 'MEMORY.md' },
  { path: 'architecture.md' },
  { path: 'feedback_testing.md' },
  { path: 'topics/design.md' },
  { path: 'topics/recovery.md' },
  { path: 'Ünicode notes.md' },
];

describe('resolveMemoryLink', () => {
  it('keeps safe external links for the shared anchor policy', () => {
    expect(resolveMemoryLink('https://code.claude.com/docs/en/memory', 'MEMORY.md', files))
      .toEqual({ kind: 'external', href: 'https://code.claude.com/docs/en/memory' });
    expect(resolveMemoryLink('HTTP://example.test/x', 'MEMORY.md', files))
      .toEqual({ kind: 'external', href: 'HTTP://example.test/x' });
  });

  it('resolves same-directory, ./ and nested relative Markdown targets', () => {
    expect(resolveMemoryLink('architecture.md', 'MEMORY.md', files))
      .toEqual({ kind: 'file', path: 'architecture.md', fragment: null });
    expect(resolveMemoryLink('./architecture.md#session-boundary', 'MEMORY.md', files))
      .toEqual({ kind: 'file', path: 'architecture.md', fragment: 'session-boundary' });
    expect(resolveMemoryLink('topics/design.md', 'MEMORY.md', files))
      .toEqual({ kind: 'file', path: 'topics/design.md', fragment: null });
    expect(resolveMemoryLink('../architecture.md#session-boundary', 'topics/recovery.md', files))
      .toEqual({ kind: 'file', path: 'architecture.md', fragment: 'session-boundary' });
    expect(resolveMemoryLink('recovery.md#retry-strategy', 'topics/design.md', files))
      .toEqual({ kind: 'file', path: 'topics/recovery.md', fragment: 'retry-strategy' });
  });

  it('treats a fragment alone as navigation within the current document', () => {
    expect(resolveMemoryLink('#session-boundary', 'architecture.md', files))
      .toEqual({ kind: 'fragment', fragment: 'session-boundary' });
    expect(resolveMemoryLink('#', 'architecture.md', files))
      .toEqual({ kind: 'blocked', reason: 'empty', target: '#' });
  });

  it('percent-decodes paths and fragments, and matches decomposed Unicode', () => {
    expect(resolveMemoryLink('topics%2Fdesign.md', 'MEMORY.md', files))
      .toEqual({ kind: 'file', path: 'topics/design.md', fragment: null });
    expect(resolveMemoryLink('topics/design.md#work%20first', 'MEMORY.md', files))
      .toEqual({ kind: 'file', path: 'topics/design.md', fragment: 'work first' });
    const decomposed = 'U\u0308nicode notes.md'; // Ü as U + combining diaeresis
    expect(resolveMemoryLink(decomposed, 'MEMORY.md', files))
      .toEqual({ kind: 'file', path: 'Ünicode notes.md', fragment: null });
  });

  it('refuses traversal above the memory root but allows stepping through it', () => {
    expect(resolveMemoryLink('../private.md', 'MEMORY.md', files).kind).toBe('blocked');
    expect(resolveMemoryLink('../../private.md', 'topics/design.md', files)).toMatchObject({
      kind: 'blocked',
      reason: 'traversal',
    });
    expect(resolveMemoryLink('topics/../architecture.md', 'MEMORY.md', files))
      .toEqual({ kind: 'file', path: 'architecture.md', fragment: null });
  });

  it('refuses absolute paths, backslashes, queries and unsafe schemes', () => {
    expect(resolveMemoryLink('/etc/passwd.md', 'MEMORY.md', files)).toMatchObject({
      kind: 'blocked', reason: 'absolute-path',
    });
    expect(resolveMemoryLink('C:\\memory\\x.md', 'MEMORY.md', files)).toMatchObject({
      kind: 'blocked', reason: 'unsafe-scheme',
    });
    expect(resolveMemoryLink('architecture.md?raw=1', 'MEMORY.md', files)).toMatchObject({
      kind: 'blocked', reason: 'query',
    });
    for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/markdown,x', 'mailto:x@example.test']) {
      expect(resolveMemoryLink(href, 'MEMORY.md', files)).toMatchObject({
        kind: 'blocked', reason: 'unsafe-scheme',
      });
    }
  });

  it('refuses unlisted, non-Markdown, malformed and empty targets', () => {
    expect(resolveMemoryLink('missing.md', 'MEMORY.md', files)).toMatchObject({
      kind: 'blocked', reason: 'unlisted',
    });
    expect(resolveMemoryLink('architecture.txt', 'MEMORY.md', files)).toMatchObject({
      kind: 'blocked', reason: 'unsupported-target',
    });
    expect(resolveMemoryLink('architecture%2E%2E%2FREADME.md', 'MEMORY.md', files)).toMatchObject({
      kind: 'blocked',
    });
    expect(resolveMemoryLink('%E0%A4%A', 'MEMORY.md', files)).toMatchObject({
      kind: 'blocked', reason: 'malformed',
    });
    expect(resolveMemoryLink('', 'MEMORY.md', files)).toEqual({
      kind: 'blocked', reason: 'empty', target: '',
    });
    expect(resolveMemoryLink(undefined, 'MEMORY.md', files)).toEqual({
      kind: 'blocked', reason: 'empty', target: '',
    });
  });
});

describe('heading fragment matching', () => {
  it('matches GitHub-style slugs and plain heading text', () => {
    expect(headingSlug('Session boundary')).toBe('session-boundary');
    expect(headingSlug('Work first')).toBe('work-first');
    expect(headingMatchesFragment('Session boundary', 'session-boundary')).toBe(true);
    expect(headingMatchesFragment('Session boundary', 'Session boundary')).toBe(true);
    expect(headingMatchesFragment('Interaction principles', 'interaction-principles')).toBe(true);
  });

  it('does not match an unrelated heading', () => {
    expect(headingMatchesFragment('Session boundary', 'mobile-ux')).toBe(false);
  });
});
