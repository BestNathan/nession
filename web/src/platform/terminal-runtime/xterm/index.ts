/**
 * The Nession Xterm Engine (#2581).
 *
 * `platform/terminal-runtime/xterm/` is the only production owner of
 * `@xterm/xterm`. Everything above it consumes {@link TerminalEmulator} from
 * `../emulator`: read models, typed disposables, bounded font configuration
 * and link matching. This barrel is the engine's public entry point for the
 * canonical fixture; the raw adapter module is deliberately not re-exported.
 */
export type {
  TerminalBufferSnapshot,
  TerminalCellSize,
  TerminalDisposable,
  TerminalEmulator,
  TerminalLinkLine,
  TerminalLinkMatcher,
  TerminalLinkRange,
  TerminalModeSnapshot,
  TerminalMouseTrackingMode,
} from '../emulator';

export {
  createTerminalEmulator,
  DEFAULT_FONT,
  type CellSizeChangeReason,
  type XtermEmulatorOptions,
} from './XtermEmulator';
export * from './ThemeManager';
