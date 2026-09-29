import { cn } from '@/shared/lib/utils';
import { JsonScalar } from './JsonScalar';
import { jsonTreeMonoClass } from './jsonTreeClasses';
import {
  COMPACT_MAX_ARRAY_ITEMS,
  COMPACT_MAX_DEPTH,
  COMPACT_MAX_OBJECT_KEYS,
} from './jsonTreeLimits';

interface JsonCompactValueProps {
  value: unknown;
  depth?: number;
  inline?: boolean;
}

function ellipsisSuffix(hidden: number): string {
  return hidden > 0 ? `, … +${hidden}` : '';
}

/** Bounded structural preview — not a clipped full tree (#1199). */
export function JsonCompactValue({ value, depth = 0, inline = false }: JsonCompactValueProps) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return (
      <span className={jsonTreeMonoClass(inline ? 'inline' : undefined)}>
        <JsonScalar value={value} maxChars={undefined} />
      </span>
    );
  }

  if (depth >= COMPACT_MAX_DEPTH) {
    return <span className="text-muted-foreground">{Array.isArray(value) ? '[ … ]' : '{ … }'}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">[]</span>;
    }
    const shown = value.slice(0, COMPACT_MAX_ARRAY_ITEMS);
    const hidden = value.length - shown.length;
    return (
      <span className={cn('min-w-0', inline ? 'inline' : 'block')}>
        <span className="text-muted-foreground">[ </span>
        {shown.map((item, index) => (
          <span key={index} className="inline">
            <JsonCompactValue value={item} depth={depth + 1} inline />
            {index < shown.length - 1 ? <span className="text-muted-foreground">, </span> : null}
          </span>
        ))}
        {hidden > 0 ? <span className="text-muted-foreground">{ellipsisSuffix(hidden)}</span> : null}
        <span className="text-muted-foreground"> ]</span>
      </span>
    );
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) {
      return <span className="text-muted-foreground">{'{}'}</span>;
    }
    const shownKeys = keys.slice(0, COMPACT_MAX_OBJECT_KEYS);
    const hidden = keys.length - shownKeys.length;
    if (inline && depth > 0) {
      return (
        <span className="text-muted-foreground">
          {'{ '}
          {shownKeys.map((key, index) => (
            <span key={key}>
              <span>{JSON.stringify(key)}</span>
              <span>: </span>
              <JsonCompactValue value={record[key]} depth={depth + 1} inline />
              {index < shownKeys.length - 1 ? ', ' : ''}
            </span>
          ))}
          {hidden > 0 ? `, … +${hidden}` : ''}
          {' }'}
        </span>
      );
    }
    return (
      <div className={cn('min-w-0 space-y-0.5 pl-[var(--shell-space-2)] border-l border-border/40', jsonTreeMonoClass())}>
        {shownKeys.map((key) => (
          <div key={key} className="min-w-0">
            <span className="text-muted-foreground">{JSON.stringify(key)}</span>
            <span className="text-muted-foreground">: </span>
            <JsonCompactValue value={record[key]} depth={depth + 1} inline />
          </div>
        ))}
        {hidden > 0 ? (
          <div className="text-muted-foreground text-[length:var(--workspace-editor-action-font-size)]">
            … +{hidden} more fields
          </div>
        ) : null}
      </div>
    );
  }

  return <span className="text-muted-foreground">{String(value)}</span>;
}
