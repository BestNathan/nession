import { describe, it, expect, beforeEach } from 'vitest';
import { loadAttachPrefs, saveAttachPrefs } from '../attachPrefs';

describe('attachPrefs', () => {
  beforeEach(() => localStorage.clear());

  it('returns defaults when nothing stored', () => {
    expect(loadAttachPrefs()).toEqual({ mode: 'auto', envFiles: [] });
  });

  it('round-trips saved prefs', () => {
    saveAttachPrefs({ mode: 'relay', envFiles: [{ name: 'a.env', source: 'server' }] });
    const loaded = loadAttachPrefs();
    expect(loaded.mode).toBe('relay');
    expect(loaded.envFiles).toEqual([{ name: 'a.env', source: 'server' }]);
  });

  it('falls back to auto for an invalid stored mode', () => {
    localStorage.setItem('nession_attach_prefs', JSON.stringify({ mode: 'bogus', envFiles: [] }));
    expect(loadAttachPrefs().mode).toBe('auto');
  });

  it('tolerates malformed JSON', () => {
    localStorage.setItem('nession_attach_prefs', 'not json');
    expect(loadAttachPrefs()).toEqual({ mode: 'auto', envFiles: [] });
  });
});
