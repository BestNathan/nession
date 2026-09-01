import { cn } from '@/lib/utils';
import { capsuleFieldPadClass, capsuleFieldTypeClass } from '@/session-first/capsule/capsuleStyles';

export function ComposerMeasureMirror({
  mirrorRef,
}: {
  mirrorRef: React.Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      ref={mirrorRef}
      aria-hidden
      tabIndex={-1}
      data-testid="capsule-composer-measure-mirror"
      rows={1}
      readOnly
      className={cn(
        'pointer-events-none fixed -left-[9999px] top-0 opacity-0',
        'w-full resize-none overflow-hidden border-0 bg-transparent',
        capsuleFieldPadClass,
        capsuleFieldTypeClass,
      )}
    />
  );
}
