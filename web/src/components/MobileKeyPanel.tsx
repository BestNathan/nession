import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';

/**
 * Virtual keys missing from mobile keyboards.
 *
 * Control-key combos follow the ASCII formula:
 *   Ctrl+X → \xNN where NN = X.charCodeAt(0) - 64
 *   Ctrl+A=\x01 … Ctrl+Z=\x1a
 */
interface MobileKey {
  label: string;
  command: string;
}

const CORE_KEYS: MobileKey[] = [
  { label: '↑',       command: '\x1b[A' },
  { label: '↓',       command: '\x1b[B' },
  { label: '←',       command: '\x1b[D' },
  { label: '→',       command: '\x1b[C' },
];

const EXTRA_KEYS: MobileKey[] = [
  { label: 'Tab',     command: '\t' },
  { label: 'Esc',     command: '\x1b' },
  { label: 'Enter',   command: '\r' },
  { label: 'Ctrl+A',  command: '\x01' },
  { label: 'Ctrl+E',  command: '\x05' },
  { label: 'Ctrl+W',  command: '\x17' },
  { label: 'Ctrl+U',  command: '\x15' },
  { label: 'Ctrl+D',  command: '\x04' },
  // Ctrl+C is intentionally omitted — the quick-commands preset covers it.
];

export interface MobileKeyPanelProps {
  /** Called with the raw command text (no trailing \r appended). */
  onKey: (command: string) => void;
  /** Called after any key is sent — use to re-focus the terminal. */
  onAfterKey?: () => void;
  disabled?: boolean;
}

export function MobileKeyPanel({ onKey, disabled = false, onAfterKey }: MobileKeyPanelProps) {
  const [ctrlChar, setCtrlChar] = useState('');

  const sendKey = (command: string) => {
    onKey(command);
    onAfterKey?.();
  };

  const sendCtrlCombo = () => {
    const ch = ctrlChar.trim();
    if (!ch) { return; }
    const code = ch.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) { return; } // A-Z only
    sendKey(String.fromCharCode(code - 64));
    setCtrlChar('');
  };

  return (
    <div className="flex flex-col gap-1 px-2 pt-1.5 pb-0 flex-shrink-0">
      {/* Row 1: arrow keys */}
      <div className="flex flex-wrap gap-1">
        {CORE_KEYS.map((k) => (
          <Button key={k.label} variant="secondary" size="sm"
            className="h-11 md:h-7 text-base font-mono px-2.5 min-w-[2.8rem]"
            disabled={disabled} tabIndex={-1}
            onClick={() => sendKey(k.command)}>{k.label}</Button>
        ))}
      </div>

      {/* Row 2: special keys + Ctrl combos */}
      <div className="flex flex-wrap gap-1 items-center">
        {EXTRA_KEYS.map((k) => (
          <Button key={k.label} variant="secondary" size="sm"
            className="h-11 md:h-7 text-xs font-mono px-2.5"
            disabled={disabled} tabIndex={-1}
            onClick={() => sendKey(k.command)}>{k.label}</Button>
        ))}

        {/* Ctrl + any letter */}
        <span className="text-xs text-muted-foreground mx-0.5">Ctrl+</span>
        <Input
          value={ctrlChar}
          onChange={(e) => setCtrlChar(e.target.value.slice(0, 1))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendCtrlCombo(); } }}
          placeholder="?"
          maxLength={1}
          disabled={disabled}
          className="h-7 w-9 text-xs font-mono text-center p-0"
        />
        <Button variant="ghost" size="sm"
          className="h-7 text-xs px-1.5"
          disabled={disabled || !ctrlChar.trim()} tabIndex={-1}
          onClick={sendCtrlCombo}>Send</Button>
      </div>
    </div>
  );
}
