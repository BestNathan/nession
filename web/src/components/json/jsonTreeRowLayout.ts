import { cn } from '@/shared/lib/utils';
import { jsonTreeMonoClass } from './jsonTreeClasses';

/** Key | : | value — value column owns wrapping (#1199 review fix). */
export const jsonKvRowGridClass = cn(
  jsonTreeMonoClass(),
  'grid grid-cols-[max-content_max-content_minmax(0,1fr)] gap-x-1 py-0.5 min-w-0 items-baseline',
);

export const jsonKvValueCellClass = 'min-w-0 min-h-0 break-words';
