// Quick-command panel — presets, user commands, physical key row, composite key builder.
// Uses server-backed useQuickCommands + local useCommandHistory for run tracking.
// Shared by mobile (BottomSheet) and desktop (BottomBar) terminal layouts.

import { useState } from 'react';
import { Plus, X, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, MoreHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { PRESETS, type QuickCommand } from './quickCommands';
import { useQuickCommands } from '../hooks/useQuickCommands';
import { useCommandHistory } from '../hooks/useCommandHistory';

/* ── Physical key row — left-right layout ──────────────────────────── */

interface PhysKey { label: string; seq: string; }

/** Left-area quick keys (2 rows × max 5 cols).  When > 10 the 10th slot
 *  becomes a dropdown that exposes the overflow set. */
const LEFT_KEYS: PhysKey[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: 'Ctrl-C', seq: '\x03' },
  { label: 'Space', seq: ' ' },
  { label: 'Enter', seq: '\r' },
  { label: 'Del', seq: '\x1b[3~' },
  { label: 'Home', seq: '\x1b[H' },
  { label: 'PgUp', seq: '\x1b[5~' },
  { label: 'PgDn', seq: '\x1b[6~' },
  { label: 'End', seq: '\x1b[F' },
];

/** Right-area arrow keys in 凸 (T-shape) layout. */
const ARROW_KEYS: PhysKey[] = [
  { label: '↑', seq: '\x1b[A' },
  { label: '←', seq: '\x1b[D' },
  { label: '↓', seq: '\x1b[B' },
  { label: '→', seq: '\x1b[C' },
];

