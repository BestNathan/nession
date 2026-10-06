import { cn } from '@/shared/lib/utils';

export function jsonTreeMonoClass(className?: string) {
  return cn(
    'font-mono text-[length:var(--nession-workspace-editor-font-size)] leading-[var(--nession-workspace-editor-line-height)]',
    className,
  );
}
