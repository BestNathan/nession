// Quick-command flat list panel (presets + user commands + add form).
// Each command is one row with a run button; user commands also get a delete
// button. The add form supports Plain Text (sends command + "\r") and Ctrl+
// (picks a single letter A-Z, sends the raw control char) modes.
//
// Uses the server-backed useQuickCommands hook directly — it is shared by
// the mobile (BottomSheet) and desktop (BottomBar) terminal layouts.

import { useState } from 'react';
import { Plus, X, Play } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { PRESETS, type QuickCommand } from './quickCommands';
import { useQuickCommands } from '../hooks/useQuickCommands';
import { useMediaQuery } from '../hooks/useMediaQuery';

interface QuickCommandsPanelProps {
  sendText: (text: string) => void;
  disabled: boolean;
}

type AddMode = 'plain' | 'ctrl';

interface CommandRowProps {
  cmd: QuickCommand;
  isPreset: boolean;
  disabled: boolean;
  isTouch: boolean;
  onRun: (cmd: QuickCommand) => void;
  onDelete: (id: string) => void;
}

function CommandRow({ cmd, isPreset, disabled, isTouch, onRun, onDelete }: CommandRowProps) {
  // Touch: entire row is tappable, delete is a subtle text ×.
  // Desktop: hover-reveal Run button + X delete button.
  return (
    <div
      className="flex items-center gap-1 px-1 rounded hover:bg-accent/50 group cursor-pointer"
      onClick={() => onRun(cmd)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRun(cmd); } }}
    >
      <span className="text-xs flex-1 min-w-0 truncate">{cmd.label}</span>
      {cmd.raw && (
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          {cmd.label.includes('Ctrl+') ? cmd.label.replace('Ctrl+', '') : 'raw'}
        </span>
      )}
      {!isTouch && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 flex-shrink-0 opacity-0 group-hover:opacity-100"
          disabled={disabled}
          onClick={(e) => { e.stopPropagation(); onRun(cmd); }}
          aria-label="Run"
          title="Run"
        >
          <Play className="h-3 w-3" />
        </Button>
      )}
      {!isPreset && !isTouch && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 flex-shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive"
          disabled={disabled}
          onClick={(e) => { e.stopPropagation(); onDelete(cmd.id); }}
          aria-label="Delete"
          title="Delete"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
      {!isPreset && isTouch && (
        <button
          type="button"
          className="text-muted-foreground/50 text-xs px-1 flex-shrink-0"
          disabled={disabled}
          onClick={(e) => { e.stopPropagation(); onDelete(cmd.id); }}
          aria-label="Delete"
        >
          ×
        </button>
      )}
    </div>
  );
}

interface AddCommandFormProps {
  disabled: boolean;
  onSave: (label: string, command: string, raw: boolean) => void;
  onCancel: () => void;
}

function AddCommandForm({ disabled, onSave, onCancel }: AddCommandFormProps) {
  const [mode, setMode] = useState<AddMode>('plain');
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [ctrlKey, setCtrlKey] = useState('');

  const handleSave = () => {
    if (mode === 'ctrl') {
      const letter = ctrlKey.trim().toUpperCase();
      if (!letter || letter.length !== 1 || letter < 'A' || letter > 'Z') {
        return;
      }
      const ctrlLabel = label.trim() || `Ctrl+${letter}`;
      const ctrlCommand = String.fromCharCode(letter.charCodeAt(0) - 64);
      onSave(ctrlLabel, ctrlCommand, true);
    } else {
      const trimmedLabel = label.trim();
      const trimmedCommand = command.trim();
      if (!trimmedLabel || !trimmedCommand) {
        return;
      }
      onSave(trimmedLabel, trimmedCommand, false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1">
        <Button
          variant={mode === 'plain' ? 'default' : 'outline'}
          size="sm"
          className="h-6 text-[11px] px-2"
          onClick={() => setMode('plain')}
        >
          Plain
        </Button>
        <Button
          variant={mode === 'ctrl' ? 'default' : 'outline'}
          size="sm"
          className="h-6 text-[11px] px-2"
          onClick={() => setMode('ctrl')}
        >
          Ctrl+
        </Button>
      </div>
      <Input
        placeholder="Label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="h-6 text-[11px]"
        disabled={disabled}
      />
      {mode === 'plain' ? (
        <Input
          placeholder="Command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="h-6 text-[11px]"
          disabled={disabled}
        />
      ) : (
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Ctrl+</span>
          <Input
            placeholder="Key"
            value={ctrlKey}
            onChange={(e) => setCtrlKey(e.target.value.slice(0, 1))}
            maxLength={1}
            className="h-6 w-12 text-[11px] text-center"
            disabled={disabled}
          />
        </div>
      )}
      <div className="flex gap-1">
        <Button
          size="sm"
          className="h-6 text-[11px] px-2"
          disabled={disabled}
          onClick={handleSave}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-[11px] px-2"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function QuickCommandsPanel({ sendText, disabled }: QuickCommandsPanelProps) {
  const { userCommands, addCommand, deleteCommand } = useQuickCommands();
  const [showAddForm, setShowAddForm] = useState(false);
  const isTouch = useMediaQuery('(pointer: coarse)');

  const handleRun = (cmd: QuickCommand) => {
    sendText(cmd.raw ? cmd.command : cmd.command + '\r');
  };

  const handleAdd = async (label: string, command: string, raw: boolean) => {
    await addCommand(label, command, raw);
    setShowAddForm(false);
  };

  return (
    <div className="flex flex-col min-h-0 p-1.5 gap-0.5">
      <div className="flex-1 min-h-0 overflow-y-auto">
        {[...PRESETS, ...userCommands].map((cmd) => (
          <CommandRow
            key={cmd.id}
            cmd={cmd}
            isPreset={PRESETS.some((p) => p.id === cmd.id)}
            disabled={disabled}
            isTouch={isTouch}
            onRun={handleRun}
            onDelete={(id) => {
              void deleteCommand(id);
            }}
          />
        ))}
      </div>

      <div className="border-t pt-1 flex-shrink-0">
        {showAddForm ? (
          <AddCommandForm
            disabled={disabled}
            onSave={(label, command, raw) => {
              void handleAdd(label, command, raw);
            }}
            onCancel={() => setShowAddForm(false)}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs w-full"
            disabled={disabled}
            onClick={() => setShowAddForm(true)}
          >
            <Plus className="h-3 w-3 mr-1" /> Add Command
          </Button>
        )}
      </div>
    </div>
  );
}
