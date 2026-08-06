// Quick-command panel — presets and user commands in a clean list.
// Uses the server-backed useQuickCommands hook. Shared by mobile (BottomSheet)
// and desktop (BottomBar) terminal layouts.

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { PRESETS, type QuickCommand } from './quickCommands';
import { useQuickCommands } from '../hooks/useQuickCommands';
interface QuickCommandsPanelProps {
  sendText: (text: string) => void;
  disabled: boolean;
}

type AddMode = 'plain' | 'ctrl';

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 flex-shrink-0 text-muted-foreground hover:text-destructive"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label="Delete"
    >
      <X className="h-3.5 w-3.5" />
    </Button>
  );
}

interface AddCommandFormProps {
  disabled: boolean;
  onAdd: (label: string, command: string, raw: boolean) => Promise<void>;
  onCancel: () => void;
}

function AddCommandForm({ disabled, onAdd, onCancel }: AddCommandFormProps) {
  const [mode, setMode] = useState<AddMode>('plain');
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [ctrlKey, setCtrlKey] = useState('');

  const handleSave = () => {
    if (mode === 'ctrl') {
      const letter = ctrlKey.trim().toUpperCase();
      if (!letter || letter.length !== 1 || letter < 'A' || letter > 'Z') { return; }
      void onAdd(label.trim() || `Ctrl+${letter}`, String.fromCharCode(letter.charCodeAt(0) - 64), true);
    } else {
      if (!label.trim() || !command.trim()) { return; }
      void onAdd(label.trim(), command.trim(), false);
    }
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex gap-1">
        <Button variant={mode === 'plain' ? 'default' : 'outline'} size="sm" className="h-7 text-xs px-2" onClick={() => setMode('plain')}>Plain</Button>
        <Button variant={mode === 'ctrl' ? 'default' : 'outline'} size="sm" className="h-7 text-xs px-2" onClick={() => setMode('ctrl')}>Ctrl+</Button>
      </div>
      <Input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} className="h-7 text-xs" disabled={disabled} />
      {mode === 'plain' ? (
        <Input placeholder="Command (sent as: command + Enter)" value={command} onChange={(e) => setCommand(e.target.value)} className="h-7 text-xs" disabled={disabled} />
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Ctrl +</span>
          <Input placeholder="K" value={ctrlKey} onChange={(e) => setCtrlKey(e.target.value.slice(0, 1))} maxLength={1} className="h-7 w-14 text-xs text-center" disabled={disabled} />
        </div>
      )}
      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 text-xs" disabled={disabled} onClick={handleSave}>Save</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function QuickCommandsPanel({ sendText, disabled }: QuickCommandsPanelProps) {
  const { userCommands, addCommand, deleteCommand } = useQuickCommands();
  const [showAddForm, setShowAddForm] = useState(false);

  const handleRun = (cmd: QuickCommand) => {
    sendText(cmd.raw ? cmd.command : cmd.command + '\r');
  };

  const handleAdd = async (label: string, command: string, raw: boolean) => {
    await addCommand(label, command, raw);
    setShowAddForm(false);
  };

  const allCommands = [...PRESETS, ...userCommands];
  const presetIds = new Set(PRESETS.map((p) => p.id));
  const presetCount = PRESETS.length;

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">
        {allCommands.map((cmd, i) => {
          const isPreset = presetIds.has(cmd.id);
          return (
            <div key={cmd.id}>
              {i === presetCount && i > 0 && <Separator />}
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/40 transition-colors disabled:opacity-50"
                disabled={disabled}
                onClick={() => handleRun(cmd)}
              >
                <span className="text-sm font-mono flex-1 min-w-0 truncate">{cmd.label}</span>
                {cmd.raw && (
                  <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 font-normal flex-shrink-0">
                    {cmd.label.includes('Ctrl+') ? cmd.label.replace('Ctrl+', '') : 'raw'}
                  </Badge>
                )}
                {!isPreset && <DeleteButton onClick={() => { void deleteCommand(cmd.id); }} />}
              </button>
            </div>
          );
        })}
      </div>

      <div className="border-t flex-shrink-0">
        {showAddForm ? (
          <AddCommandForm disabled={disabled} onAdd={handleAdd} onCancel={() => setShowAddForm(false)} />
        ) : (
          <Button variant="ghost" size="sm" className="h-8 text-xs w-full rounded-none" disabled={disabled} onClick={() => setShowAddForm(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Command
          </Button>
        )}
      </div>
    </div>
  );
}
