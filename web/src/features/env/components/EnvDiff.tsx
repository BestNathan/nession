import { useMemo } from 'react';
import { cn } from '@/lib/utils';

interface EnvDiffProps {
  original: string;
  modified: string;
}

interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  content: string;
}

function computeDiff(original: string, modified: string): DiffLine[] {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const m = origLines.length;
  const n = modLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origLines[i - 1] === modLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  const stack: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === modLines[j - 1]) {
      stack.push({ type: 'unchanged', content: origLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'added', content: modLines[j - 1] });
      j--;
    } else {
      stack.push({ type: 'removed', content: origLines[i - 1] });
      i--;
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    result.push(stack[k]);
  }
  return result;
}

export function EnvDiff({ original, modified }: EnvDiffProps) {
  const diff = useMemo(() => computeDiff(original, modified), [original, modified]);

  if (original === modified) {
    return (
      <p className="text-xs text-muted-foreground text-center py-2">No changes detected</p>
    );
  }

  return (
    <div className="rounded-md border divide-y divide-border font-mono text-xs max-h-48 overflow-y-auto">
      {diff.map((line, i) => (
        <div
          key={i}
          className={cn(
            'flex px-2 py-0.5',
            line.type === 'added' && 'bg-file-created/10 text-file-created',
            line.type === 'removed' && 'bg-file-deleted/10 text-file-deleted',
            line.type === 'unchanged' && 'text-muted-foreground',
          )}
        >
          <span className="w-5 flex-shrink-0 text-muted-foreground select-none">
            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
          </span>
          <span className="whitespace-pre-wrap break-all">{line.content}</span>
        </div>
      ))}
    </div>
  );
}
