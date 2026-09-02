import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type AppToolScrollProps = HTMLAttributes<HTMLDivElement>;

/**
 * App tool scroll container: full-height scroll area whose bottom padding
 * clears BOTH the home indicator and the floating tool bar (which floats at
 * bottom-[var(--sf-space-3)] with a ~44px pill).
 */
export function AppToolScroll({ className, ...rest }: AppToolScrollProps) {
  return (
    <div
      className={cn(
        'h-full min-h-0 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+var(--sf-space-3)+2.75rem)]',
        className,
      )}
      {...rest}
    />
  );
}
