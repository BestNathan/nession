import { describe, it, expect } from 'vitest';
import { parseEnv } from '@/lib/envParser';

describe('parseEnv', () => {
  it('parses basic KEY=VALUE pairs', () => {
    const result = parseEnv('FOO=bar\nBAZ=qux\n');
    expect(result.vars).toEqual([['FOO', 'bar'], ['BAZ', 'qux']]);
    expect(result.warnings).toHaveLength(0);
  });

  it('ignores comments and blank lines', () => {
    const result = parseEnv('# a comment\n\n  \nFOO=bar\n');
    expect(result.vars).toEqual([['FOO', 'bar']]);
  });

  it('returns empty for empty or comment-only content', () => {
    expect(parseEnv('').vars).toHaveLength(0);
    expect(parseEnv('# only comments\n\n').vars).toHaveLength(0);
  });

  it('last-occurrence wins for duplicate keys', () => {
    const result = parseEnv('FOO=1\nFOO=2\nFOO=3\n');
    expect(result.vars).toEqual([['FOO', '3']]);
  });

  it('skips malformed lines with warning', () => {
    const result = parseEnv('FOO=bar\nnotanassignment\nBAZ=qux\n');
    expect(result.vars).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('line 2');
  });

  it('skips invalid keys', () => {
    const result = parseEnv('1FOO=bar\nGOOD=ok\n');
    expect(result.vars).toEqual([['GOOD', 'ok']]);
    expect(result.warnings).toHaveLength(1);
  });

  it('strips trailing comments when space before #', () => {
    const result = parseEnv('FOO=bar # trailing\n');
    expect(result.vars).toEqual([['FOO', 'bar']]);
  });

  it('keeps # without preceding space as literal', () => {
    const result = parseEnv('FOO=bar#baz\n');
    expect(result.vars).toEqual([['FOO', 'bar#baz']]);
  });

  it('handles double-quoted values', () => {
    const result = parseEnv('FOO="hello world # not a comment"\n');
    expect(result.vars).toEqual([['FOO', 'hello world # not a comment']]);
  });

  it('handles single-quoted values as literal', () => {
    const result = parseEnv("FOO='a\\nb'\n");
    expect(result.vars).toEqual([['FOO', 'a\\nb']]);
  });

  it('handles double-quote escapes', () => {
    const result = parseEnv('FOO="line1\\nline2\\ttab"\n');
    expect(result.vars).toEqual([['FOO', 'line1\nline2\ttab']]);
  });

  it('tolerates export prefix', () => {
    const result = parseEnv('export FOO=bar\n');
    expect(result.vars).toEqual([['FOO', 'bar']]);
  });

  it('handles whitespace around equals', () => {
    const result = parseEnv('FOO = bar\n');
    expect(result.vars).toEqual([['FOO', 'bar']]);
  });

  it('handles empty value', () => {
    const result = parseEnv('FOO=\n');
    expect(result.vars).toEqual([['FOO', '']]);
  });

  it('handles CRLF line endings', () => {
    const result = parseEnv('FOO=bar\r\nBAZ=qux\r\n');
    expect(result.vars).toEqual([['FOO', 'bar'], ['BAZ', 'qux']]);
  });

  it('falls through to unquoted on unterminated quote', () => {
    const result = parseEnv('FOO="unclosed\n');
    expect(result.vars).toHaveLength(1);
    expect(result.vars[0]).toEqual(['FOO', '"unclosed']);
  });

  it('strips leading UTF-8 BOM', () => {
    const result = parseEnv('﻿FOO=bar\nBAZ=qux\n');
    expect(result.vars).toEqual([['FOO', 'bar'], ['BAZ', 'qux']]);
    expect(result.warnings).toHaveLength(0);
  });
});
