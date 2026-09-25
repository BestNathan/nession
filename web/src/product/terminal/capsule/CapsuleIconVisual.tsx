import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import { capsuleIconVisualClass } from '@/product/terminal/capsule/capsuleStyles';

interface CapsuleIconVisualProps {
  /**
   * Paint for the drawn affordance. Send paints it continuously; the secondary
   * actions leave it unpainted. Whatever a caller paints lands here, **not** on
   * the control — see the note below.
   */
  className?: string;
  /** The icon, which is drawn inside the affordance rather than beside it. */
  children?: ReactNode;
}

/**
 * The affordance a capsule control *draws*, as opposed to the box it is *hit* in.
 *
 * A capsule icon action is two elements: the control (`capsuleIconButtonClass`,
 * `control.md` — 44px on App) and this, the smaller circle painted inside it
 * (`control.visualSize`, 36px on App). Both are needed because they answer
 * different questions and are measured differently: hit-area assertions measure
 * the element they are handed, so a smaller painting inside the same box is only
 * measurable — and only *expressible* — on a second node (#1034).
 *
 * It is one component rather than three copies of the same `<span>` because the
 * affordance has to be the *same* object everywhere it is drawn — the contract
 * finds it by that testid, and the design gate reads its class out of
 * `capsuleStyles` — and because the split carries a trap worth recording once.
 * The shadcn `Button` *variant* paints the
 * outer element (`ghost` → `hover:bg-muted`, `default` → `bg-primary`), so
 * moving the circle inside does not stop the 44px box from filling: on hover,
 * and on touch where the hover sticks, every secondary action becomes a filled
 * 44px square again — the exact regression this split is meant to end. Callers
 * on a `Button` must therefore neutralise the outer paint (`bg-transparent
 * hover:bg-transparent`), and keep the paint here instead.
 *
 * `aria-hidden` is right: the affordance is decoration, and the control that
 * contains it carries the `aria-label`. The icon is inside, so it is hidden with
 * it — which is what makes the labelled control, not the glyph, the accessible
 * object.
 */
export function CapsuleIconVisual({ className, children }: CapsuleIconVisualProps) {
  return (
    <span
      aria-hidden
      data-testid="capsule-control-visual"
      className={cn(capsuleIconVisualClass, className)}
    >
      {children}
    </span>
  );
}
