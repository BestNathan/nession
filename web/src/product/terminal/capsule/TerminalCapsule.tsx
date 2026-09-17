import { useCallback, useRef } from 'react';
import { CAPSULE_EXPERIENCE } from '@/product/terminal/capsule/config/experience';
import { CapsuleModeToggle } from '@/product/terminal/capsule/CapsuleModeToggle';
import { CapsuleShell } from '@/product/terminal/capsule/components/CapsuleShell';
import { CommandsComposer } from '@/product/terminal/capsule/components/CommandsComposer';
import { InputComposer } from '@/product/terminal/capsule/components/InputComposer';
import { ComposerMeasureMirror } from '@/product/terminal/capsule/components/ComposerMeasureMirror';
import { CapsuleCommandsHostOverlays } from '@/product/terminal/capsule/components/CapsuleCommandsHostOverlays';
import { CapsuleProvider } from '@/product/terminal/capsule/state/CapsuleProvider';
import { useComposerMeasure } from '@/product/terminal/capsule/state/useComposerMeasure';
import { useCapsuleState } from '@/product/terminal/capsule/state/useCapsuleState';
import {
  layoutFromLineCount,
  type CapsuleCapabilityDisclosure,
  type CapsuleExperience,
  type CapsuleMode,
} from '@/product/terminal/capsule/types';
import { useCapsuleLayoutFlip } from '@/product/terminal/capsule/useCapsuleLayoutFlip';
import { useCapsuleDockClearance } from '@/product/terminal/capsule/hooks/useCapsuleDockClearance';

export interface TerminalCapsuleProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  experience?: CapsuleExperience;
  mode?: CapsuleMode;
  onModeChange?: (mode: CapsuleMode) => void;
  /** Capabilities that earned no chip, reachable through the disclosure entry. */
  capabilityDisclosure?: CapsuleCapabilityDisclosure;
}

export function TerminalCapsule({
  sendText,
  disabled = false,
  experience = 'web',
  mode = 'input',
  onModeChange,
  capabilityDisclosure,
}: TerminalCapsuleProps) {
  const resolvedExperience = experience;
  const experienceConfig = CAPSULE_EXPERIENCE[resolvedExperience];
  const isApp = resolvedExperience === 'app';
  const activeMode = isApp ? mode : 'input';
  const isCommandsMode = isApp && activeMode === 'commands';
  const allowLayoutChanges = !isApp || activeMode === 'input';

  const state = useCapsuleState({
    sendText,
    disabled,
    mode: activeMode,
    onModeChange,
    allowLayoutChanges,
  });

  const shellRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRowRef = useRef<HTMLDivElement>(null);

  useCapsuleDockClearance(dockRef);

  const showModeToggle = Boolean(isApp && onModeChange && experienceConfig.inputControls.modeToggle);
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
    enabled: allowLayoutChanges && !isCommandsMode,
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
        mode={activeMode}
        disabled={disabled}
        dockRef={dockRef}
        shellRef={shellRef}
        contentRef={contentRef}
        measureMirror={<ComposerMeasureMirror mirrorRef={measureMirrorRef} />}
      >
        {isCommandsMode && onModeChange ? (
          <>
            <CapsuleModeToggle mode={mode} onModeChange={onModeChange} disabled={disabled} />
            <CommandsComposer />
          </>
        ) : (
          <InputComposer
            ref={inputRowRef}
            leading={
              showModeToggle && onModeChange ? (
                <CapsuleModeToggle mode={mode} onModeChange={onModeChange} disabled={disabled} />
              ) : null
            }
            capabilityDisclosure={capabilityDisclosure}
          />
        )}
      </CapsuleShell>
      <CapsuleCommandsHostOverlays dockRef={dockRef} />
    </CapsuleProvider>
  );
}

export type { CapsuleMode } from '@/product/terminal/capsule/types';
