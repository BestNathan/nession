// Quick-command buttons panel (presets + user commands + add form).
// Extracted from TerminalToolbar to keep each function under the 120-line limit.

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { PRESETS, type QuickCommand } from './quickCommands';

export interface QuickCommandsPanelProps {
  userCommands: QuickCommand[];
  disabled: boolean;
  onRunCommand: (cmd: QuickCommand) => void;
  onDeleteCommand: (id: string) => Promise<void>;
  onAddCommand: (label: string, command: string) => Promise<void>;
}

export function QuickCommandsPanel({
  userCommands,
  disabled,
  onRunCommand,
  onDeleteCommand,
  onAddCommand,
}: QuickCommandsPanelProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newCommand, setNewCommand] = useState('');

  const handleAdd = () => {
    const label = newLabel.trim();
    const command = newCommand.trim();
    if (!label || !command) {
      return;
    }
    void onAddCommand(label, command);
    setNewLabel('');
    setNewCommand('');
    setShowAddForm(false);
  };

  return (
    <div className="flex flex-wrap gap-1 content-start overflow-y-auto min-h-0 p-2 pb-0">
      {PRESETS.map((cmd) => (
        <Button key={cmd.id} variant="outline" size="sm"
          className="h-11 md:h-6 text-xs md:text-[11px] px-2" disabled={disabled}
          onClick={() => onRunCommand(cmd)}>{cmd.label}</Button>
      ))}
      {userCommands.map((cmd) => (
        <div key={cmd.id} className="flex items-center h-11 md:h-6">
          <Button variant="outline" size="sm"
            className="h-11 md:h-6 text-xs md:text-[11px] px-2 rounded-r-none" disabled={disabled}
            onClick={() => onRunCommand(cmd)}>{cmd.label}</Button>
          <Button variant="ghost" size="icon" className="h-11 md:h-6 w-9 md:w-5 rounded-l-none"
            disabled={disabled} onClick={() => onDeleteCommand(cmd.id)} aria-label="Delete command" title="Delete">
            <X className="h-3 w-3" /></Button>
        </div>
      ))}
      {showAddForm ? (
        <div className="flex items-center gap-1 w-full">
          <Input placeholder="Label" value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="h-6 text-[11px] flex-1 min-w-0" disabled={disabled} />
          <Input placeholder="Command" value={newCommand}
            onChange={(e) => setNewCommand(e.target.value)}
            className="h-6 text-[11px] flex-1 min-w-0" disabled={disabled} />
          <Button size="sm" className="h-6 text-[11px] px-2" disabled={disabled}
            onClick={handleAdd}>Add</Button>
          <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" disabled={disabled}
            onClick={() => setShowAddForm(false)} aria-label="Cancel" title="Cancel">✕</Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="h-11 md:h-6 text-xs md:text-[11px] px-2"
          disabled={disabled} onClick={() => setShowAddForm(true)}>
          <Plus className="h-3 w-3 mr-1" /> Add</Button>
      )}
    </div>
  );
}