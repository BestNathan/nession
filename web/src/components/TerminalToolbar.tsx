import { useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { cn } from '@/lib/utils';
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface AddCommandFormProps {
  newLabel: string;
  newCommand: string;
  disabled: boolean;
  onLabelChange: (v: string) => void;
  onCommandChange: (v: string) => void;
  onAdd: () => void;
  onCancel: () => void;
}

function AddCommandForm({
  newLabel, newCommand, disabled,
  onLabelChange, onCommandChange, onAdd, onCancel,
}: AddCommandFormProps) {
  return (
    <div className="flex items-center gap-1 w-full mt-1">
      <Input placeholder="Label" value={newLabel} onChange={(e) => onLabelChange(e.target.value)}
        className="h-7 text-xs flex-1 min-w-0" disabled={disabled} />
      <Input placeholder="Command" value={newCommand} onChange={(e) => onCommandChange(e.target.value)}
        className="h-7 text-xs flex-1 min-w-0" disabled={disabled} />
      <Button size="sm" className="h-7 text-xs" disabled={disabled} onClick={onAdd}>Add</Button>
      <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={disabled} onClick={onCancel}>Cancel</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function TerminalToolbar({ sendText, disabled = false }: TerminalToolbarProps) {
  const [isOpen, setIsOpen] = useState(true);
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
    if (!label || !command) {return;}
    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next = [...userCommands, { id, label, command }];
    setUserCommands(next);
    saveUserCommands(next);
    setNewLabel('');
    setNewCommand('');
    setShowAddForm(false);
  };

  const cancelAddForm = () => { setNewLabel(''); setNewCommand(''); setShowAddForm(false); };

  const sendInput = () => {
    const text = inputValue.trim();
    if (!text) {return;}
    sendText(text + '\r');
    setInputValue('');
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInput(); }
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="border-t bg-muted/30 flex-shrink-0">
      <div className="flex items-center justify-between px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Quick Commands</h3>
        <CollapsibleTrigger className="flex items-center justify-center h-6 w-6 rounded-md hover:bg-accent hover:text-accent-foreground cursor-pointer">
          <ChevronDown className={cn('h-4 w-4 transition-transform', !isOpen && '-rotate-90')} />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="px-3 pb-3 space-y-3">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((cmd) => (
              <Button key={cmd.id} variant="outline" size="sm" className="font-mono text-xs"
                disabled={disabled} onClick={() => runCommand(cmd)}>{cmd.label}</Button>
            ))}
            {userCommands.map((cmd) => (
              <div key={cmd.id} className="flex items-center">
                <Button variant="outline" size="sm" className="font-mono text-xs rounded-r-none"
                  disabled={disabled} onClick={() => runCommand(cmd)}>{cmd.label}</Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-l-none"
                  disabled={disabled} onClick={() => deleteUserCommand(cmd.id)} title="Delete command">
                  <X className="h-3 w-3" /></Button>
              </div>
            ))}
            {showAddForm ? (
              <AddCommandForm newLabel={newLabel} newCommand={newCommand} disabled={disabled}
                onLabelChange={setNewLabel} onCommandChange={setNewCommand}
                onAdd={addUserCommand} onCancel={cancelAddForm} />
            ) : (
              <Button variant="ghost" size="sm" className="text-xs" disabled={disabled}
                onClick={() => setShowAddForm(true)}><Plus className="h-3 w-3 mr-1" /> Add command</Button>
            )}
          </div>
          <div className="flex gap-2">
            <Textarea rows={2} placeholder="Type text to send… (Enter to send, Shift+Enter for newline)"
              value={inputValue} onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleInputKeyDown} className="flex-1 font-mono text-sm resize-none" disabled={disabled} />
            <Button onClick={sendInput} size="sm" className="self-end" disabled={disabled}>Send</Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
