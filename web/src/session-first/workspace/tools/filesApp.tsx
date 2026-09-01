import { useState } from 'react';
import { FileBrowser } from '@/components/FileBrowser';
import { FileViewer } from '@/components/FileViewer';
import type { FileEntry } from '@/services/fileOps';
import type { WorkspaceContext } from '../toolTypes';

interface SelectedFile { path: string; filename: string; size: number; }

/** App layout: tree full-screen, editor pushed on select (2C refines this). */
export function FilesAppLayout({ ctx }: { ctx: WorkspaceContext }) {
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  if (!ctx.fileOps) {
    return null;
  }
  if (selected) {
    return (
      <FileViewer key={selected.path} fileOps={ctx.fileOps} path={selected.path} filename={selected.filename} fileSize={selected.size} onClose={() => setSelected(null)} />
    );
  }
  return (
    <div className="h-full min-h-0 overflow-hidden" data-testid="files-app-layout">
      <FileBrowser fileOps={ctx.fileOps} onFileClick={(entry: FileEntry) => setSelected({ path: entry.path, filename: entry.name, size: entry.size })} />
    </div>
  );
}
