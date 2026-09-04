import { cn } from '@/lib/utils';
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
} from '@/session-first/capsule/capsuleStyles';
import type {
  CapsuleExperience,
  CapsuleMode,
  ComposerLayout,
} from '@/session-first/capsule/types';
import { dockHeightFromLayout } from '@/session-first/capsule/measure/layoutFromLineCount';

interface CapsuleShellProps {
  experience: CapsuleExperience;
  layout?: ComposerLayout;
  mode?: CapsuleMode;
  disabled?: boolean;
  dockRef?: React.Ref<HTMLDivElement>;
  shellRef?: React.Ref<HTMLDivElement>;
  contentRef?: React.Ref<HTMLDivElement>;
  measureMirror?: React.ReactNode;
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
  children,
}: CapsuleShellProps) {
  const isCommandsMode = mode === 'commands';
  const showLayout = !isCommandsMode;
  const isApp = experience === 'app';
  const usePillShape =
    (isApp && isCommandsMode) ||
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
        'absolute z-10 flex flex-col',
        isApp ? capsuleShellAppOuterClass : capsuleShellWebOuterClass,
        isApp ? capsuleShellAppDockBottomClass : capsuleShellDockBottomClass,
      )}
    >
      <div
        ref={shellRef}
        data-testid="capsule-shell"
        className={cn(
          'flex min-h-[length:var(--control-md)]',
          capsuleShellInnerClass,
          capsuleShellSurfaceClass,
          usePillShape ? capsuleShellPillRadiusClass : capsuleShellCapsuleRadiusClass,
          capsuleShellInnerPadClass,
          isCommandsMode
            ? cn('items-center', capsuleShellContentGapClass)
            : 'items-center',
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
