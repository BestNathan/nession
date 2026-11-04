import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  capsuleArrowKeyAppButtonClass,
  capsulePhysKeyButtonClass,
  capsulePhysKeyGridGapClass,
  capsulePhysKeyIconClass,
  capsulePhysKeyRowClass,
} from '@/product/terminal/capsule/capsuleStyles';
import {
  ARROW_KEYS,
  COMMON_KEYS,
  type PhysKey,
} from '@/product/terminal/capsule/physKeys';
import { cn } from '@/shared/lib/utils';

const ARROW_ICONS = {
  '←': ArrowLeft,
  '↑': ArrowUp,
  '↓': ArrowDown,
  '→': ArrowRight,
} as const;

/**
 * One directly tappable terminal key.
 *
 * At module scope, and that is still load-bearing: declaring it inside the row
 * makes a new component type on every render, which remounts every key and
 * drops press state. The old chain needed that note for a subtler reason; the
 * row is simpler now, but a key is still a stable identity (#2710).
 */
function PhysKeyButton({
  keyDef,
  isArrow = false,
  disabled,
  onKey,
}: {
  keyDef: PhysKey;
  isArrow?: boolean;
  disabled: boolean;
  onKey: (key: PhysKey) => void;
}) {
  const ArrowIcon = ARROW_ICONS[keyDef.label as keyof typeof ARROW_ICONS];
  return (
    <Button
      variant="ghost"
      size="sm"
      className={isArrow ? capsuleArrowKeyAppButtonClass : capsulePhysKeyButtonClass}
      disabled={disabled}
      data-testid={`phys-key-${keyDef.label}`}
      onClick={() => onKey(keyDef)}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={keyDef.label === 'Del' ? 'Delete' : keyDef.label}
    >
      {ArrowIcon ? <ArrowIcon className={capsulePhysKeyIconClass} /> : keyDef.label}
    </Button>
  );
}

/**
 * The common terminal actions: one tap each, repeatable, and never a chain
 * (#2710 SC-04).
 *
 * The old long-press chain was the only way this row could reach `Ctrl+C`, and
 * it did so by sending several keys one after another. A modifier is now
 * one-shot state in the panel and a chord is one atomic write through the
 * interaction runtime, so the gesture it existed for is gone.
 */
export function PhysKeyRow({
  onKey,
  disabled,
}: {
  onKey: (key: PhysKey) => void;
  disabled: boolean;
}) {
  return (
    <div data-testid="phys-key-row" className={capsulePhysKeyRowClass}>
      <div
        data-testid="phys-key-grid"
        className={cn('grid min-w-0 flex-1 grid-cols-5', capsulePhysKeyGridGapClass)}
      >
        {COMMON_KEYS.map((keyDef) => (
          <PhysKeyButton key={keyDef.label} keyDef={keyDef} disabled={disabled} onKey={onKey} />
        ))}
      </div>
    </div>
  );
}

/** The directional cluster, kept together as its own group (#2710 SC-04). */
export function ArrowKeyRow({
  onKey,
  disabled,
}: {
  onKey: (key: PhysKey) => void;
  disabled: boolean;
}) {
  return (
    <div
      data-testid="arrow-key-grid"
      className={cn('grid shrink-0 grid-cols-4', capsulePhysKeyGridGapClass)}
    >
      {ARROW_KEYS.map((keyDef) => (
        <PhysKeyButton
          key={keyDef.label}
          keyDef={keyDef}
          isArrow
          disabled={disabled}
          onKey={onKey}
        />
      ))}
    </div>
  );
}
