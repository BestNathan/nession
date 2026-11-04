import { useCallback, type RefObject } from 'react';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';

/**
 * The two saved-command actions the capsule offers a Peek (#2710 SC-05).
 *
 * Insert is the same dismissal a tap on the field performs: the upper slot
 * closes, the composer keeps its geometry, and focus moves to the text the
 * user is about to edit. Run sends the command with Return through the capsule's
 * existing terminal path and records it in the same history the composer writes.
 *
 * Extracted from `TerminalCapsule` so that component stays a composition of
 * regions rather than a second home for command semantics.
 */
export function useCapsuleCommandActions({
  insertText,
  runCommand,
  capabilityProjection,
  fieldRef,
}: {
  insertText: (text: string) => void;
  runCommand: (text: string) => void;
  capabilityProjection?: CapsuleCapabilityProjection;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const handleInsertText = useCallback(
    (text: string) => {
      insertText(text);
      capabilityProjection?.onDismiss();
      fieldRef.current?.focus({ preventScroll: true });
    },
    [capabilityProjection, fieldRef, insertText],
  );

  const handleRunCommand = useCallback(
    (text: string) => {
      runCommand(text);
    },
    [runCommand],
  );

  return { handleInsertText, handleRunCommand };
}
