// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PRESETS,
  loadLegacyCommands,
  clearLegacyCommands,
  LEGACY_STORAGE_KEY,
} from '@/components/quickCommands';

describe('quickCommands', () => {
  describe('PRESETS', () => {
    it('contains 5 preset commands', () => {
      expect(PRESETS).toHaveLength(5);
    });

    it('includes Ctrl+C with raw=true', () => {
      const ctrlC = PRESETS.find((c) => c.id === 'preset-ctrl-c');
      expect(ctrlC).toBeDefined();
      expect(ctrlC!.command).toBe('\x03');
      expect(ctrlC!.raw).toBe(true);
    });

    it('all presets have required fields', () => {
      for (const cmd of PRESETS) {
        expect(cmd.id).toBeTruthy();
        expect(typeof cmd.id).toBe('string');
        expect(typeof cmd.label).toBe('string');
        expect(typeof cmd.command).toBe('string');
      }
    });

    it('non-raw presets do not have raw=true', () => {
      const nonRaw = PRESETS.filter((c) => c.id !== 'preset-ctrl-c');
      for (const cmd of nonRaw) {
        expect(cmd.raw).toBeFalsy();
      }
    });
  });

  describe('loadLegacyCommands', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('returns empty array when nothing stored', () => {
      expect(loadLegacyCommands()).toEqual([]);
    });

    it('returns empty array on corrupt JSON', () => {
      localStorage.setItem(LEGACY_STORAGE_KEY, 'not-json');
      expect(loadLegacyCommands()).toEqual([]);
    });

    it('returns empty array when stored value is not an array', () => {
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ foo: 'bar' }));
      expect(loadLegacyCommands()).toEqual([]);
    });

    it('filters entries missing required fields', () => {
      const mixed = [
        { id: 'a', label: 'ok', command: 'ls' },
        { id: 'b' }, // missing label and command
        { label: 'no-id', command: 'whoami' }, // missing id
        { id: 'c', label: 'also-ok', command: 'pwd' },
      ];
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(mixed));
      const result = loadLegacyCommands();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('a');
      expect(result[1].id).toBe('c');
    });

    it('reads well-formed legacy commands', () => {
      const cmds = [
        { id: 'user-1', label: 'npm start', command: 'npm start' },
        { id: 'user-2', label: 'docker ps', command: 'docker ps', raw: true },
      ];
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(cmds));
      expect(loadLegacyCommands()).toEqual(cmds);
    });
  });

  describe('clearLegacyCommands', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('removes the legacy localStorage entry', () => {
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify([{ id: 'x', label: 'y', command: 'z' }]));
      clearLegacyCommands();
      expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
      expect(loadLegacyCommands()).toEqual([]);
    });

    it('does not throw when nothing is stored', () => {
      expect(() => clearLegacyCommands()).not.toThrow();
    });
  });
});
