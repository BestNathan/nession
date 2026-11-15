import { describe, expect, it } from 'vitest';
import { terminalClearancePolicyFor } from '../../clearancePolicy';
import type { TerminalBufferSnapshot, TerminalModeSnapshot } from '../../../emulator';

const buffer: TerminalBufferSnapshot = {
  type: 'normal',
  length: 100,
  viewportY: 0,
  cursorX: 0,
  cursorY: 0,
};

function modes(overrides: Partial<TerminalModeSnapshot> = {}): TerminalModeSnapshot {
  return {
    applicationCursorKeysMode: false,
    bracketedPasteMode: false,
    mouseTrackingMode: 'none',
    alternateBuffer: false,
    ...overrides,
  };
}

describe('upper-panel clearance policy (#3492)', () => {
  it('keeps reversible scroll clearance for a normal shell without mouse tracking', () => {
    expect(terminalClearancePolicyFor(modes(), buffer)).toBe('scroll-clearance');
  });

  it('reserves rows for the alternate screen', () => {
    expect(terminalClearancePolicyFor(modes({ alternateBuffer: true }), buffer))
      .toBe('viewport-reserve');
    expect(terminalClearancePolicyFor(modes(), { ...buffer, type: 'alternate' }))
      .toBe('viewport-reserve');
  });

  it('reserves rows when the application owns mouse input, even in the normal buffer', () => {
    for (const mouseTrackingMode of ['x10', 'vt200', 'drag', 'any'] as const) {
      expect(terminalClearancePolicyFor(modes({ mouseTrackingMode }), buffer))
        .toBe('viewport-reserve');
    }
  });
});
