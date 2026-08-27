import { useEffect, useState } from 'react';
import { FileBrowser } from '@/components/FileBrowser';
import { FileViewer } from '@/components/FileViewer';
import type { FileEntry, FileOps } from '@/services/fileOps';

export interface FileWorkspaceProps {
  fileOps: FileOps | null;
}

interface SelectedFile {
  path: string;
  filename: string;
  size: number;
}

export function FileWorkspace({ fileOps }: FileWorkspaceProps) {
  const [selected, setSelected] = useState<SelectedFile | null>(null);

  useEffect(() => {
    setSelected(null);
  }, [fileOps]);

  if (!fileOps) {
    return (
      <div
        data-testid="file-workspace"
        className="flex h-full min-h-0 items-center justify-center overflow-hidden p-4 text-sm text-muted-foreground"
      >
        Attach first to browse files
      </div>
    );
  }

  return (
    <div
      data-testid="file-workspace"
      className="grid h-full min-h-0 grid-cols-2 overflow-hidden"
    >
      <div className="h-full min-h-0 overflow-hidden">
        <FileBrowser
          fileOps={fileOps}
          onFileClick={(entry: FileEntry) => {
            setSelected({
              path: entry.path,
              filename: entry.name,
              size: entry.size,
            });
          }}
        />
      </div>
      <div className="h-full min-h-0 overflow-hidden">
        {selected ? (
          <FileViewer
            key={selected.path}
            fileOps={fileOps}
            path={selected.path}
            filename={selected.filename}
            fileSize={selected.size}
            onClose={() => setSelected(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a file
          </div>
        )}
      </div>
    </div>
  );
}
