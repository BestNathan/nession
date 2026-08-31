import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type AddMode = 'plain' | 'combo';
type Modifier = 'Ctrl' | 'Alt' | 'Shift' | 'Tab';

const MODIFIERS: { key: Modifier; label: string }[] = [
  { key: 'Ctrl', label: 'Ctrl' },
  { key: 'Alt', label: 'Alt' },
  { key: 'Shift', label: 'Shift' },
  { key: 'Tab', label: 'Tab' },
];

interface CapsuleAddCommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  onAddPlain: (label: string, command: string) => Promise<void>;
  onAddCombo: (label: string, seq: string) => Promise<void>;
}

function ComboBuilder({
  disabled,
  onSave,
  onCancel,
}: {
  disabled: boolean;
  onSave: (label: string, seq: string) => void;
  onCancel: () => void;
}) {
  const [mods, setMods] = useState<Set<Modifier>>(new Set());
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');

  const toggleMod = (modifier: Modifier) => {
    setMods((prev) => {
      const next = new Set(prev);
      if (next.has(modifier)) {
        next.delete(modifier);
      } else {
        next.add(modifier);
      }
      return next;
    });
  };

  const buildSeq = (): string => {
    const letter = key.trim();
    if (!letter) {
      return '';
    }
    let seq = '';
    if (mods.has('Alt')) {
      seq += '\x1b';
    }
    if (mods.has('Tab')) {
      seq += '\t';
    }
    if (mods.has('Ctrl')) {
      const upper = letter.toUpperCase();
      if (upper >= 'A' && upper <= 'Z') {
        seq += String.fromCharCode(upper.charCodeAt(0) - 64);
      }
    } else if (mods.has('Shift')) {
      seq += letter.toUpperCase();
    } else {
      seq += letter;
    }
    return seq;
  };

  const preview = buildSeq();
  const modLabels = [...mods].join(' + ');
  const previewLabel = modLabels ? `${modLabels} + ${key || '?'}` : (key || '?');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {MODIFIERS.map((modifier) => (
          <Button
            key={modifier.key}
            variant={mods.has(modifier.key) ? 'default' : 'outline'}
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => toggleMod(modifier.key)}
          >
            {modifier.label}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">Key</span>
        <Input
          placeholder="A"
          value={key}
          onChange={(event) => setKey(event.target.value.slice(0, 4))}
          className="h-8 w-16 text-center font-mono text-xs"
          disabled={disabled}
        />
      </div>
      <Input
        placeholder={previewLabel}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className="h-8 text-xs"
        disabled={disabled}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-8 text-xs"
          disabled={disabled || !preview}
          onClick={() => onSave(label.trim() || previewLabel, preview)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function PlainForm({
  disabled,
  onSave,
  onCancel,
}: {
  disabled: boolean;
  onSave: (label: string, command: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');

  return (
    <div className="flex flex-col gap-3">
      <Input
        placeholder="Label"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className="h-8 text-xs"
        disabled={disabled}
      />
      <Input
        placeholder="Command (sent as: command + Enter)"
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        className="h-8 font-mono text-xs"
        disabled={disabled}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-8 text-xs"
          disabled={disabled || !label.trim() || !command.trim()}
          onClick={() => onSave(label.trim(), command.trim())}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

export function CapsuleAddCommandDialog({
  open,
  onOpenChange,
  disabled,
  onAddPlain,
  onAddCombo,
}: CapsuleAddCommandDialogProps) {
  const [mode, setMode] = useState<AddMode>('combo');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Command</DialogTitle>
        </DialogHeader>
        <div className="mb-3 flex gap-1.5">
          <Button
            variant={mode === 'combo' ? 'default' : 'outline'}
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => setMode('combo')}
          >
            Combo
          </Button>
          <Button
            variant={mode === 'plain' ? 'default' : 'outline'}
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => setMode('plain')}
          >
            Plain
          </Button>
        </div>
        {mode === 'combo' ? (
          <ComboBuilder
            disabled={disabled}
            onSave={(label, seq) => {
              void onAddCombo(label, seq).then(() => onOpenChange(false));
            }}
            onCancel={() => onOpenChange(false)}
          />
        ) : (
          <PlainForm
            disabled={disabled}
            onSave={(label, command) => {
              void onAddPlain(label, command).then(() => onOpenChange(false));
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function CapsuleDeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
            aria-label="Delete"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        }
      />
      <TooltipContent side="bottom">
        <p>Delete command</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function CapsuleAddCommandButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-full rounded-none text-xs"
      disabled={disabled}
      data-testid="capsule-add-command"
      onClick={onClick}
    >
      <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Command
    </Button>
  );
}
