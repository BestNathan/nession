import { cn } from '@/shared/lib/utils';

export function jsonTreeMonoClass(className?: string) {
  return cn(
    'font-mono text-[length:var(--workspace-editor-font-size)] leading-[var(--workspace-editor-line-height)]',
    className,
  );
}
