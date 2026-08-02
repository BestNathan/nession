import { Button } from './ui/button';
import type { QuickCommand } from './quickCommands';

/**
 * Virtual keys that are missing or hard to reach on mobile keyboards.
 *
 * Control-key combos (Ctrl+A … Ctrl+Z) are sent as ASCII control
 * characters \x01–\x1f.  Formula: `Ctrl+X` = charCode(X) - 64.
 * Examples: Ctrl+A=\x01, Ctrl+D=\x04, Ctrl+E=\x05, Ctrl+W=\x17.
 *
 * Enter is \r (carriage return).  The textarea already sends \r on
 * Enter, but this button lets the user send a standalone Enter.
 *
 * All commands use raw:true — sent verbatim, no trailing \r appended.
 */
const MOBILE_KEYS: QuickCommand[] = [
  // ── navigation ──
  { id: 'mkey-up',      label: '↑',       command: '\x1b[A', raw: true },
  { id: 'mkey-down',    label: '↓',       command: '\x1b[B', raw: true },
  { id: 'mkey-left',    label: '←',       command: '\x1b[D', raw: true },
  { id: 'mkey-right',   label: '→',       command: '\x1b[C', raw: true },
  // ── special keys ──
  { id: 'mkey-tab',     label: 'Tab',     command: '\t',     raw: true },
  { id: 'mkey-esc',     label: 'Esc',     command: '\x1b',   raw: true },
  { id: 'mkey-enter',   label: 'Enter',   command: '\r',     raw: true },
  // ── readline / shell shortcuts ──
  { id: 'mkey-ctrl-a',  label: 'Ctrl+A',  command: '\x01',   raw: true },
  { id: 'mkey-ctrl-e',  label: 'Ctrl+E',  command: '\x05',   raw: true },
  { id: 'mkey-ctrl-w',  label: 'Ctrl+W',  command: '\x17',   raw: true },
  { id: 'mkey-ctrl-d',  label: 'Ctrl+D',  command: '\x04',   raw: true },
];

export interface MobileKeyPanelProps {
  /** Called with the key's command text (already raw, no trailing \r). */
  onKey: (command: string) => void;
  disabled?: boolean;
}

export function MobileKeyPanel({ onKey, disabled = false }: MobileKeyPanelProps) {
  return (
    <div className="flex flex-wrap gap-1 px-2 pt-1.5 pb-0 flex-shrink-0">
      {MOBILE_KEYS.map((k) => (
        <Button
          key={k.id}
          variant="secondary"
          size="sm"
          className="h-11 md:h-7 text-xs font-mono px-2.5 min-w-[2.5rem]"
          disabled={disabled}
          onClick={() => onKey(k.command)}
        >
          {k.label}
        </Button>
      ))}
    </div>
  );
}
