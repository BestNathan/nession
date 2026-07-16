import { useState } from 'react';
import { Plus, X, SendHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { generateId } from '@/lib/idGenerator';
import {
  PRESETS,
  loadUserCommands,
  saveUserCommands,
  type QuickCommand,
} from './quickCommands';

export interface TerminalToolbarProps {
  sendText: (text: string) => void;
  disabled?: boolean;
}

export function TerminalToolbar({ sendText, disabled = false }: TerminalToolbarProps) {
  const [userCommands, setUserCommands] = useState<QuickCommand[]>(() => loadUserCommands());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [inputValue, setInputValue] = useState('');

  const runCommand = (cmd: QuickCommand) => {
    sendText(cmd.raw ? cmd.command : cmd.command + '\r');
  };

  const deleteUserCommand = (id: string) => {
    const next = userCommands.filter((c) => c.id !== id);
    setUserCommands(next);
    saveUserCommands(next);
  };

  const addUserCommand = () => {
    const label = newLabel.trim();
    const command = newCommand.trim();
    if (!label || !command) { return; }
    const id = generateId('user');
    const next = [...userCommands, { id, label, command }];
    setUserCommands(next);
    saveUserCommands(next);
    setNewLabel('');
    setNewCommand('');
    setShowAddForm(false);
  };

  const sendInput = () => {
    const text = inputValue.trim();
    if (!text) { return; }
    sendText(text + '\r');
    setInputValue('');
  };

  return (
    <div className="flex flex-col min-h-0">
      {/* Quick command buttons — compact, scrollable row */}
      <div className="flex flex-wrap gap-1 content-start overflow-y-auto min-h-0 p-2 pb-0">
        {PRESETS.map((cmd) => (
          <Button key={cmd.id} variant="outline" size="sm"
            className="h-11 md:h-6 text-xs md:text-[11px] px-2" disabled={disabled}
            onClick={() => runCommand(cmd)}>{cmd.label}</Button>
        ))}
        {userCommands.map((cmd) => (
          <div key={cmd.id} className="flex items-center h-11 md:h-6">
            <Button variant="outline" size="sm"
              className="h-11 md:h-6 text-xs md:text-[11px] px-2 rounded-r-none" disabled={disabled}
              onClick={() => runCommand(cmd)}>{cmd.label}</Button>
            <Button variant="ghost" size="icon" className="h-11 md:h-6 w-9 md:w-5 rounded-l-none"
              disabled={disabled} onClick={() => deleteUserCommand(cmd.id)} aria-label="Delete command" title="Delete">
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
              onClick={addUserCommand}>Add</Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" disabled={disabled}
              onClick={() => setShowAddForm(false)} aria-label="Cancel" title="Cancel">✕</Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" className="h-11 md:h-6 text-xs md:text-[11px] px-2"
            disabled={disabled} onClick={() => setShowAddForm(true)}>
            <Plus className="h-3 w-3 mr-1" /> Add</Button>
        )}
      </div>

      {/* Input row — pinned to bottom; multi-line, fixed ~3 rows */}
      <div className="flex gap-1.5 flex-shrink-0 p-2 pt-1 border-t items-end">
        <Textarea
          placeholder="Type to send… (Enter to submit, Shift+Enter for newline)"
          value={inputValue}
          rows={3}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              sendInput();
            }
          }}
          className="text-xs md:text-xs flex-1 min-h-0 h-[4.5rem] resize-none field-sizing-fixed py-1.5"
          disabled={disabled}
        />
        <Button variant="outline" size="icon" className="h-11 w-11 md:h-7 md:w-7 flex-shrink-0" aria-label="Send" title="Send"
          onClick={sendInput} disabled={disabled}>
          <SendHorizontal className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
