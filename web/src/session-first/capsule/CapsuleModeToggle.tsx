import { capsuleModeToggleItemClass } from '@/session-first/capsule/capsuleStyles';
import { Keyboard, PenLine } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { CapsuleMode } from '@/session-first/capsule/types';

interface CapsuleModeToggleProps {
  mode: CapsuleMode;
  onModeChange: (mode: CapsuleMode) => void;
  disabled?: boolean;
}

export function CapsuleModeToggle({ mode, onModeChange, disabled = false }: CapsuleModeToggleProps) {
  return (
    <ToggleGroup
      value={[mode]}
      onValueChange={(values) => {
        const next = values[0];
        if (next === 'input' || next === 'commands') {
          onModeChange(next);
        }
      }}
      disabled={disabled}
      variant="outline"
      size="sm"
      spacing={0}
      className="shrink-0"
      data-testid="capsule-mode-toggle"
    >
      <ToggleGroupItem
        value="input"
        aria-label="Input mode"
        data-testid="capsule-mode-input"
        className={capsuleModeToggleItemClass}
      >
        <PenLine />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="commands"
        aria-label="Commands mode"
        data-testid="capsule-mode-commands"
        className={capsuleModeToggleItemClass}
      >
        <Keyboard />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
