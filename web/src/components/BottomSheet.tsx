import { Keyboard, Zap, Package, FolderTree, ChevronDown, ChevronUp, Minus, Plus as PlusIcon, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import type { FontSizeManager } from '@/terminal/FontSizeManager';

export type BottomTab = 'input' | 'commands' | 'env' | 'files';

interface BottomSheetProps {
  activeTab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  showFilesTab: boolean;
  fontSizeManager: FontSizeManager | null;
  inputPanel: React.ReactNode;
  commandsPanel: React.ReactNode;
  envPanel: React.ReactNode;
  filesPanel?: React.ReactNode;
}

function ZoomControls({ fontSizeManager }: { fontSizeManager: FontSizeManager }) {
  const [size, setSize] = useState(() => fontSizeManager.getSize());

  return (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => { fontSizeManager.zoomOut(); setSize(fontSizeManager.getSize()); }}
        title="Zoom out"
      >
        <Minus className="h-3 w-3" />
      </Button>
      <span className="text-[11px] font-mono min-w-[2.5rem] text-center">{size}px</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => { fontSizeManager.zoomIn(); setSize(fontSizeManager.getSize()); }}
        title="Zoom in"
      >
        <PlusIcon className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => { fontSizeManager.reset(); setSize(fontSizeManager.getSize()); }}
        title="Reset zoom"
      >
        <RotateCcw className="h-3 w-3" />
      </Button>
    </div>
  );
}

export function BottomSheet({
  activeTab,
  onTabChange,
  collapsed,
  onToggleCollapse,
  showFilesTab,
  fontSizeManager,
  inputPanel,
  commandsPanel,
  envPanel,
  filesPanel,
}: BottomSheetProps) {
  // If 'files' is selected but the tab isn't shown, fall back to 'input'
  const effectiveTab = activeTab === 'files' && !showFilesTab ? 'input' : activeTab;

  const tabs: Array<{
    id: BottomTab;
    icon: typeof Keyboard;
    label: string;
    show: boolean;
  }> = [
    { id: 'input', icon: Keyboard, label: 'Input', show: true },
    { id: 'commands', icon: Zap, label: 'Commands', show: true },
    { id: 'env', icon: Package, label: 'Env', show: true },
    { id: 'files', icon: FolderTree, label: 'Files', show: showFilesTab },
  ];

  return (
    <div
      className={cn(
        'border-t flex-shrink-0 flex flex-col bg-background',
        'h-[40vh] landscape:h-[30vh]',
        collapsed && 'h-auto',
      )}
    >
      {/* TabBar */}
      <div className="flex items-center border-b h-10 flex-shrink-0">
        {tabs.map(({ id, icon, label, show }) => {
          if (!show) {
            return null;
          }
          const Icon = icon;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              className={cn(
                'flex items-center gap-1 px-2.5 py-2 text-xs transition-colors border-b-2 -mb-px h-full',
                effectiveTab === id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="w-3 h-3" /> {label}
            </button>
          );
        })}
        <div className="flex-1" />
        {fontSizeManager && <ZoomControls fontSizeManager={fontSizeManager} />}
        <button
          type="button"
          onClick={onToggleCollapse}
          className="px-2 py-2 text-xs text-muted-foreground hover:text-foreground"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {effectiveTab === 'input' && inputPanel}
          {effectiveTab === 'commands' && commandsPanel}
          {effectiveTab === 'env' && envPanel}
          {effectiveTab === 'files' && filesPanel}
        </div>
      )}
    </div>
  );
}
