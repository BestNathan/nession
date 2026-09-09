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
});
