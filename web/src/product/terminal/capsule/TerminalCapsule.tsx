import { useCallback, useEffect, useRef } from 'react';
import { CAPSULE_EXPERIENCE } from '@/product/terminal/capsule/config/experience';
import { CapsuleShell } from '@/product/terminal/capsule/components/CapsuleShell';
import { InputComposer } from '@/product/terminal/capsule/components/InputComposer';
import { ComposerMeasureMirror } from '@/product/terminal/capsule/components/ComposerMeasureMirror';
import { CapsuleProvider } from '@/product/terminal/capsule/state/CapsuleProvider';
import { useComposerMeasure } from '@/product/terminal/capsule/state/useComposerMeasure';
import { useCapsuleState } from '@/product/terminal/capsule/state/useCapsuleState';
import { PeekHost } from '@/product/terminal/capsule/components/PeekHost';
import {
  layoutFromLineCount,
  type CapsuleCapabilityDisclosure,
  type CapsuleCapabilityProjection,
  type CapsuleExperience,
} from '@/product/terminal/capsule/types';
import { useCapsuleLayoutFlip } from '@/product/terminal/capsule/useCapsuleLayoutFlip';
import { useCapsuleDockClearance } from '@/product/terminal/capsule/hooks/useCapsuleDockClearance';

export interface TerminalCapsuleProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  experience?: CapsuleExperience;
  /** Capabilities that earned no chip, reachable through the disclosure entry. */
  capabilityDisclosure?: CapsuleCapabilityDisclosure;
  /**
   * A capability emerging beside the capsule, if Nession decided one should.
   *
   * Absent in the resting state — which is the state the capsule is designed
   * around, and the one the golden screenshots capture.
   */
  capabilityProjection?: CapsuleCapabilityProjection;
}

export function TerminalCapsule({
  sendText,
  disabled = false,
  experience = 'web',
  capabilityDisclosure,
  capabilityProjection,
}: TerminalCapsuleProps) {
  const resolvedExperience = experience;
  const experienceConfig = CAPSULE_EXPERIENCE[resolvedExperience];

  const state = useCapsuleState({ sendText, disabled });

  const shellRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRowRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  /**
   * A projection that claims the keyboard, and the composer competing for it.
   *
   * Both halves of #1034's input-focus rules read one boolean the capability
   * declared — never a capability id — so the capsule stays generic: a second
   * tap-driven accessory arrives with the flag and this file does not change.
   */
  const projectionOwnsInputFocus = Boolean(capabilityProjection?.ownsInputFocus);
  const projectionId = capabilityProjection?.id ?? null;

  /**
   * The accessory takes the keyboard when it appears.
   *
   * Blurring the field is *how* a soft keyboard is dismissed — there is no
   * declarative equivalent — and leaving it focused would put the IME on top of
   * the keys the accessory exists to expose (#1034 §5, criterion 7).
   *
   * Keyed on the projection's identity as well as the flag: a projection that
   * replaces another one still claims the keyboard on arrival, and two
   * keyboard-owning surfaces are already mutually exclusive by construction.
   */
  useEffect(() => {
    if (projectionOwnsInputFocus) {
      fieldRef.current?.blur();
    }
  }, [projectionId, projectionOwnsInputFocus]);

  /**
   * …and the composer takes it back when the user reaches for it.
   *
   * Tapping the field dismisses the projection rather than merely focusing the
   * field. That is what makes the two secondary surfaces exclusive (criterion
   * 14) and what returns the user to text entry (criterion 8): the dismissal
   * steps the projection out and nothing else — the Session and the Terminal are
   * not touched, because neither is part of what was dismissed.
   */
  const handleFieldFocus = useCallback(() => {
    if (projectionOwnsInputFocus) {
      capabilityProjection?.onDismiss();
    }
  }, [capabilityProjection, projectionOwnsInputFocus]);

  // The shell, not the dock: the dock also carries a capability projection when
  // one has emerged, and reserving terminal height for a temporary surface
  // reflows the work surface every time it appears and goes away
  // (see the hook).
  useCapsuleDockClearance(shellRef);

  const {
    applyLineCount,
    composerLayout,
    send: stateSend,
    ...restState
  } = state;

  const { captureBeforeLayoutChange } = useCapsuleLayoutFlip(
    composerLayout,
    inputRowRef,
  );

  const handleLineCountChange = useCallback(
    (lineCount: number) => {
      const next = layoutFromLineCount(lineCount);
      if (next !== composerLayout) {
        captureBeforeLayoutChange();
      }
      applyLineCount(lineCount);
    },
    [applyLineCount, captureBeforeLayoutChange, composerLayout],
  );

  const send = useCallback(() => {
    if (composerLayout === 'stacked') {
      captureBeforeLayoutChange();
    }
    stateSend();
  }, [captureBeforeLayoutChange, composerLayout, stateSend]);

  const measureMirrorRef = useComposerMeasure({
    value: restState.inputValue,
    shellRef,
    contentWidthRef: contentRef,
    onLineCountChange: handleLineCountChange,
  });

  return (
    <CapsuleProvider
      value={{
        ...restState,
        applyLineCount,
        composerLayout,
        send,
        experience: resolvedExperience,
        experienceConfig,
        sendText,
      }}
    >
      <CapsuleShell
        experience={resolvedExperience}
        layout={composerLayout}
        disabled={disabled}
        dockRef={dockRef}
        shellRef={shellRef}
        contentRef={contentRef}
        measureMirror={<ComposerMeasureMirror mirrorRef={measureMirrorRef} />}
        projection={
          capabilityProjection ? (
            <PeekHost
              projection={capabilityProjection}
              sendText={sendText}
              disabled={disabled}
            />
          ) : null
        }
      >
        <InputComposer
          ref={inputRowRef}
          capabilityDisclosure={capabilityDisclosure}
          onFieldFocus={handleFieldFocus}
          fieldRef={fieldRef}
        />
      </CapsuleShell>
    </CapsuleProvider>
  );
}
