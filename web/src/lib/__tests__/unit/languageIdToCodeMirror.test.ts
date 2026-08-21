import { describe, expect, it } from 'vitest';
import { languageIdToCodeMirrorKey } from '@/lib/languageIdToCodeMirror';

describe('languageIdToCodeMirrorKey', () => {
  it('maps typescript to ts', () => {
    expect(languageIdToCodeMirrorKey('typescript')).toBe('ts');
  });
  it('maps shellscript to sh', () => {
    expect(languageIdToCodeMirrorKey('shellscript')).toBe('sh');
  });
  it('maps dockerfile to __dockerfile__', () => {
    expect(languageIdToCodeMirrorKey('dockerfile')).toBe('__dockerfile__');
  });
  it('maps ruby to rb', () => {
    expect(languageIdToCodeMirrorKey('ruby')).toBe('rb');
  });
  it('maps python to py', () => {
    expect(languageIdToCodeMirrorKey('python')).toBe('py');
  });
  it('returns null for plaintext', () => {
    expect(languageIdToCodeMirrorKey('plaintext')).toBeNull();
  });
  it('returns null for go (no grammar in UIW)', () => {
    expect(languageIdToCodeMirrorKey('go')).toBeNull();
  });
});
