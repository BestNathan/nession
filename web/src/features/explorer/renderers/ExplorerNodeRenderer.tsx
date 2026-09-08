import type { CSSProperties, ReactNode } from 'react';
import { Folder, File } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { formatRelativeTimeSeconds, formatSize } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { ResolvedDecorations } from '../decorations/resolveDecorations';
import type { ExplorerNode } from '../types';

export interface ExplorerNodeRendererProps {
  node: ExplorerNode;
  style: CSSProperties;
  dragHandle?: (el: HTMLDivElement | null) => void;
  decorations: ResolvedDecorations;
  contextMenuItems: ReactNode[];
  isRenaming?: boolean;
  renameValue?: string;
  onRenameSubmit?: () => void;
  onRenameCancel?: () => void;
  onRenameChange?: (value: string) => void;
  onActivate: () => void;
}

function NodeIcon({ node }: { node: ExplorerNode }) {
  if (node.kind === 'directory') {
    return <Folder className="h-3.5 w-3.5 mr-1.5 text-info flex-shrink-0" />;
  }

  return <File className="h-3.5 w-3.5 mr-1.5 text-muted-foreground flex-shrink-0" />;
}

function ExplorerNodeRenameRow({
  node,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
}: Pick<
  ExplorerNodeRendererProps,
  'node' | 'renameValue' | 'onRenameChange' | 'onRenameSubmit' | 'onRenameCancel'
>) {
  return (
    <div className="flex items-center gap-1 w-full px-2 py-0.5">
      <NodeIcon node={node} />
      <Input
        autoFocus
        value={renameValue ?? ''}
        onChange={(e) => onRenameChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onRenameSubmit?.();
          }
          if (e.key === 'Escape') {
            onRenameCancel?.();
          }
        }}
        className="h-6 text-xs flex-1"
      />
      <Button size="sm" className="h-6 text-xs" onClick={() => onRenameSubmit?.()}>
        Rename
      </Button>
      <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => onRenameCancel?.()}>
        Cancel
      </Button>
    </div>
  );
}

export function ExplorerNodeRenderer({
  node,
  style,
  dragHandle,
  decorations,
  contextMenuItems,
  isRenaming = false,
  renameValue,
  onRenameSubmit,
  onRenameCancel,
  onRenameChange,
  onActivate,
}: ExplorerNodeRendererProps) {
  const size = node.metadata?.size;
  const modifiedAt = node.metadata?.modifiedAt;
  const isBinary = node.metadata?.isBinary ?? false;

  if (isRenaming) {
    return (
      <div ref={dragHandle} style={style}>
        <ExplorerNodeRenameRow
          node={node}
          renameValue={renameValue}
          onRenameChange={onRenameChange}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
        />
      </div>
    );
  }

  return (
    <div ref={dragHandle} style={style}>
      <ContextMenu>
        <ContextMenuTrigger
          onClick={() => onActivate()}
          title={decorations.tooltip}
          className={cn(
            'flex items-center w-full px-2 py-0.5 text-xs hover:bg-accent transition-colors text-left cursor-default',
            decorations.className,
          )}
        >
          <NodeIcon node={node} />
          <span className="flex-1 truncate min-w-0">{node.name}</span>
          {decorations.icons.map((icon, index) => (
            <span key={index} className="mr-1 flex-shrink-0">
              {icon}
            </span>
          ))}
          {decorations.badge !== undefined && (
            <span className="px-1 rounded bg-muted text-muted-foreground text-[9px] leading-tight mr-1 flex-shrink-0">
              {decorations.badge}
            </span>
          )}
          {isBinary && node.kind === 'file' && (
            <span className="px-1 rounded bg-muted text-muted-foreground text-[9px] leading-tight mr-1 flex-shrink-0">
              BIN
            </span>
          )}
          <span className="w-[72px] text-right text-muted-foreground flex-shrink-0 text-nowrap">
            {node.kind === 'directory' ? '' : formatSize(size ?? 0)}
          </span>
          <span className="w-[72px] text-right text-muted-foreground flex-shrink-0 text-nowrap">
            {formatRelativeTimeSeconds(modifiedAt ?? 0)}
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-36">
          {contextMenuItems}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
