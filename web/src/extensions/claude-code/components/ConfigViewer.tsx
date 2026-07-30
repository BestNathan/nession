import { useState, useCallback } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { ConfigCategory, ConfigFile, ClaudeCodeReadResponse } from '../types';
import type { ClaudeCodeService } from '../services/claudeCodeService';

interface ConfigViewerProps {
  open: boolean;
  onClose: () => void;
  categories: ConfigCategory[];
  service: ClaudeCodeService;
  agentId: string;
  scope: 'global' | 'project';
  sessionId?: string;
}

export function ConfigViewer({
  open, onClose, categories, service, agentId, scope, sessionId,
}: ConfigViewerProps) {
  const [selectedFile, setSelectedFile] = useState<ConfigFile | null>(null);
  const [content, setContent] = useState('');
  const [contentType, setContentType] = useState('text');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [totalSize, setTotalSize] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const handleFileClick = useCallback(async (file: ConfigFile) => {
    setSelectedFile(file);
    setLoading(true);
    setError(null);
    setOffset(0);
    try {
      const resp: ClaudeCodeReadResponse = await service.read({
        agent_id: agentId, scope, session_id: sessionId, path: file.path, offset: 0,
      });
      if (resp.error) {
        setError(resp.error);
        setContent('');
      } else {
        setContent(resp.content);
        setContentType(resp.content_type);
        setTotalSize(resp.total_size);
        setHasMore(resp.has_more);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [service, agentId, scope, sessionId]);

  const handleNextPage = useCallback(async () => {
    if (!selectedFile || !hasMore) {
      return;
    }
    setLoading(true);
    const newOffset = offset + content.length;
    try {
      const resp = await service.read({
        agent_id: agentId, scope, session_id: sessionId, path: selectedFile.path, offset: newOffset,
      });
      if (!resp.error) {
        setContent(prev => prev + resp.content);
        setOffset(newOffset);
        setHasMore(resp.has_more);
      }
    } catch {
      /* keep existing content */
    } finally {
      setLoading(false);
    }
  }, [selectedFile, hasMore, offset, content.length, service, agentId, scope, sessionId]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1048576) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
  };

  return (
    <Sheet open={open} onOpenChange={(isOpen) => { if (!isOpen) { onClose(); } }}>
      <SheetContent side="right" className="w-full sm:w-[500px] md:w-[600px] max-w-[100vw] p-0 flex flex-col">
        <div className="p-4 border-b flex items-center gap-2 flex-shrink-0">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">Claude Code Config</h3>
          <span className="text-xs text-muted-foreground capitalize">{scope}</span>
        </div>
        <div className="flex-1 min-h-0 flex">
          <div className="w-[200px] border-r overflow-y-auto flex-shrink-0">
            {categories.map((cat) => (
              <div key={cat.name}>
                <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{cat.name}</div>
                {cat.files.map((file) => (
                  <button key={file.path} onClick={() => handleFileClick(file)}
                    className={cn('w-full text-left px-3 py-1 text-xs hover:bg-accent transition-colors flex items-center gap-1.5',
                      selectedFile?.path === file.path && 'bg-accent text-accent-foreground')}>
                    <FileText className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{file.path.split('/').pop()}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="flex-1 min-w-0 overflow-auto p-3">
            {!selectedFile && <p className="text-sm text-muted-foreground p-4">Select a file to view its content.</p>}
            {loading && <p className="text-sm text-muted-foreground p-4">Loading...</p>}
            {error && <p className="text-sm text-destructive p-3">Error: {error}</p>}
            {selectedFile && !loading && !error && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">{selectedFile.path} ({formatSize(totalSize)})</span>
                  {hasMore && <Button variant="outline" size="sm" onClick={handleNextPage}>Load more</Button>}
                </div>
                <Separator className="mb-2" />
                <pre className={cn('text-xs whitespace-pre-wrap font-mono', contentType === 'json' && 'text-amber-400')}>
                  {content || '(empty)'}
                </pre>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
