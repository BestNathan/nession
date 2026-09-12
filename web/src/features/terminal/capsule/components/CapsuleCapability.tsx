import { cn } from '@/lib/utils';
import { capsuleControlRowClass } from '@/features/terminal/capsule/capsuleStyles';
import type { CapsuleCapabilityPresence } from '@/features/terminal/capsule/types';

/**
 * Lightweight presence for a capability that earned it.
 *
 * The capsule shows at most one of these (see `app/capsulePresence.ts`): a
 * capability appears here only while it is relevant or active, and it never
 * turns into a row of installed extensions. The dot carries the state — muted
 * for `relevant`, live for `active` — so the chip stays one line at control
 * height instead of growing chrome.
 */
export function CapsuleCapability({ capability }: { capability: CapsuleCapabilityPresence }) {
  const isActive = capability.state === 'active';

  return (
    <button
      type="button"
      data-testid="capsule-capability"
      data-capability-id={capability.id}
      data-capability-state={capability.state}
      aria-label={`${capability.label} (${capability.state})`}
      onClick={() => capability.onActivate()}
      className={cn(
        capsuleControlRowClass,
        'shrink touch-manipulation rounded-full px-[length:var(--composer-control-gap)] gap-[length:var(--composer-chip-gap)] text-[length:var(--composer-font-size)]',
        isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-[length:var(--icon-sm)] shrink-0 rounded-full',
          isActive ? 'bg-primary' : 'bg-muted-foreground/40',
        )}
      />
      <span className="min-w-0 truncate">{capability.label}</span>
    </button>
  );
}
