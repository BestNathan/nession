import { cn } from '@/shared/lib/utils';

/**
 * The resource/rich-choice row anatomy (issue 3164).
 *
 * The PopupMenu action row stays single-line at the Experience control band
 * (28px Web / 44px App, issue 1066). A resource choice has a primary identity plus
 * optional source/status/path, so it wraps and takes its content's height while
 * the same control band is the minimum. `ChoiceItemContent` owns the slot
 * grammar; this module owns the row surface so the Select and menu primitives
 * share one recipe.
 */
export const resourceChoiceItemClass = cn(
  'relative flex w-full min-h-[length:var(--nession-control-sm)] cursor-default items-start gap-2.5 rounded-md py-2 pr-9 pl-2 text-sm outline-hidden select-none',
  'focus:bg-accent focus:text-accent-foreground',
  'data-disabled:pointer-events-none data-disabled:opacity-60 data-disabled:text-muted-foreground',
  'data-[selected]:bg-muted/60 data-[selected]:focus:bg-accent',
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
);
