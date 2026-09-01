import { useEffect, useState } from 'react';
import { FileBrowser } from '@/components/FileBrowser';
import { FileViewer } from '@/components/FileViewer';
import type { FileEntry } from '@/services/fileOps';
import type { WorkspaceContext } from '../toolTypes';

interface SelectedFile { path: string; filename: string; size: number; }

/** Web layout: tree ‖ editor on a CSS grid — proportions, no fixed px. */
export function FilesWebLayout({ ctx }: { ctx: WorkspaceContext }) {
  const [selected, setSelected] = useState<SelectedFile | null>(null);

  // Reset the viewer when the transport changes (detach/reattach or session
  // switch) so a stale file view from a previous session never reappears.
  useEffect(() => {
    setSelected(null);
  }, [ctx.fileOps]);

  if (!ctx.fileOps) {
    return null;
  }
  return (
    <div data-testid="file-workspace" className="h-full min-h-0 overflow-hidden">
      <div data-testid="files-web-layout" className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] overflow-hidden">
        <div className="min-h-0 overflow-hidden border-r border-border/60">
          <FileBrowser
            fileOps={ctx.fileOps}
            onFileClick={(entry: FileEntry) => setSelected({ path: entry.path, filename: entry.name, size: entry.size })}
          />
        </div>
        <div className="min-h-0 overflow-hidden">
          {selected ? (
            <FileViewer key={selected.path} fileOps={ctx.fileOps} path={selected.path} filename={selected.filename} fileSize={selected.size} onClose={() => setSelected(null)} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file</div>
          )}
        </div>
      </div>
    </div>
  );
}
