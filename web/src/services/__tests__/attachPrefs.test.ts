import { describe, it, expect, beforeEach } from 'vitest';
import { loadAttachPrefs, saveAttachPrefs } from '../attachPrefs';

describe('attachPrefs', () => {
  beforeEach(() => localStorage.clear());

  it('returns defaults when nothing stored', () => {
    expect(loadAttachPrefs()).toEqual({ mode: 'auto' });
  });

  it('round-trips saved mode', () => {
    saveAttachPrefs({ mode: 'p2p' });
    expect(loadAttachPrefs().mode).toBe('p2p');
  });

  it('falls back to auto for an invalid stored mode', () => {
    localStorage.setItem('nession_attach_prefs', JSON.stringify({ mode: 'bogus' }));
    expect(loadAttachPrefs().mode).toBe('auto');
  });

  it('tolerates malformed JSON', () => {
    localStorage.setItem('nession_attach_prefs', 'not json');
    expect(loadAttachPrefs()).toEqual({ mode: 'auto' });
  });
});
