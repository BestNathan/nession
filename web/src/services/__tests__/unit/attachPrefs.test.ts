// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAttachPrefs, saveAttachPrefs } from '@/services/attachPrefs';

describe('attachPrefs', () => {
  beforeEach(() => localStorage.clear());

  it('returns defaults when nothing stored', () => {
    expect(loadAttachPrefs()).toEqual({ mode: 'auto', renderer: 'webgl' });
  });

  it('round-trips saved mode', () => {
    saveAttachPrefs({ mode: 'p2p', renderer: 'webgl' });
    expect(loadAttachPrefs().mode).toBe('p2p');
  });

  it('falls back to auto for an invalid stored mode', () => {
    localStorage.setItem('nession_attach_prefs', JSON.stringify({ mode: 'bogus' }));
    expect(loadAttachPrefs().mode).toBe('auto');
  });

  it('tolerates malformed JSON', () => {
    localStorage.setItem('nession_attach_prefs', 'not json');
    expect(loadAttachPrefs()).toEqual({ mode: 'auto', renderer: 'webgl' });
  });

  it('defaults renderer to webgl', () => {
    expect(loadAttachPrefs().renderer).toBe('webgl');
  });

  it('round-trips saved renderer', () => {
    saveAttachPrefs({ mode: 'auto', renderer: 'canvas' });
    expect(loadAttachPrefs().renderer).toBe('canvas');
  });

  it('falls back to webgl for an invalid stored renderer', () => {
    localStorage.setItem('nession_attach_prefs', JSON.stringify({ mode: 'auto', renderer: 'bogus' }));
    expect(loadAttachPrefs().renderer).toBe('webgl');
  });
});
