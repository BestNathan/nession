import { useRef, useCallback } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  capsulePhysKeyGridGapClass,
  capsuleArrowKeyButtonClass,
  capsulePhysKeyButtonClass,
  capsulePhysKeyIconClass,
  capsulePhysKeyRowClass,
} from '@/session-first/capsule/capsuleStyles';
import {
  ARROW_KEYS,
  CHAIN_LONG_PRESS_MS,
  LEFT_KEYS,
  type PhysKey,
} from '@/session-first/capsule/physKeys';
import { cn } from '@/lib/utils';

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
  const KeyButton = ({ keyDef, isArrow = false }: { keyDef: PhysKey; isArrow?: boolean }) => {
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
        variant="ghost"
        size="sm"
        className={isArrow ? capsuleArrowKeyButtonClass : capsulePhysKeyButtonClass}
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
      <div
        data-testid="phys-key-grid"
        className={cn('grid min-w-0 flex-1 grid-cols-5', capsulePhysKeyGridGapClass)}
      >
        {LEFT_KEYS.map((keyDef) => (
          <KeyButton key={keyDef.label} keyDef={keyDef} />
        ))}
      </div>
      <div
        data-testid="arrow-key-grid"
        className={cn('grid shrink-0 grid-cols-3 grid-rows-2', capsulePhysKeyGridGapClass)}
      >
        <div />
        <KeyButton keyDef={ARROW_KEYS[0]} isArrow />
        <div />
        <KeyButton keyDef={ARROW_KEYS[1]} isArrow />
        <KeyButton keyDef={ARROW_KEYS[2]} isArrow />
        <KeyButton keyDef={ARROW_KEYS[3]} isArrow />
      </div>
    </div>
  );
}
