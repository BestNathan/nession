import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  capsuleCaptionTextClass,
  capsuleChordLetterClass,
  capsuleMiniButtonClass,
  capsulePhysKeyButtonClass,
  capsulePhysKeyRowClass,
} from '@/product/terminal/capsule/capsuleStyles';
import { ArrowKeyRow, PhysKeyRow } from '@/product/terminal/capsule/PhysKeyRow';
import {
  MODIFIER_CHOICES,
  QUICK_CHORDS,
  type ModifierChoice,
  type PhysKey,
  type QuickChord,
} from '@/product/terminal/capsule/physKeys';
import {
  TERMINAL_CHORD_LETTERS,
  type TerminalChordKey,
  type TerminalChordModifier,
} from '@/platform/terminal-runtime/interaction/TerminalInteractionController';
import { cn } from '@/shared/lib/utils';

type SendChord = (modifier: TerminalChordModifier, key: TerminalChordKey) => void;

function QuickChordRow({
  disabled,
  sendChord,
}: {
  disabled: boolean;
  sendChord?: SendChord;
}) {
  return (
    <div
      data-testid="terminal-quick-chords"
      className={cn(
        'flex items-center gap-[length:var(--nession-terminal-capsule-phys-key-grid-gap)]',
        capsulePhysKeyRowClass,
      )}
    >
      <span className={capsuleCaptionTextClass}>Common shortcuts</span>
      {QUICK_CHORDS.map((chord: QuickChord) => (
        <Button
          key={chord.ariaLabel}
          variant="ghost"
          size="sm"
          data-testid={`quick-chord-${chord.ariaLabel}`}
          aria-label={chord.ariaLabel}
          disabled={disabled || !sendChord}
          onClick={() => sendChord?.(chord.modifier, chord.key)}
          className={capsulePhysKeyButtonClass}
        >
          {chord.label}
        </Button>
      ))}
    </div>
  );
}

function LetterSelector({
  activeModifier,
  disabled,
  sendChord,
  onClear,
  onPick,
}: {
  activeModifier: ModifierChoice;
  disabled: boolean;
  sendChord?: SendChord;
  onClear: () => void;
  onPick: (letter: (typeof TERMINAL_CHORD_LETTERS)[number]) => void;
}) {
  return (
    <div
      data-testid="terminal-chord-picker"
      className={cn(
        'flex items-center gap-[length:var(--nession-terminal-capsule-phys-key-grid-gap)]',
        capsulePhysKeyRowClass,
      )}
    >
      <span className={capsuleCaptionTextClass}>{activeModifier.ariaLabel} +</span>
      <div
        data-testid="terminal-chord-letters"
        aria-label={`${activeModifier.ariaLabel} plus a letter`}
        className="flex min-w-0 flex-1 items-center gap-[length:var(--nession-terminal-capsule-phys-key-grid-gap)] overflow-x-auto overscroll-contain"
      >
        {TERMINAL_CHORD_LETTERS.map((letter) => (
          <Button
            key={letter}
            variant="ghost"
            size="sm"
            data-testid={`chord-letter-${letter}`}
            aria-label={`${activeModifier.ariaLabel} plus ${letter}`}
            disabled={disabled || !sendChord}
            onClick={() => onPick(letter)}
            className={capsuleChordLetterClass}
          >
            {letter}
          </Button>
        ))}
      </div>
      <Button
        variant="ghost"
        size="sm"
        data-testid="terminal-chord-cancel"
        onClick={onClear}
        className={capsuleMiniButtonClass}
      >
        Cancel
      </Button>
    </div>
  );
}

function ModifierRow({
  modifier,
  disabled,
  sendChord,
  onToggle,
  onKey,
}: {
  modifier: TerminalChordModifier | null;
  disabled: boolean;
  sendChord?: SendChord;
  onToggle: (modifier: TerminalChordModifier) => void;
  onKey: (key: PhysKey) => void;
}) {
  return (
    <div className={cn(capsulePhysKeyRowClass, 'border-b-0')}>
      <div
        data-testid="terminal-modifiers"
        className="flex min-w-0 flex-1 items-center gap-[length:var(--nession-terminal-capsule-phys-key-grid-gap)]"
      >
        {MODIFIER_CHOICES.map((choice) => {
          const selected = modifier === choice.modifier;
          return (
            <Button
              key={choice.modifier}
              variant="ghost"
              size="sm"
              data-testid={`terminal-modifier-${choice.modifier}`}
              aria-label={choice.ariaLabel}
              aria-pressed={selected}
              disabled={disabled || !sendChord}
              onClick={() => onToggle(choice.modifier)}
              className={cn(
                capsulePhysKeyButtonClass,
                selected && 'bg-accent text-accent-foreground',
              )}
            >
              {choice.label}
            </Button>
          );
        })}
      </div>
      <ArrowKeyRow onKey={onKey} disabled={disabled} />
    </div>
  );
}

/**
 * Terminal Keys — the key row above the composer (#826 §7), redesigned around
 * atomic chords (#2710).
 *
 * Three things this view is not:
 *
 * - **not a chain UI.** Holding a key used to start a chain of sequential
 *   sends; `Ctrl+C` was reachable only by sending `Ctrl` and then `C` as two
 *   writes, which is not a chord. A modifier here is one-shot state, and a
 *   chord is one `sendChord` call.
 * - **not an owner of escape strings.** Direct keys go through the semantic
 *   layer; chords go through the interaction runtime's encoder (#1096
 *   criterion 4).
 * - **not a keyboard.** It never routes gestures into xterm scroll, selection
 *   or App navigation; #2657's long-press direction pad stays independent.
 */
export function TerminalKeysProjection({
  sendPhysKey,
  sendChord,
  disabled,
}: {
  sendPhysKey: (key: PhysKey) => void;
  sendChord?: SendChord;
  disabled: boolean;
}) {
  const [modifier, setModifier] = useState<TerminalChordModifier | null>(null);
  const activeModifier = modifier
    ? MODIFIER_CHOICES.find((choice) => choice.modifier === modifier)
    : undefined;

  const sendTappedKey = (key: PhysKey) => {
    if (modifier) {
      sendChord?.(modifier, key.semanticKey);
      setModifier(null);
      return;
    }
    sendPhysKey(key);
  };

  return (
    <div
      data-testid="terminal-keys-body"
      className="flex flex-col gap-[length:var(--nession-terminal-capsule-projection-item-gap)]"
    >
      {modifier && activeModifier ? (
        <LetterSelector
          activeModifier={activeModifier}
          disabled={disabled}
          sendChord={sendChord}
          onClear={() => setModifier(null)}
          onPick={(letter) => {
            sendChord?.(modifier, letter);
            setModifier(null);
          }}
        />
      ) : (
        <QuickChordRow disabled={disabled} sendChord={sendChord} />
      )}

      <PhysKeyRow onKey={sendTappedKey} disabled={disabled} />

      <ModifierRow
        modifier={modifier}
        disabled={disabled}
        sendChord={sendChord}
        onToggle={(next) => setModifier((previous) => (previous === next ? null : next))}
        onKey={sendTappedKey}
      />

      <p data-testid="terminal-keys-hint" className={capsuleCaptionTextClass}>
        {modifier
          ? 'Selected modifier clears after the next key or Cancel.'
          : 'Modifiers are one-shot. The Terminal stays interactive.'}
      </p>
    </div>
  );
}
