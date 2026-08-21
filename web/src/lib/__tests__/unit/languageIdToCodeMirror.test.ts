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
  it('maps go to go', () => {
    expect(languageIdToCodeMirrorKey('go')).toBe('go');
  });
  it('maps zsh to sh', () => {
    expect(languageIdToCodeMirrorKey('zsh')).toBe('sh');
  });
  it('maps fish to sh', () => {
    expect(languageIdToCodeMirrorKey('fish')).toBe('sh');
  });
  it('maps makefile to sh', () => {
    expect(languageIdToCodeMirrorKey('makefile')).toBe('sh');
  });
  it('returns null for elixir (no grammar in UIW)', () => {
    expect(languageIdToCodeMirrorKey('elixir')).toBeNull();
  });
  it('returns null for graphql (no grammar in UIW)', () => {
    expect(languageIdToCodeMirrorKey('graphql')).toBeNull();
  });
  it('returns null for terraform (no grammar in UIW)', () => {
    expect(languageIdToCodeMirrorKey('terraform')).toBeNull();
  });
});
