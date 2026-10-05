import { useMemo } from 'react';
import { JsonTree } from '@/components/json/JsonTree';
import { jsonPreviewSurfaceClass } from '@/components/json/jsonTreeSyntax';
import { parseJsonDocument } from '../model/jsonParse';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';

interface JsonPreviewProps {
  content: string;
}

export function JsonPreview({ content }: JsonPreviewProps) {
  const parsed = useMemo(() => parseJsonDocument(content), [content]);

  if (!parsed.ok) {
    return (
      <div
        className={cn(
          'flex flex-col gap-2 p-[var(--nession-workspace-editor-pad-y)] px-[var(--nession-workspace-editor-head-pad-x)]',
          chromeSansRole('secondary'),
        )}
        role="alert"
      >
        <p className={cn('text-foreground', chromeSansRole('secondary'))}>Invalid JSON</p>
        <p className="text-muted-foreground font-mono text-[length:var(--nession-workspace-editor-font-size)]">{parsed.message}</p>
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>Switch to Raw to view or edit the source.</p>
      </div>
    );
  }

  return (
    <div className={cn('overflow-y-auto h-full p-[var(--nession-workspace-editor-pad-y)] px-[var(--nession-workspace-editor-head-pad-x)] min-w-0', workspaceScrollClearanceClass)}>
      <div className={jsonPreviewSurfaceClass('py-[var(--nession-shell-space-2)]')}>
        <JsonTree value={parsed.value} mode="inspector" pinRootOpen />
      </div>
    </div>
  );
}
