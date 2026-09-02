import { useRef, useCallback } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  capsuleDropdownItemClass,
  capsuleDropdownMinWidthClass,
  capsulePhysKeyButtonClass,
  capsulePhysKeyGridGapClass,
  capsulePhysKeyIconClass,
  capsulePhysKeyRowClass,
} from '@/session-first/capsule/capsuleStyles';
import {
  ARROW_KEYS,
  CHAIN_LONG_PRESS_MS,
  LEFT_KEYS,
  type PhysKey,
} from '@/session-first/capsule/physKeys';

interface PhysKeyRowProps {
  onKey: (seq: string) => void;
  disabled: boolean;
  chainBuffer: string[];
  isChaining: boolean;
  onChainStart: (seq: string) => void;
  onChainAdd: (seq: string) => void;
}

export function PhysKeyRow({
  onKey,
  disabled,
  chainBuffer,
  isChaining,
  onChainStart,
  onChainAdd,
}: PhysKeyRowProps) {
  const hasOverflow = LEFT_KEYS.length > 10;
  const visibleCount = hasOverflow ? 9 : LEFT_KEYS.length;
  const visibleKeys = LEFT_KEYS.slice(0, visibleCount);
  const dropdownKeys = hasOverflow ? LEFT_KEYS.slice(visibleCount) : [];

  const KeyButton = ({ keyDef }: { keyDef: PhysKey }) => {
    const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const iconEl =
      keyDef.label === '←' ? <ArrowLeft className={capsulePhysKeyIconClass} /> :
      keyDef.label === '↑' ? <ArrowUp className={capsulePhysKeyIconClass} /> :
      keyDef.label === '↓' ? <ArrowDown className={capsulePhysKeyIconClass} /> :
      keyDef.label === '→' ? <ArrowRight className={capsulePhysKeyIconClass} /> :
      null;

    const handlePointerDown = () => {
      if (disabled) {
        return;
      }
      pressTimerRef.current = setTimeout(() => {
        if (isChaining) {
          onKey([...chainBuffer, keyDef.seq].join(''));
        } else {
          onChainStart(keyDef.seq);
        }
      }, CHAIN_LONG_PRESS_MS);
    };

    const handlePointerUp = () => {
      if (pressTimerRef.current) {
        clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
      if (isChaining) {
        onChainAdd(keyDef.seq);
      } else {
        onKey(keyDef.seq);
      }
    };

    const handlePointerLeave = useCallback(() => {
      if (pressTimerRef.current) {
        clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
    }, []);

    return (
      <Button
        variant="secondary"
        size="sm"
        className={capsulePhysKeyButtonClass}
        disabled={disabled}
        data-testid={`phys-key-${keyDef.label}`}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onContextMenu={(event) => event.preventDefault()}
        aria-label={keyDef.label}
      >
        {iconEl ?? keyDef.label}
      </Button>
    );
  };

  return (
    <div data-testid="phys-key-row" className={capsulePhysKeyRowClass}>
      <div className={cn('grid flex-1 grid-cols-5', capsulePhysKeyGridGapClass)}>
        {visibleKeys.map((keyDef) => (
          <KeyButton key={keyDef.label} keyDef={keyDef} />
        ))}
        {hasOverflow ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="secondary"
                  size="sm"
                  className={capsulePhysKeyButtonClass}
                  disabled={disabled}
                  aria-label="More keys"
                >
                  <MoreHorizontal className={capsulePhysKeyIconClass} />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className={capsuleDropdownMinWidthClass}>
              {dropdownKeys.map((keyDef) => (
                <DropdownMenuItem
                  key={keyDef.label}
                  onClick={() => onKey(keyDef.seq)}
                  className={capsuleDropdownItemClass}
                >
                  {keyDef.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <div className={cn('grid shrink-0 grid-cols-3 grid-rows-2', capsulePhysKeyGridGapClass)}>
        <div />
        <KeyButton keyDef={ARROW_KEYS[0]} />
        <div />
        <KeyButton keyDef={ARROW_KEYS[1]} />
        <KeyButton keyDef={ARROW_KEYS[2]} />
        <KeyButton keyDef={ARROW_KEYS[3]} />
      </div>
    </div>
  );
}
