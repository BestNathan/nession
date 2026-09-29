import { useState } from 'react';
import { COMPACT_STRING_CHARS, TREE_STRING_PREVIEW_CHARS, TREE_STRING_EXPAND_CHARS } from './jsonTreeLimits';

interface JsonScalarProps {
  value: string | number | boolean | null;
  /** Inspector rows may expand long strings; compact mode stays line-bounded. */
  allowExpand?: boolean;
  maxChars?: number;
}

export function JsonScalar({ value, allowExpand = false, maxChars }: JsonScalarProps) {
  const [expanded, setExpanded] = useState(false);

  if (value === null) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-muted-foreground">{value ? 'true' : 'false'}</span>;
  }
  if (typeof value === 'number') {
    return <span className="tabular-nums text-foreground">{String(value)}</span>;
  }

  const limit = maxChars ?? (allowExpand ? TREE_STRING_PREVIEW_CHARS : COMPACT_STRING_CHARS);
  const needsExpand = allowExpand && value.length > limit;
  const body = expanded
    ? value.slice(0, TREE_STRING_EXPAND_CHARS)
    : (needsExpand ? `${value.slice(0, limit)}…` : value);
  const display = JSON.stringify(body);

  return (
    <span className="break-words text-foreground min-w-0">
      {display}
      {needsExpand ? (
        <button
          type="button"
          className="ml-1 text-[length:var(--workspace-editor-action-font-size)] text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      ) : null}
      {expanded && value.length > TREE_STRING_EXPAND_CHARS ? (
        <span className="block text-muted-foreground text-[10px] mt-0.5">Truncated for display</span>
      ) : null}
    </span>
  );
}
