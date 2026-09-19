import { cn } from '@/shared/lib/utils';
import {
  capsuleShellAppDockBottomClass,
  capsuleShellAppOuterClass,
  capsuleShellCapsuleRadiusClass,
  capsuleShellContentGapClass,
  capsuleShellDockBottomClass,
  capsuleShellInnerClass,
  capsuleShellInnerPadClass,
  capsuleShellPillRadiusClass,
  capsuleShellSurfaceClass,
  capsuleShellWebOuterClass,
} from '@/product/terminal/capsule/capsuleStyles';
import { useCapsuleContext } from '@/product/terminal/capsule/state/useCapsuleContext';
import type {
  CapsuleExperience,
  CapsuleMode,
  ComposerLayout,
} from '@/product/terminal/capsule/types';
import { dockHeightFromLayout } from '@/product/terminal/capsule/measure/layoutFromLineCount';

interface CapsuleShellProps {
  experience: CapsuleExperience;
  layout?: ComposerLayout;
  mode?: CapsuleMode;
  disabled?: boolean;
  dockRef?: React.Ref<HTMLDivElement>;
  shellRef?: React.Ref<HTMLDivElement>;
  contentRef?: React.Ref<HTMLDivElement>;
  measureMirror?: React.ReactNode;
  /**
   * Something emerging above the capsule — a capability Signal or Peek.
   *
   * A slot rather than a capability concept: the shell renders what it is
   * given and knows nothing about what it means. It sits outside the shell
   * surface, so the capsule's own box is unaffected by whether anything is
   * there.
   */
  projection?: React.ReactNode;
  children: React.ReactNode;
}

export function CapsuleShell({
  experience,
  layout = 'flat',
  mode = 'input',
  disabled,
  dockRef,
  shellRef,
  contentRef,
  measureMirror,
  projection,
  children,
}: CapsuleShellProps) {
  const { commandsOpen } = useCapsuleContext();
  const isCommandsMode = mode === 'commands';
  const showLayout = !isCommandsMode;
  const isApp = experience === 'app';
  const usePillShape =
    (isApp && isCommandsMode && !commandsOpen) ||
    (!isCommandsMode && layout === 'flat' && !isApp);

  return (
    <div
      ref={dockRef}
      data-testid="terminal-capsule"
      data-experience={experience}
      data-disabled={disabled ? 'true' : undefined}
      data-layout={showLayout ? layout : undefined}
      data-dock-height={showLayout ? dockHeightFromLayout(layout) : 'single'}
      data-shell-shape={usePillShape ? 'pill' : 'capsule'}
      className={cn(
        'absolute z-30 flex flex-col',
        isApp ? capsuleShellAppOuterClass : capsuleShellWebOuterClass,
        isApp ? capsuleShellAppDockBottomClass : capsuleShellDockBottomClass,
      )}
    >
      {projection}
      <div
        ref={shellRef}
        data-testid="capsule-shell"
        className={cn(
          'flex min-h-[length:var(--control-md)] items-center',
          capsuleShellInnerClass,
          capsuleShellSurfaceClass,
          usePillShape ? capsuleShellPillRadiusClass : capsuleShellCapsuleRadiusClass,
          capsuleShellInnerPadClass,
          isCommandsMode && capsuleShellContentGapClass,
        )}
      >
        <div
          ref={contentRef}
          data-testid="capsule-shell-content"
          className={cn(
            'flex min-w-0 flex-1 items-center overflow-hidden',
            isCommandsMode && capsuleShellContentGapClass,
          )}
        >
          {children}
        </div>
      </div>
      {measureMirror}
    </div>
  );
}
