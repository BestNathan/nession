import { cn } from '@/lib/utils';
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
import {
  capsuleAddCommandFooterClass,
  capsuleAddCommandIconClass,
  capsuleChipButtonClass,
  capsuleChipRowClass,
  capsuleDialogActionRowClass,
  capsuleDialogInputClass,
  capsuleDialogMaxWidthClass,
  capsuleDialogStackClass,
  capsuleIconCloseButtonClass,
  capsuleIconCloseSvgClass,
  capsuleInlineFieldRowClass,
  capsuleKeyInputClass,
  capsuleLabelTextClass,
  capsuleTabButtonClass,
  capsuleTabRowClass,
} from '@/session-first/capsule/capsuleStyles';

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
    <div className={capsuleDialogStackClass}>
      <div className={capsuleChipRowClass}>
        {MODIFIERS.map((modifier) => (
          <Button
            key={modifier.key}
            variant={mods.has(modifier.key) ? 'default' : 'outline'}
            size="sm"
            className={capsuleChipButtonClass}
            onClick={() => toggleMod(modifier.key)}
          >
            {modifier.label}
          </Button>
        ))}
      </div>
      <div className={capsuleInlineFieldRowClass}>
        <span className={capsuleLabelTextClass}>Key</span>
        <Input
          placeholder="A"
          value={key}
          onChange={(event) => setKey(event.target.value.slice(0, 4))}
          className={capsuleKeyInputClass}
          disabled={disabled}
        />
      </div>
      <Input
        placeholder={previewLabel}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className={capsuleDialogInputClass}
        disabled={disabled}
      />
      <div className={capsuleDialogActionRowClass}>
        <Button size="sm" variant="ghost" className={capsuleChipButtonClass} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className={capsuleChipButtonClass}
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
    <div className={capsuleDialogStackClass}>
      <Input
        placeholder="Label"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className={capsuleDialogInputClass}
        disabled={disabled}
      />
      <Input
        placeholder="Command (sent as: command + Enter)"
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        className={cn(capsuleDialogInputClass, 'font-mono')}
        disabled={disabled}
      />
      <div className={capsuleDialogActionRowClass}>
        <Button size="sm" variant="ghost" className={capsuleChipButtonClass} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className={capsuleChipButtonClass}
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
      <DialogContent className={capsuleDialogMaxWidthClass}>
        <DialogHeader>
          <DialogTitle>Add Command</DialogTitle>
        </DialogHeader>
        <div className={capsuleTabRowClass}>
          <Button
            variant={mode === 'combo' ? 'default' : 'outline'}
            size="sm"
            className={capsuleTabButtonClass}
            onClick={() => setMode('combo')}
          >
            Combo
          </Button>
          <Button
            variant={mode === 'plain' ? 'default' : 'outline'}
            size="sm"
            className={capsuleTabButtonClass}
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
            className={capsuleIconCloseButtonClass}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
            aria-label="Delete"
          >
            <X className={capsuleIconCloseSvgClass} />
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
      className={capsuleAddCommandFooterClass}
      disabled={disabled}
      data-testid="capsule-add-command"
      onClick={onClick}
    >
      <Plus className={capsuleAddCommandIconClass} /> Add Command
    </Button>
  );
}
