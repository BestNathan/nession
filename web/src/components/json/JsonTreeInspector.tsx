import { useCallback, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { JsonCopyMenu } from './JsonCopyMenu';
import { JsonCompactValue } from './JsonCompactValue';
import { JsonScalar } from './JsonScalar';
import { jsonTreeMonoClass } from './jsonTreeClasses';
import { formatJsonPath, pathKey } from './jsonPath';

interface JsonTreeInspectorProps {
  value: unknown;
  pinRootOpen?: boolean;
  className?: string;
}

interface NodeProps {
  value: unknown;
  segments: Array<string | number>;
  depth: number;
  pinRootOpen: boolean;
  expanded: Set<string>;
  onToggle: (key: string) => void;
}

function isExpandable(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function JsonInspectorNode({ value, segments, depth, pinRootOpen, expanded, onToggle }: NodeProps) {
  const path = formatJsonPath(segments);
  const key = pathKey(segments);
  const isRoot = segments.length === 0;
  const open = isRoot && pinRootOpen ? true : expanded.has(key);

  if (!isExpandable(value)) {
    const scalar = value as string | number | boolean | null;
    return (
      <JsonCopyMenu path={path} value={value}>
        <div
          role="treeitem"
          aria-selected={false}
          className={cn(jsonTreeMonoClass(), 'py-0.5 min-w-0')}
          tabIndex={-1}
        >
          <JsonScalar value={scalar} allowExpand />
        </div>
      </JsonCopyMenu>
    );
  }

  const isArray = Array.isArray(value);
  const entries: Array<[string | number, unknown]> = isArray
    ? value.map((item, index) => [index, item] as const)
    : Object.entries(value as Record<string, unknown>);

  const toggle = () => {
    if (isRoot && pinRootOpen) {
      return;
    }
    onToggle(key);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <div role="none" className="min-w-0">
      {!isRoot ? (
        <JsonCopyMenu path={path} value={value}>
          <div
            role="treeitem"
            aria-expanded={open}
            tabIndex={0}
            className={cn(
              jsonTreeMonoClass(),
              'flex items-start gap-1 py-0.5 min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
            onKeyDown={onKeyDown}
          >
            <button
              type="button"
              className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={open ? 'Collapse' : 'Expand'}
              onClick={toggle}
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
            </button>
            <div className="min-w-0 flex-1">
              {!open ? (
                <JsonCompactValue value={value} depth={0} inline />
              ) : (
                <span className="text-muted-foreground">{isArray ? '[' : '{'}</span>
              )}
            </div>
          </div>
        </JsonCopyMenu>
      ) : null}
      {open ? (
        <div role="group" className={cn(!isRoot && 'pl-4 border-l border-border/30 ml-1.5')}>
          {entries.map(([entryKey, child]) => (
            <div key={String(entryKey)} className="min-w-0">
              {!isArray ? (
                <div className={cn(jsonTreeMonoClass(), 'text-muted-foreground py-0.5')}>
                  {JSON.stringify(entryKey)}
                  <span className="text-muted-foreground">: </span>
                </div>
              ) : null}
              <JsonInspectorNode
                value={child}
                segments={[...segments, entryKey]}
                depth={depth + 1}
                pinRootOpen={pinRootOpen}
                expanded={expanded}
                onToggle={onToggle}
              />
            </div>
          ))}
          {!isRoot ? (
            <div className={cn(jsonTreeMonoClass(), 'text-muted-foreground py-0.5')}>
              {isArray ? ']' : '}'}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Interactive read-only JSON tree for Files `.json` preview (#1199). */
export function JsonTreeInspector({ value, pinRootOpen = true, className }: JsonTreeInspectorProps) {
  const treeId = useId();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const onToggle = useCallback((nodeKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeKey)) {
        next.delete(nodeKey);
      } else {
        next.add(nodeKey);
      }
      return next;
    });
  }, []);

  const rootSegments = useMemo(() => [] as Array<string | number>, []);

  return (
    <div
      id={treeId}
      role="tree"
      aria-labelledby={treeId}
      className={cn('min-w-0 overflow-x-auto', className)}
    >
      <JsonInspectorNode
        value={value}
        segments={rootSegments}
        depth={0}
        pinRootOpen={pinRootOpen}
        expanded={expanded}
        onToggle={onToggle}
      />
    </div>
  );
}
