import { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FileBrowser } from '@/components/FileBrowser';
import { FileViewer } from '@/components/FileViewer';
import type { FileEntry } from '@/services/fileOps';
import type { WorkspaceContext } from '../toolTypes';

interface SelectedFile { path: string; filename: string; size: number; }

/** App layout: tree full-screen → push editor with a sub-header (← + path). */
export function FilesAppLayout({ ctx }: { ctx: WorkspaceContext }) {
  const [selected, setSelected] = useState<SelectedFile | null>(null);

  // Reset the viewer when the transport changes (detach/reattach or session
  // switch) so a stale file view from a previous session never reappears.
  useEffect(() => {
    setSelected(null);
  }, [ctx.fileOps]);

  if (!ctx.fileOps) {
    return null;
  }
  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div
          data-testid="files-app-nav"
          className="flex shrink-0 items-center gap-1 px-[var(--sf-space-2)] pt-[max(var(--sf-space-1),env(safe-area-inset-top))]"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]"
            aria-label="Back to files"
            data-testid="files-app-back"
            onClick={() => setSelected(null)}
          >
            <ChevronLeft className="size-5" />
          </Button>
          <span className="min-w-0 truncate font-mono text-sm">{selected.filename}</span>
        </div>
        <div className="min-h-0 flex-1">
          <FileViewer
            key={selected.path}
            fileOps={ctx.fileOps}
            path={selected.path}
            filename={selected.filename}
            fileSize={selected.size}
            onClose={() => setSelected(null)}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-hidden" data-testid="files-app-layout">
      <FileBrowser
        fileOps={ctx.fileOps}
        onFileClick={(entry: FileEntry) =>
          setSelected({ path: entry.path, filename: entry.name, size: entry.size })
        }
      />
    </div>
  );
}