function KeyRow({ onKey, disabled }: { onKey: (seq: string) => void; disabled: boolean }) {
  const hasOverflow = LEFT_KEYS.length > 10;
  const visibleCount = hasOverflow ? 9 : LEFT_KEYS.length;
  const visibleKeys = LEFT_KEYS.slice(0, visibleCount);
  const dropdownKeys = hasOverflow ? LEFT_KEYS.slice(visibleCount) : [];

  const KeyButton = ({ k }: { k: PhysKey }) => {
    const iconEl =
      k.label === '←' ? <ArrowLeft className="size-3.5" /> :
      k.label === '↑' ? <ArrowUp className="size-3.5" /> :
      k.label === '↓' ? <ArrowDown className="size-3.5" /> :
      k.label === '→' ? <ArrowRight className="size-3.5" /> :
      null;

    return (
      <Button
        variant="secondary"
        size="sm"
        className="h-9 w-full text-xs font-mono"
        disabled={disabled}
        onClick={() => onKey(k.seq)}
        aria-label={k.label}
      >
        {iconEl ?? k.label}
      </Button>
    );
  };

  return (
    <div className="flex justify-between gap-2 px-2 py-1.5 border-b flex-shrink-0">
      {/* Left: 2-row × 5-col quick key grid */}
      <div className="grid grid-cols-5 gap-1 flex-1">
        {visibleKeys.map((k) => <KeyButton key={k.label} k={k} />)}
        {hasOverflow && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-9 w-full text-xs"
                  disabled={disabled}
                  aria-label="More keys"
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-[100px]">
              {dropdownKeys.map((k) => (
                <DropdownMenuItem
                  key={k.label}
                  onClick={() => onKey(k.seq)}
                  className="text-xs font-mono cursor-pointer"
                >
                  {k.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Right: arrow keys in 凸 (T-shape) */}
      <div className="grid grid-cols-3 grid-rows-2 gap-1 flex-shrink-0">
        <div />
        <KeyButton k={ARROW_KEYS[0]} /> {/* ↑ */}
        <div />
        <KeyButton k={ARROW_KEYS[1]} /> {/* ← */}
        <KeyButton k={ARROW_KEYS[2]} /> {/* ↓ */}
        <KeyButton k={ARROW_KEYS[3]} /> {/* → */}
      </div>
    </div>
  );
}

/* ── Modifier toggles for composite key builder ──────────────────── */

type Modifier = 'Ctrl' | 'Alt';

interface ComboBuilderProps {
  onSave: (label: string, seq: string) => void;
  onCancel: () => void;
  disabled: boolean;
}

function ComboBuilder({ onSave, onCancel, disabled }: ComboBuilderProps) {
  const [mods, setMods] = useState<Set<Modifier>>(new Set());
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');

  const toggleMod = (m: Modifier) => {
    setMods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) { next.delete(m); } else { next.add(m); }
      return next;
    });
  };

  const buildSeq = (): string => {
    let seq = '';
    const letter = key.trim();
    if (!letter) { return ''; }
    // Alt prefix: Esc before the combo
    if (mods.has('Alt')) { seq += '\x1b'; }
    // Ctrl mask: for A-Z, subtract 64 from char code
    if (mods.has('Ctrl')) {
      const upper = letter.toUpperCase();
      if (upper >= 'A' && upper <= 'Z') {
        seq += String.fromCharCode(upper.charCodeAt(0) - 64);
      }
    } else {
      seq += letter;
    }
    return seq;
  };

  const preview = buildSeq();
  const modLabels = [...mods].join(' + ');
  const previewLabel = modLabels ? `${modLabels} + ${key || '?'}` : (key || '?');

  const handleSave = () => {
    if (!preview) { return; }
    onSave(label.trim() || previewLabel, preview);
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex gap-1.5">
        {(['Ctrl', 'Alt'] as Modifier[]).map((m) => (
          <Button
            key={m}
            variant={mods.has(m) ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs px-2.5"
            onClick={() => toggleMod(m)}
          >
            {m}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Key</span>
        <Input
          placeholder="A"
          value={key}
          onChange={(e) => setKey(e.target.value.slice(0, 4))}
          className="h-7 w-16 text-xs text-center font-mono"
          disabled={disabled}
        />
        {preview && (
          <Badge variant="secondary" className="text-[10px] h-4 font-mono">
            {previewLabel} → {[...preview].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(' ')}
          </Badge>
        )}
      </div>
      <Input
        placeholder="Label (optional, auto-generated)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="h-7 text-xs"
        disabled={disabled}
      />
      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 text-xs" disabled={disabled || !preview} onClick={handleSave}>Save</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/* ── Plain command form ───────────────────────────────────────────── */

function PlainForm({ onSave, onCancel, disabled }: { onSave: (label: string, command: string) => void; onCancel: () => void; disabled: boolean }) {
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');

  return (
    <div className="flex flex-col gap-2 p-2">
      <Input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} className="h-7 text-xs" disabled={disabled} />
      <Input placeholder="Command (sent as: command + Enter)" value={command} onChange={(e) => setCommand(e.target.value)} className="h-7 text-xs font-mono" disabled={disabled} />
      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 text-xs" disabled={disabled || !label.trim() || !command.trim()} onClick={() => onSave(label.trim(), command.trim())}>Save</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/* ── Delete button ────────────────────────────────────────────────── */

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost" size="icon"
            className="h-6 w-6 flex-shrink-0 text-muted-foreground hover:text-destructive"
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            aria-label="Delete"
          />
        }
      >
        <X className="h-3.5 w-3.5" />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>Delete command</p>
      </TooltipContent>
    </Tooltip>
  );
}

/* ── Main panel ───────────────────────────────────────────────────── */

type AddMode = 'plain' | 'combo';

export function QuickCommandsPanel({ sendText, disabled }: { sendText: (text: string) => void; disabled: boolean }) {
  const { userCommands, addCommand, deleteCommand } = useQuickCommands();
  const { addEntry } = useCommandHistory();
  const [showAddForm, setShowAddForm] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>('combo');

  const handleRun = (cmd: QuickCommand) => {
    const text = cmd.raw ? cmd.command : cmd.command + '\r';
    sendText(text);
    addEntry(cmd.command);
  };

  const handlePhysKey = (seq: string) => {
    sendText(seq);
  };

  const handleAddPlain = async (label: string, command: string) => {
    await addCommand(label, command, false);
    setShowAddForm(false);
  };

  const handleAddCombo = async (label: string, seq: string) => {
    // Store the human-readable label with the raw escape sequence.
    // raw=true so no \r is appended when run.
    await addCommand(label, seq, true);
    setShowAddForm(false);
  };

  const allCommands = [...PRESETS, ...userCommands];
  const presetIds = new Set(PRESETS.map((p) => p.id));

  return (
    <div className="flex flex-col min-h-0">
      {/* Physical key row — always visible */}
      <KeyRow onKey={handlePhysKey} disabled={disabled} />

      {/* Command list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {allCommands.map((cmd, i) => {
          const isPreset = presetIds.has(cmd.id);
          // Separator between presets and user commands
          const sep = i === PRESETS.length && i > 0;
          return (
            <div key={cmd.id}>
              {sep && <Separator />}
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 h-8 text-left hover:bg-accent/40 transition-colors disabled:opacity-50"
                disabled={disabled}
                onClick={() => handleRun(cmd)}
              >
                <span className="text-xs flex-1 min-w-0 truncate">{cmd.label}</span>
                {cmd.raw && (
                  <span className="text-[10px] text-muted-foreground/60 flex-shrink-0 font-mono">
                    {[...cmd.command].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')}
                  </span>
                )}
                {isPreset ? (
                  <span className="text-[10px] text-muted-foreground/40 flex-shrink-0">built-in</span>
                ) : (
                  <DeleteButton onClick={() => { void deleteCommand(cmd.id); }} />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Add form */}
      <div className="border-t flex-shrink-0">
        {showAddForm ? (
          <div>
            <div className="flex gap-1 px-2 pt-2">
              <Button variant={addMode === 'combo' ? 'default' : 'outline'} size="sm" className="h-7 text-xs px-2" onClick={() => setAddMode('combo')}>Combo</Button>
              <Button variant={addMode === 'plain' ? 'default' : 'outline'} size="sm" className="h-7 text-xs px-2" onClick={() => setAddMode('plain')}>Plain</Button>
            </div>
            {addMode === 'combo' ? (
              <ComboBuilder disabled={disabled} onSave={handleAddCombo} onCancel={() => setShowAddForm(false)} />
            ) : (
              <PlainForm disabled={disabled} onSave={handleAddPlain} onCancel={() => setShowAddForm(false)} />
            )}
          </div>
        ) : (
          <Button variant="ghost" size="sm" className="h-8 text-xs w-full rounded-none" disabled={disabled} onClick={() => setShowAddForm(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Command
          </Button>
        )}
      </div>
    </div>
  );
}
