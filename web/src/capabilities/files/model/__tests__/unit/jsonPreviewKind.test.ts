import { describe, it, expect } from 'vitest';
import { getJsonPreviewKind } from '../../jsonPreviewKind';

describe('getJsonPreviewKind', () => {
  it('detects json and jsonl family extensions', () => {
    expect(getJsonPreviewKind('json')).toBe('json');
    expect(getJsonPreviewKind('JSON')).toBe('json');
    expect(getJsonPreviewKind('jsonl')).toBe('jsonl');
    expect(getJsonPreviewKind('ndjson')).toBe('jsonl');
    expect(getJsonPreviewKind('txt')).toBeNull();
  });
});
