import { cn } from '@/shared/lib/utils';
import { jsonTreeMonoClass } from './jsonTreeClasses';

/** Key | : | value — value column owns wrapping (#1199 review fix). */
export const jsonKvRowGridClass = cn(
  jsonTreeMonoClass(),
  'grid grid-cols-[max-content_max-content_minmax(0,1fr)] gap-x-1 py-0.5 min-w-0 items-baseline',
);

export const jsonKvValueCellClass = 'min-w-0 min-h-0 break-words';

/** Indent for properties under a root `{` / `[` (#1199). */
export const jsonTreeRootBodyIndentClass = 'pl-[var(--shell-space-2)]';

/** Nested object/array body — border guides depth. */
export const jsonTreeNestedBodyIndentClass = 'pl-4 border-l border-border/30 ml-1.5';
