import { useCallback, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { JsonCopyMenu } from './JsonCopyMenu';
import { JsonCompactValue } from './JsonCompactValue';
import { JsonScalar } from './JsonScalar';
import { jsonTreeMonoClass } from './jsonTreeClasses';
import { jsonSyntax } from './jsonTreeSyntax';
import {
  jsonKvRowGridClass,
  jsonKvValueCellClass,
  jsonTreeNestedBodyIndentClass,
  jsonTreeRootBodyIndentClass,
} from './jsonTreeRowLayout';
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

function isExpandable(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function PropertyKeyLabel({ name }: { name: string | number }) {
  return <span className={cn(jsonSyntax.key, 'whitespace-nowrap')}>{JSON.stringify(name)}</span>;
}

function JsonKeyValueCells({ propertyKey }: { propertyKey?: string | number }) {
  if (propertyKey === undefined) {
    return (
      <>
        <span aria-hidden />
        <span aria-hidden />
      </>
    );
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
      <div role="treeitem" aria-selected={false} className={jsonKvRowGridClass} tabIndex={-1}>
        <JsonKeyValueCells propertyKey={propertyKey} />
        <div className={jsonKvValueCellClass}>
          <JsonScalar value={scalar} allowExpand />
        </div>
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
          jsonKvRowGridClass,
          'rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
        onKeyDown={onKeyDown}
      >
        <JsonKeyValueCells propertyKey={propertyKey} />
        <div className={cn(jsonKvValueCellClass, 'flex flex-wrap items-baseline gap-x-1')}>
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
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
        <>
          {isRoot ? (
            <div className={cn(jsonTreeMonoClass(), jsonSyntax.bracket, 'py-0.5')}>
              {isArray ? '[' : '{'}
            </div>
          ) : null}
          <div
            role="group"
            className={cn(isRoot ? jsonTreeRootBodyIndentClass : jsonTreeNestedBodyIndentClass)}
          >
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
            {!isRoot ? (
              <div className={cn(jsonTreeMonoClass(), jsonSyntax.bracket, 'py-0.5')}>
                {closingBracket}
              </div>
            ) : null}
          </div>
          {isRoot ? (
            <div className={cn(jsonTreeMonoClass(), jsonSyntax.bracket, 'py-0.5')}>
              {closingBracket}
            </div>
          ) : null}
        </>
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
