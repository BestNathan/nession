import { useEffect, useState } from 'react';
import { FileBrowser } from '@/capabilities/files/components/FileBrowser';
import { FileViewer } from '@/capabilities/files/components/FileViewer';
import type { FileEntry } from '@/capabilities/files';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';

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
      {/* A fixed navigation column and a fluid editor, not two fractions. The
          mockup draws the tree at 208px because it is sized to its content —
          paths — and a `1fr 2fr` split hands it a third of the pane whatever it
          holds. No border either: the tree carries `workspace.navigation` (the
          chrome surface) and the editor keeps the canvas, so the background
          shift is the separator, as in the shell (visual-language.md P7). */}
      <div
        data-testid="files-web-layout"
        className="grid h-full min-h-0 grid-cols-[var(--workspace-tree-width)_minmax(0,1fr)] overflow-hidden"
      >
        <div className="bg-workspace-navigation min-h-0 overflow-hidden">
          <FileBrowser
            fileOps={ctx.fileOps}
            onFileClick={(entry: FileEntry) => setSelected({ path: entry.path, filename: entry.name, size: entry.size })}
          />
        </div>
        <div className="min-h-0 overflow-hidden">
          {selected ? (
            <FileViewer key={selected.path} fileOps={ctx.fileOps} path={selected.path} filename={selected.filename} fileSize={selected.size} onClose={() => setSelected(null)} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file to view it.</div>
          )}
        </div>
      </div>
    </div>
  );
}
