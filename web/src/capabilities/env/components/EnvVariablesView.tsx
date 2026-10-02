import { useMemo, useState } from 'react';
import { Copy, Eye, EyeOff, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MASKED_VALUE, isSensitiveKey } from '@/capabilities/env/model/sensitive';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';

/** Below this count a filter field would be chrome in search of a problem. */
const SEARCH_THRESHOLD = 6;

async function copyValue(key: string, value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`Copied ${key}`);
  } catch {
    toast.error('Copy failed — the browser denied clipboard access');
  }
}

function VariableRow({
  entry: [key, value],
  masked,
  onToggleMask,
}: {
  entry: [string, string];
  masked: boolean;
  onToggleMask: () => void;
}) {
  const empty = value === '';
  return (
    <div
      data-testid={`env-var-row-${key}`}
      className="flex items-start gap-2 px-3 py-1.5"
    >
      <span className={cn('min-w-0 flex-[2] truncate pt-0.5 font-mono text-foreground', chromeMonoRole('code'))}>
        {key}
      </span>
      <span className={cn('min-w-0 flex-[3] break-all pt-0.5 font-mono', chromeMonoRole('code'))}>
        {empty ? (
          <span className="italic text-muted-foreground">(empty)</span>
        ) : masked ? (
          <span className="select-none text-muted-foreground" data-testid={`env-var-masked-${key}`}>
            {MASKED_VALUE}
          </span>
        ) : (
          <span className="text-foreground/90">{value}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center">
        {isSensitiveKey(key) && !empty ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={masked ? `Reveal ${key}` : `Hide ${key}`}
            data-testid={`env-var-reveal-${key}`}
            onClick={onToggleMask}
          >
            {masked ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          </Button>
        ) : null}
        {!empty ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Copy ${key}`}
            data-testid={`env-var-copy-${key}`}
            onClick={() => void copyValue(key, value)}
          >
            <Copy className="size-3.5" />
          </Button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The read-first Variables view (#1202): key/value in mono, sensitive-looking
 * values masked by default, per-row ephemeral reveal, and copy that always
 * carries the real value — pressing Copy is the explicit act; a masked value
 * never turns into bullets on the clipboard.
 */
export function EnvVariablesView({
  vars,
  warnings,
}: {
  vars: [string, string][];
  warnings: string[];
}) {
  const [query, setQuery] = useState('');
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return vars;
    }
    return vars.filter(
      ([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q),
    );
  }, [vars, query]);

  const sensitiveKeys = useMemo(
    () => vars.filter(([k, v]) => isSensitiveKey(k) && v !== '').map(([k]) => k),
    [vars],
  );
  const allRevealed = sensitiveKeys.every((k) => revealed.has(k));

  const toggle = (key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="env-variables">
      {vars.length >= SEARCH_THRESHOLD ? (
        <div className="border-b p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              data-testid="env-var-search"
              placeholder="Filter variables…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
            />
          </div>
        </div>
      ) : null}

      {sensitiveKeys.length > 0 && !allRevealed ? (
        <div className="flex justify-end border-b px-3 py-1">
          <button
            type="button"
            data-testid="env-reveal-all"
            className={cn('text-muted-foreground underline-offset-2 hover:text-foreground hover:underline', chromeSansRole('metadata'))}
            onClick={() => setRevealed(new Set(sensitiveKeys))}
          >
            Reveal sensitive values
          </button>
        </div>
      ) : null}

      <div className={cn('min-h-0 flex-1 overflow-y-auto', workspaceScrollClearanceClass)}>
        {filtered.length === 0 ? (
          <p className={cn('px-4 py-8 text-center text-muted-foreground', chromeSansRole('secondary'))}>
            No variables match &ldquo;{query.trim()}&rdquo;
          </p>
        ) : (
          <div className="divide-y divide-border/60 py-1">
            {filtered.map((entry) => (
              <VariableRow
                key={entry[0]}
                entry={entry}
                masked={isSensitiveKey(entry[0]) && !revealed.has(entry[0])}
                onToggleMask={() => toggle(entry[0])}
              />
            ))}
          </div>
        )}
      </div>

      {warnings.length > 0 ? (
        <div className="border-t px-3 py-2" data-testid="env-var-warnings">
          <p className={cn('text-warning', chromeSansRole('metadata'))}>
            {warnings.length === 1 ? '1 line skipped' : `${warnings.length} lines skipped`}
          </p>
          {warnings.map((w, i) => (
            <p key={i} className={cn('mt-0.5 font-mono text-muted-foreground', chromeMonoRole('code'))}>
              {w}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
