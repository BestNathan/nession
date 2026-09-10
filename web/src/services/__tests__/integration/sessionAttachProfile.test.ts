// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSessionProfile,
  saveSessionProfile,
  type PersistedAttachChoice,
} from '@/services/sessionAttachProfile';

const session = {
  session_id: 'agent-1:dev',
  agent_id: 'agent-1',
};

const choice: PersistedAttachChoice = {
  mode: 'p2p',
  renderer: 'webgl',
  envRefs: [{ name: 'prod.env', source: 'server' }],
  selectedUrl: null,
};

/** A structurally valid stored entry for the test session. */
const validEntry = {
  schemaVersion: 1,
  sessionId: session.session_id,
  agentId: session.agent_id,
  optionsFingerprint: 'fp-1',
  updatedAt: 1,
  choice,
};

/** Seed the storage blob with one entry for the test session. */
function seedEntry(entry: unknown): void {
  localStorage.setItem(
    'nession_session_attach_profiles',
    JSON.stringify({ 'agent-1:dev': entry }),
  );
}

describe('sessionAttachProfile storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when nothing is stored', () => {
    expect(loadSessionProfile(session)).toBeNull();
  });

  it('round-trips a saved profile for its session', () => {
    saveSessionProfile(session, choice, 'fp-1');
    const loaded = loadSessionProfile(session);
    expect(loaded).not.toBeNull();
    expect(loaded?.schemaVersion).toBe(1);
    expect(loaded?.sessionId).toBe('agent-1:dev');
    expect(loaded?.agentId).toBe('agent-1');
    expect(loaded?.optionsFingerprint).toBe('fp-1');
    expect(loaded?.choice).toEqual(choice);
    expect(loaded?.updatedAt).toBeGreaterThan(0);
  });

  it('isolates profiles between sessions', () => {
    saveSessionProfile(session, choice, 'fp-1');
    const other = { session_id: 'agent-2:other', agent_id: 'agent-2' };
    expect(loadSessionProfile(other)).toBeNull();
  });

  it('overwrites an existing profile for the same session', () => {
    saveSessionProfile(session, { ...choice, mode: 'relay' }, 'fp-1');
    saveSessionProfile(session, { ...choice, mode: 'p2p' }, 'fp-2');
    expect(loadSessionProfile(session)?.choice.mode).toBe('p2p');
    expect(loadSessionProfile(session)?.optionsFingerprint).toBe('fp-2');
  });

  it('keeps other sessions when one is overwritten', () => {
    saveSessionProfile({ session_id: 'a:one', agent_id: 'a' }, choice, 'fp-1');
    saveSessionProfile({ session_id: 'a:two', agent_id: 'a' }, choice, 'fp-2');
    expect(loadSessionProfile({ session_id: 'a:one', agent_id: 'a' })?.optionsFingerprint).toBe('fp-1');
    expect(loadSessionProfile({ session_id: 'a:two', agent_id: 'a' })?.optionsFingerprint).toBe('fp-2');
  });

  it('returns null for a session whose profile entry is corrupt', () => {
    localStorage.setItem(
      'nession_session_attach_profiles',
      JSON.stringify({ 'agent-1:dev': { schemaVersion: 999 } }),
    );
    expect(loadSessionProfile(session)).toBeNull();
  });

  it('returns null when the stored blob is not JSON', () => {
    localStorage.setItem('nession_session_attach_profiles', '{not json');
    expect(loadSessionProfile(session)).toBeNull();
  });

  it('returns null when the profile was written for a different agent', () => {
    saveSessionProfile(session, choice, 'fp-1');
    const renamed = { session_id: 'agent-1:dev', agent_id: 'agent-2' };
    expect(loadSessionProfile(renamed)).toBeNull();
  });

  it('returns null when a profile entry has non-array envRefs', () => {
    seedEntry({
      ...validEntry,
      choice: { ...validEntry.choice, envRefs: 'nope' },
    });
    expect(loadSessionProfile(session)).toBeNull();
  });

  it('drops malformed envRef members but keeps valid ones', () => {
    seedEntry({
      ...validEntry,
      choice: {
        ...validEntry.choice,
        envRefs: [
          { name: 'prod.env', source: 'server' },
          { name: 5, source: 'server' },
          { name: 'x.env', source: 'bogus' },
        ],
      },
    });
    expect(loadSessionProfile(session)?.choice.envRefs).toEqual([
      { name: 'prod.env', source: 'server' },
    ]);
  });

  it('drops an envRef member with a non-string agent_id', () => {
    seedEntry({
      ...validEntry,
      choice: {
        ...validEntry.choice,
        envRefs: [{ name: 'prod.env', source: 'server', agent_id: 7 }],
      },
    });
    expect(loadSessionProfile(session)?.choice.envRefs).toEqual([]);
  });

  it('recovers when the stored blob is a JSON array', () => {
    localStorage.setItem('nession_session_attach_profiles', '["stale","blob"]');
    saveSessionProfile(session, choice, 'fp-9');
    const loaded = loadSessionProfile(session);
    expect(loaded).not.toBeNull();
    expect(loaded?.optionsFingerprint).toBe('fp-9');
  });

  it('returns null when the stored blob is JSON but not an object', () => {
    localStorage.setItem('nession_session_attach_profiles', JSON.stringify('not-an-object'));
    expect(loadSessionProfile(session)).toBeNull();
  });

  it('returns null when a choice field is malformed', () => {
    seedEntry({ ...validEntry, choice: { ...validEntry.choice, mode: 'bogus' } });
    expect(loadSessionProfile(session)).toBeNull();
    seedEntry({ ...validEntry, choice: { ...validEntry.choice, renderer: 'bogus' } });
    expect(loadSessionProfile(session)).toBeNull();
    seedEntry({ ...validEntry, choice: { ...validEntry.choice, selectedUrl: 42 } });
    expect(loadSessionProfile(session)).toBeNull();
  });
});
