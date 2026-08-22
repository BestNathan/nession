import { describe, it, expect } from 'vitest';
import { decodeBase64Utf8, encodeUtf8Base64 } from '../../encoding';

describe('decodeBase64Utf8', () => {
  it('decodes ASCII', () => {
    expect(decodeBase64Utf8(btoa('hello'))).toBe('hello');
  });
  it('decodes non-ASCII UTF-8', () => {
    const text = '你好世界';
    expect(decodeBase64Utf8(encodeUtf8Base64(text))).toBe(text);
  });
  it('decodes ANSI escape sequences', () => {
    const ansi = '\x1b[31mred\x1b[0m';
    expect(decodeBase64Utf8(encodeUtf8Base64(ansi))).toBe(ansi);
  });
});

describe('encodeUtf8Base64', () => {
  it('encodes ASCII', () => {
    expect(encodeUtf8Base64('hello')).toBe(btoa('hello'));
  });
  it('round-trips', () => {
    const text = 'hello 你好 \x1b[31mred\x1b[0m';
    expect(decodeBase64Utf8(encodeUtf8Base64(text))).toBe(text);
  });
});
