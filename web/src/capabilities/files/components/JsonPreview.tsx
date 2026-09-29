import { useMemo } from 'react';
import { JsonTree } from '@/components/json/JsonTree';
import { jsonPreviewSurfaceClass } from '@/components/json/jsonTreeSyntax';
import { parseJsonDocument } from '../model/jsonParse';

interface JsonPreviewProps {
  content: string;
}

export function JsonPreview({ content }: JsonPreviewProps) {
  const parsed = useMemo(() => parseJsonDocument(content), [content]);

  if (!parsed.ok) {
    return (
      <div
        className="flex flex-col gap-2 p-[var(--workspace-editor-pad-y)] px-[var(--workspace-editor-head-pad-x)] text-sm"
        role="alert"
      >
        <p className="font-medium text-foreground">Invalid JSON</p>
        <p className="text-muted-foreground font-mono text-[length:var(--workspace-editor-font-size)]">{parsed.message}</p>
        <p className="text-muted-foreground text-xs">Switch to Raw to view or edit the source.</p>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full p-[var(--workspace-editor-pad-y)] px-[var(--workspace-editor-head-pad-x)] min-w-0">
      <div className={jsonPreviewSurfaceClass('py-[var(--shell-space-2)]')}>
        <JsonTree value={parsed.value} mode="inspector" pinRootOpen />
      </div>
    </div>
  );
}
