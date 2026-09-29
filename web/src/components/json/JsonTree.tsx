import { cn } from '@/shared/lib/utils';
import { JsonCompactValue } from './JsonCompactValue';
import { JsonTreeInspector } from './JsonTreeInspector';
import { JsonScalar } from './JsonScalar';
import { jsonTreeMonoClass } from './jsonTreeClasses';

export type JsonTreeMode = 'inspector' | 'compact';

export interface JsonTreeProps {
  value: unknown;
  mode: JsonTreeMode;
  /** Keep the document root expanded in inspector mode (Files `.json`). */
  pinRootOpen?: boolean;
  className?: string;
}

/**
 * Nession-owned structured JSON primitive — one value, shared by Files and future inspectors (#1199).
 */
export function JsonTree({ value, mode, pinRootOpen = true, className }: JsonTreeProps) {
  if (mode === 'compact') {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return (
        <div className={cn(jsonTreeMonoClass(), className)}>
          <JsonScalar value={value} />
        </div>
      );
    }
    return (
      <div className={cn(jsonTreeMonoClass(), 'min-w-0', className)}>
        <JsonCompactValue value={value} depth={0} />
      </div>
    );
  }

  return <JsonTreeInspector value={value} pinRootOpen={pinRootOpen} className={className} />;
}
