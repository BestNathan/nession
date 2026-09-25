import { cn } from '@/shared/lib/utils';
import {
  capsuleShellAppDockBottomClass,
  capsuleShellAppOuterClass,
  capsuleShellCapsuleRadiusClass,
  capsuleShellDockBottomClass,
  capsuleShellInnerClass,
  capsuleShellInnerPadClass,
  capsuleShellPillRadiusClass,
  capsuleShellSurfaceClass,
  capsuleShellWebOuterClass,
} from '@/product/terminal/capsule/capsuleStyles';
import type {
  CapsuleExperience,
  ComposerLayout,
} from '@/product/terminal/capsule/types';
import { dockHeightFromLayout } from '@/product/terminal/capsule/measure/layoutFromLineCount';

interface CapsuleShellProps {
  experience: CapsuleExperience;
  layout?: ComposerLayout;
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
  disabled,
  dockRef,
  shellRef,
  contentRef,
  measureMirror,
  projection,
  children,
}: CapsuleShellProps) {
  const isApp = experience === 'app';
  const usePillShape = !isApp && layout === 'flat';

  return (
    <div
      ref={dockRef}
      data-testid="terminal-capsule"
      data-experience={experience}
      data-disabled={disabled ? 'true' : undefined}
      data-layout={layout}
      data-dock-height={dockHeightFromLayout(layout)}
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
        )}
      >
        <div
          ref={contentRef}
          data-testid="capsule-shell-content"
          className="flex min-w-0 flex-1 items-center overflow-hidden"
        >
          {children}
        </div>
      </div>
      {measureMirror}
    </div>
  );
}
