import { useCallback, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { JsonCopyMenu } from './JsonCopyMenu';
import { JsonCompactValue } from './JsonCompactValue';
import { JsonScalar } from './JsonScalar';
import { jsonTreeMonoClass } from './jsonTreeClasses';
import { jsonSyntax } from './jsonTreeSyntax';
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
  propertyKey?: string | number;
}

const rowBaselineClass = cn(
  jsonTreeMonoClass(),
  'flex flex-wrap items-baseline gap-x-1 py-0.5 min-w-0',
);

function isExpandable(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function PropertyKeyLabel({ name }: { name: string | number }) {
  return <span className={cn(jsonSyntax.key, 'shrink-0')}>{JSON.stringify(name)}</span>;
}

function PropertyKeyPrefix({ propertyKey }: { propertyKey?: string | number }) {
  if (propertyKey === undefined) {
    return null;
  }
  return (
    <>
      <PropertyKeyLabel name={propertyKey} />
      <span className={jsonSyntax.punct}>:</span>
    </>
  );
}

function JsonScalarTreeRow({ path, value, propertyKey }: { path: string; value: unknown; propertyKey?: string | number }) {
  const scalar = value as string | number | boolean | null;
  return (
    <JsonCopyMenu path={path} value={value}>
      <div role="treeitem" aria-selected={false} className={rowBaselineClass} tabIndex={-1}>
        <PropertyKeyPrefix propertyKey={propertyKey} />
        <JsonScalar value={scalar} allowExpand />
      </div>
    </JsonCopyMenu>
  );
}

interface ExpandableDisclosureProps {
  path: string;
  value: Record<string, unknown> | unknown[];
  propertyKey?: string | number;
  isArray: boolean;
  open: boolean;
  onToggle: () => void;
}

function JsonExpandableDisclosureRow({
  path,
  value,
  propertyKey,
  isArray,
  open,
  onToggle,
}: ExpandableDisclosureProps) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <JsonCopyMenu path={path} value={value}>
      <div
        role="treeitem"
        aria-expanded={open}
        tabIndex={propertyKey === undefined ? 0 : -1}
        className={cn(
          rowBaselineClass,
          propertyKey === undefined && 'items-start',
          'rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
        onKeyDown={onKeyDown}
      >
        <PropertyKeyPrefix propertyKey={propertyKey} />
        <button
          type="button"
          className="shrink-0 text-muted-foreground hover:text-foreground self-center"
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={onToggle}
        >
          <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        </button>
        {!open ? (
          <JsonCompactValue value={value} depth={0} inline />
        ) : (
          <span className={jsonSyntax.bracket}>{isArray ? '[' : '{'}</span>
        )}
      </div>
    </JsonCopyMenu>
  );
}

function JsonInspectorNode({
  value,
  segments,
  depth,
  pinRootOpen,
  expanded,
  onToggle,
  propertyKey,
}: NodeProps) {
  const path = formatJsonPath(segments);
  const key = pathKey(segments);
  const isRoot = segments.length === 0;
  const open = isRoot && pinRootOpen ? true : expanded.has(key);

  if (!isExpandable(value)) {
    return <JsonScalarTreeRow path={path} value={value} propertyKey={propertyKey} />;
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

  const closingBracket = isArray ? ']' : '}';

  return (
    <div role="none" className={cn('min-w-0', propertyKey !== undefined && 'w-full')}>
      {!isRoot ? (
        <JsonExpandableDisclosureRow
          path={path}
          value={value}
          propertyKey={propertyKey}
          isArray={isArray}
          open={open}
          onToggle={toggle}
        />
      ) : null}
      {open ? (
        <div role="group" className={cn(!isRoot && 'pl-4 border-l border-border/30 ml-1.5')}>
          {isRoot ? (
            <div className={cn(jsonTreeMonoClass(), jsonSyntax.bracket, 'py-0.5')}>
              {isArray ? '[' : '{'}
            </div>
          ) : null}
          {entries.map(([entryKey, child]) => (
            <div key={String(entryKey)} className="min-w-0">
              <JsonInspectorNode
                value={child}
                segments={[...segments, entryKey]}
                depth={depth + 1}
                pinRootOpen={pinRootOpen}
                expanded={expanded}
                onToggle={onToggle}
                propertyKey={isArray ? undefined : entryKey}
              />
            </div>
          ))}
          <div className={cn(jsonTreeMonoClass(), jsonSyntax.bracket, 'py-0.5')}>
            {closingBracket}
          </div>
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
