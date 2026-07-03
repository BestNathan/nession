import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PRESETS, loadUserCommands, saveUserCommands } from '../quickCommands';

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

  describe('loadUserCommands', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('returns empty array when nothing stored', () => {
      expect(loadUserCommands()).toEqual([]);
    });

    it('returns empty array on corrupt JSON', () => {
      localStorage.setItem('nession_quick_commands', 'not-json');
      expect(loadUserCommands()).toEqual([]);
    });

    it('returns empty array when stored value is not an array', () => {
      localStorage.setItem('nession_quick_commands', JSON.stringify({ foo: 'bar' }));
      expect(loadUserCommands()).toEqual([]);
    });

    it('filters entries missing required fields', () => {
      const mixed = [
        { id: 'a', label: 'ok', command: 'ls' },
        { id: 'b' }, // missing label and command
        { label: 'no-id', command: 'whoami' }, // missing id
        { id: 'c', label: 'also-ok', command: 'pwd' },
      ];
      localStorage.setItem('nession_quick_commands', JSON.stringify(mixed));
      const result = loadUserCommands();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('a');
      expect(result[1].id).toBe('c');
    });
  });

  describe('saveUserCommands + loadUserCommands roundtrip', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('persists and restores commands', () => {
      const cmds = [
        { id: 'user-1', label: 'npm start', command: 'npm start' },
        { id: 'user-2', label: 'docker ps', command: 'docker ps' },
      ];
      saveUserCommands(cmds);
      const restored = loadUserCommands();
      expect(restored).toEqual(cmds);
    });

    it('handles empty array', () => {
      saveUserCommands([]);
      expect(loadUserCommands()).toEqual([]);
    });
  });

  describe('saveUserCommands error handling', () => {
    it('does not throw when localStorage is full', () => {
      // Simulate quota exceeded
      const orig = localStorage.setItem;
      localStorage.setItem = vi.fn(() => {
        throw new Error('QuotaExceededError');
      });
      expect(() => saveUserCommands([{ id: 'x', label: 'y', command: 'z' }])).not.toThrow();
      localStorage.setItem = orig;
    });
  });
});
