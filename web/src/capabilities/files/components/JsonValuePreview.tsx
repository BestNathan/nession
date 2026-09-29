import { Fragment } from 'react';
import { cn } from '@/shared/lib/utils';

const INDENT = '  ';

function formatString(value: string): string {
  return JSON.stringify(value);
}

interface JsonValuePreviewProps {
  value: unknown;
  depth?: number;
  className?: string;
}

function Scalar({ value }: { value: string | number | boolean | null }) {
  if (value === null) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-muted-foreground">{value ? 'true' : 'false'}</span>;
  }
  if (typeof value === 'number') {
    return <span className="tabular-nums text-foreground">{String(value)}</span>;
  }
  return (
    <span className="break-words text-foreground">{formatString(value)}</span>
  );
}

function ObjectPreview({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return <span className="text-muted-foreground">{'{}'}</span>;
  }
  const pad = INDENT.repeat(depth);
  const inner = INDENT.repeat(depth + 1);
  return (
    <span className="block min-w-0">
      <span className="text-muted-foreground">{'{'}</span>
      {keys.map((key, index) => (
        <Fragment key={key}>
          {'\n'}
          {inner}
          <span className="text-muted-foreground">{formatString(key)}</span>
          <span className="text-muted-foreground">: </span>
          <JsonValuePreview value={value[key]} depth={depth + 1} className="inline" />
          {index < keys.length - 1 ? <span className="text-muted-foreground">,</span> : null}
        </Fragment>
      ))}
      {'\n'}
      {pad}
      <span className="text-muted-foreground">{'}'}</span>
    </span>
  );
}

function ArrayPreview({ value, depth }: { value: unknown[]; depth: number }) {
  if (value.length === 0) {
    return <span className="text-muted-foreground">{'[]'}</span>;
  }
  const pad = INDENT.repeat(depth);
  const inner = INDENT.repeat(depth + 1);
  return (
    <span className="block min-w-0">
      <span className="text-muted-foreground">{'['}</span>
      {value.map((item, index) => (
        <Fragment key={index}>
          {'\n'}
          {inner}
          <JsonValuePreview value={item} depth={depth + 1} className="inline" />
          {index < value.length - 1 ? <span className="text-muted-foreground">,</span> : null}
        </Fragment>
      ))}
      {'\n'}
      {pad}
      <span className="text-muted-foreground">{']'}</span>
    </span>
  );
}

/** Shared structured JSON grammar for `.json` and JSONL records (#1199). */
export function JsonValuePreview({ value, depth = 0, className }: JsonValuePreviewProps) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return (
      <span className={cn('font-mono text-[length:var(--workspace-editor-font-size)] leading-[var(--workspace-editor-line-height)]', className)}>
        <Scalar value={value} />
      </span>
    );
  }
  if (Array.isArray(value)) {
    return (
      <pre
        className={cn(
          'font-mono whitespace-pre-wrap break-words min-w-0 max-w-full text-[length:var(--workspace-editor-font-size)] leading-[var(--workspace-editor-line-height)]',
          className,
        )}
      >
        <ArrayPreview value={value} depth={depth} />
      </pre>
    );
  }
  if (typeof value === 'object') {
    return (
      <pre
        className={cn(
          'font-mono whitespace-pre-wrap break-words min-w-0 max-w-full text-[length:var(--workspace-editor-font-size)] leading-[var(--workspace-editor-line-height)]',
          className,
        )}
      >
        <ObjectPreview value={value as Record<string, unknown>} depth={depth} />
      </pre>
    );
  }
  return (
    <span className={cn('font-mono text-muted-foreground', className)}>
      {String(value)}
    </span>
  );
}
