import { useRef, useCallback } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  capsulePhysKeyGridGapClass,
  capsuleArrowKeyAppButtonClass,
  capsulePhysKeyButtonClass,
  capsulePhysKeyIconClass,
  capsulePhysKeyRowClass,
} from '@/product/terminal/capsule/capsuleStyles';
import {
  ARROW_KEYS,
  CHAIN_LONG_PRESS_MS,
  LEFT_KEYS,
  type PhysKey,
} from '@/product/terminal/capsule/physKeys';
import { cn } from '@/shared/lib/utils';

interface KeyButtonProps {
  keyDef: PhysKey;
  isArrow?: boolean;
  disabled: boolean;
  isChaining: boolean;
  onKey: (key: PhysKey) => void;
  onChainStart: (key: PhysKey) => void;
  onChainAdd: (key: PhysKey) => void;
  onChainComplete: (key: PhysKey) => void;
}

/**
 * One key in the row.
 *
 * **At module scope, and that is load-bearing.** It used to be declared inside
 * `PhysKeyRow`, which makes a new component *type* on every render, so React
 * remounted the whole row on every state change — and opening a chain is a
 * state change. The press that opened one therefore lost the refs describing
 * it, and the release that followed was read as a fresh tap: holding a key to
 * open a chain added that key to it twice, and holding one to send a chain sent
 * the key again after the chain.
 *
 * Nothing here decides what a key *is*; it reports the gesture and hands over
 * the key. Encoding belongs to the interaction layer (#1096 criterion 4).
 */
function KeyButton({
  keyDef,
  isArrow = false,
  disabled,
  isChaining,
  onKey,
  onChainStart,
  onChainAdd,
  onChainComplete,
}: KeyButtonProps) {
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapHandledByPointerRef = useRef(false);
  /**
   * Whether the press in flight already became a long press, so the release
   * that follows it is not also treated as a tap.
   */
  const longPressFiredRef = useRef(false);

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
    longPressFiredRef.current = false;
    pressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      // This press is spent — and the click the browser sends on release must
      // not be read as a tap on top of it.
      tapHandledByPointerRef.current = true;
      pressTimerRef.current = null;
      if (isChaining) {
        // The chain is the hook's to close; the row only reports the gesture.
        onChainComplete(keyDef);
      } else {
        onChainStart(keyDef);
      }
    }, CHAIN_LONG_PRESS_MS);
  };

  const handlePointerUp = () => {
    if (disabled) {
      return;
    }
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    tapHandledByPointerRef.current = true;
    if (isChaining) {
      onChainAdd(keyDef);
    } else {
      onKey(keyDef);
    }
  };

  const handleClick = () => {
    if (disabled || pressTimerRef.current) {
      return;
    }
    // A press already handled this — either the release above, or a long press.
    // What is left is keyboard activation, which sends no pointer events.
    if (tapHandledByPointerRef.current) {
      tapHandledByPointerRef.current = false;
      return;
    }
    if (isChaining) {
      onChainAdd(keyDef);
    } else {
      onKey(keyDef);
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
      className={isArrow ? capsuleArrowKeyAppButtonClass : capsulePhysKeyButtonClass}
      disabled={disabled}
      data-testid={`phys-key-${keyDef.label}`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onClick={handleClick}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={keyDef.label}
    >
      {iconEl ?? keyDef.label}
    </Button>
  );
}

interface PhysKeyRowProps {
  onKey: (key: PhysKey) => void;
  disabled: boolean;
  isChaining: boolean;
  onChainStart: (key: PhysKey) => void;
  onChainAdd: (key: PhysKey) => void;
  /** The chain is open and this key completed it — the "hold to send" path. */
  onChainComplete: (key: PhysKey) => void;
}

export function PhysKeyRow({
  onKey,
  disabled,
  isChaining,
  onChainStart,
  onChainAdd,
  onChainComplete,
}: PhysKeyRowProps) {
  const buttonProps = {
    disabled,
    isChaining,
    onKey,
    onChainStart,
    onChainAdd,
    onChainComplete,
  };

  return (
    <div data-testid="phys-key-row" className={capsulePhysKeyRowClass}>
      <div
        data-testid="phys-key-grid"
        className={cn('grid min-w-0 flex-1 grid-cols-5', capsulePhysKeyGridGapClass)}
      >
        {LEFT_KEYS.map((keyDef) => (
          <KeyButton key={keyDef.label} keyDef={keyDef} {...buttonProps} />
        ))}
      </div>
      <div
        data-testid="arrow-key-grid"
        className={cn('grid shrink-0 grid-cols-3 grid-rows-2', capsulePhysKeyGridGapClass)}
      >
        <div />
        <KeyButton keyDef={ARROW_KEYS[0]} isArrow {...buttonProps} />
        <div />
        <KeyButton keyDef={ARROW_KEYS[1]} isArrow {...buttonProps} />
        <KeyButton keyDef={ARROW_KEYS[2]} isArrow {...buttonProps} />
        <KeyButton keyDef={ARROW_KEYS[3]} isArrow {...buttonProps} />
      </div>
    </div>
  );
}
