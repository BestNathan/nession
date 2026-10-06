import { useState } from 'react';
import { cn } from '@/shared/lib/utils';
import { COMPACT_STRING_CHARS, TREE_STRING_PREVIEW_CHARS, TREE_STRING_EXPAND_CHARS } from './jsonTreeLimits';
import { jsonSyntax } from './jsonTreeSyntax';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

interface JsonScalarProps {
  value: string | number | boolean | null;
  /** Inspector rows may expand long strings; compact mode stays line-bounded. */
  allowExpand?: boolean;
  maxChars?: number;
}

export function JsonScalar({ value, allowExpand = false, maxChars }: JsonScalarProps) {
  const [expanded, setExpanded] = useState(false);

  if (value === null) {
    return <span className={jsonSyntax.literal}>null</span>;
  }
  if (typeof value === 'boolean') {
    return <span className={jsonSyntax.literal}>{value ? 'true' : 'false'}</span>;
  }
  if (typeof value === 'number') {
    return <span className={jsonSyntax.number}>{String(value)}</span>;
  }

  const limit = maxChars ?? (allowExpand ? TREE_STRING_PREVIEW_CHARS : COMPACT_STRING_CHARS);
  const truncated = value.length > limit;
  const body = expanded
    ? value.slice(0, TREE_STRING_EXPAND_CHARS)
    : (truncated ? `${value.slice(0, limit)}…` : value);
  const showExpandControl = allowExpand && truncated;
  const display = JSON.stringify(body);

  return (
    <span className={cn('break-words min-w-0', jsonSyntax.string)}>
      {display}
      {showExpandControl ? (
        <button
          type="button"
          className="ml-1 text-[length:var(--nession-workspace-editor-action-font-size)] text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      ) : null}
      {expanded && value.length > TREE_STRING_EXPAND_CHARS ? (
        <span className={cn('mt-0.5 block text-muted-foreground', chromeSansRole('caption'))}>Truncated for display</span>
      ) : null}
    </span>
  );
}
