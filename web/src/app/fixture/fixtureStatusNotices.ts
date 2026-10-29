import type { TerminalControlState } from '@/product/terminal/state/terminalControl';
import type { ClipboardNoticeState } from '@/product/terminal/state/ui';
import type { ClipboardNotice } from '@/platform/terminal-runtime/clipboard/ClipboardProtocol';

/**
 * The remaining Terminal status inputs a canonical fixture route can express
 * (#2621): the history gap the runtime observed, the control lease it was told
 * about, and the clipboard protocol event it reported.
 *
 * Each parameter names the *input* the product cannot otherwise be handed, not
 * a rendering — the surface still decides which sentence and which actions a
 * state produces. `fixtureInputDrop` established the same rule for #1307.
 *
 *   /#/fixture/app?history=degraded    an attach answered with a gap: output
 *                                      was lost while disconnected
 *   /#/fixture/app?role=observer       the attach metadata says another client
 *                                      holds the control lease
 *   /#/fixture/app?clipboard=<kind>    the clipboard protocol reported one of
 *                                      its four user-visible events
 *
 * Absent, empty or unrecognised values mean "the healthy state", so the
 * canonical screenshots do not move. The App fixture deliberately supplies no
 * dismiss/take-control handlers: it renders states rather than running flows,
 * exactly like `?drop=`.
 */
const CLIPBOARD_KINDS: readonly ClipboardNotice['kind'][] = [
  'copy-required',
  'write-denied',
  'unsupported-image-paste',
  'image-too-large',
];

/** The text a `copy-required` notice holds — a user gesture can still copy it. */
const FIXTURE_CLIPBOARD_TEXT = 'fixture clipboard text';

export interface FixtureStatusInputs {
  historyDegraded: boolean;
  terminalControl?: TerminalControlState;
  clipboardNotice: ClipboardNoticeState | null;
}

export function fixtureStatusInputs(search: string): FixtureStatusInputs {
  const params = new URLSearchParams(search);
  const role = params.get('role');
  const value = params.get('clipboard');
  // `find` rather than a cast: the route is user-typeable, and a kind outside
  // the union is not an event the protocol can report.
  const kind = value === null
    ? undefined
    : CLIPBOARD_KINDS.find((candidate) => candidate === value);
  const notice: ClipboardNotice | null = kind === undefined
    ? null
    : kind === 'copy-required'
      ? { kind, text: FIXTURE_CLIPBOARD_TEXT }
      : { kind };
  return {
    historyDegraded: params.get('history') === 'degraded',
    terminalControl: role === 'observer' ? { role: 'observer' } : undefined,
    clipboardNotice: notice === null ? null : { id: 1, notice },
  };
}
