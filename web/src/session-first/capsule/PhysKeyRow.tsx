import { useRef, useCallback } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
      keyDef.label === '←' ? <ArrowLeft className="size-3.5" /> :
      keyDef.label === '↑' ? <ArrowUp className="size-3.5" /> :
      keyDef.label === '↓' ? <ArrowDown className="size-3.5" /> :
      keyDef.label === '→' ? <ArrowRight className="size-3.5" /> :
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
        className="h-9 w-full text-xs font-mono"
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
    <div data-testid="phys-key-row" className="flex justify-between gap-2 border-b border-border/60 px-2 py-1.5">
      <div className="grid flex-1 grid-cols-5 gap-1">
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
                  className="h-9 w-full text-xs"
                  disabled={disabled}
                  aria-label="More keys"
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-[100px]">
              {dropdownKeys.map((keyDef) => (
                <DropdownMenuItem
                  key={keyDef.label}
                  onClick={() => onKey(keyDef.seq)}
                  className="cursor-pointer font-mono text-xs"
                >
                  {keyDef.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <div className="grid shrink-0 grid-cols-3 grid-rows-2 gap-1">
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
