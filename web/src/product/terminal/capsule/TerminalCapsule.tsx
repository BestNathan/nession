import { useCallback, useRef } from 'react';
import { CAPSULE_EXPERIENCE } from '@/product/terminal/capsule/config/experience';
import { CapsuleShell } from '@/product/terminal/capsule/components/CapsuleShell';
import { InputComposer } from '@/product/terminal/capsule/components/InputComposer';
import { ComposerMeasureMirror } from '@/product/terminal/capsule/components/ComposerMeasureMirror';
import { CapsuleProvider } from '@/product/terminal/capsule/state/CapsuleProvider';
import { useComposerMeasure } from '@/product/terminal/capsule/state/useComposerMeasure';
import { useCapsuleState } from '@/product/terminal/capsule/state/useCapsuleState';
import { CapabilityProjection } from '@/product/terminal/capsule/components/CapabilityProjection';
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
            <CapabilityProjection
              projection={capabilityProjection}
              sendText={sendText}
              disabled={disabled}
            />
          ) : null
        }
      >
        <InputComposer ref={inputRowRef} capabilityDisclosure={capabilityDisclosure} />
      </CapsuleShell>
    </CapsuleProvider>
  );
}
