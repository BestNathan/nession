/**
 * Quick Commands — a Terminal-local capability of the saved-command owner
 * (#2710).
 *
 * It lives beside Terminal Keys under `product/terminal` for the same reason
 * Terminal Keys does: what it is made of is Terminal machinery (the capsule
 * slot, the composer Insert action, the Terminal's Run path), there is no
 * transport to own here and no Workspace view to contribute. The transport
 * adapter it reads is the commands capability slice
 * (`capabilities/commands`), and `product → capabilities` is the allowed
 * direction.
 *
 * No JSX here for the `react-refresh/only-export-components` rule; the body is
 * mounted with `createElement` for the same hook-count reason `terminalKeys.ts`
 * records.
 */
import { createElement } from 'react';
import { SquareTerminal } from 'lucide-react';
import type { CapabilityState } from '@/product/capability';
import type { CapsuleProjectionBinding } from '@/app/capsuleProjections';
import { QuickCommandsProjection } from '@/product/terminal/quickCommands/QuickCommandsProjection';
import { QUICK_COMMANDS_ID, TERMINAL_KEYS_ID } from '@/product/terminal/terminalToolIds';

export { QUICK_COMMANDS_ID };
export const QUICK_COMMANDS_TITLE = 'Quick Commands';
export const QUICK_COMMANDS_SHORT_TITLE = 'Commands';

/**
 * Reachable wherever a Session exists: the saved commands are the server's and
 * go to the attached Terminal, so there is nothing to offer without one. The
 * list itself may still be loading or unavailable — the body states that
 * rather than making the capability disappear (#2710 SC-05).
 */
export function resolveQuickCommandsState(context: {
  sessionId?: string;
}): CapabilityState {
  return context.sessionId ? 'available' : 'unavailable';
}

export const quickCommandsProjection: CapsuleProjectionBinding = {
  id: QUICK_COMMANDS_ID,
  icon: SquareTerminal,
  // The Commands view is tapped, not typed into: the soft keyboard would cover
  // the rows it exists to expose. Same declaration Terminal Keys makes.
  ownsInputFocus: true,
  // The other half of the terminal-tools slot: the compact header switch moves
  // between Keys and Commands without adding persistent capsule chrome.
  companions: [TERMINAL_KEYS_ID],
  body: ({ insertText, runCommand, disabled }) =>
    createElement(QuickCommandsProjection, {
      insertText,
      runCommand,
      disabled,
    }),
};
