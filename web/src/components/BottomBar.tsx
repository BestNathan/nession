import { TerminalIcon, Package, FolderTree, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export type BottomTab = 'commands' | 'env' | 'files';

interface BottomBarProps {
  activeTab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  envPanel: React.ReactNode;
  commandsPanel: React.ReactNode;
  /** Mobile-only Files tab content (FileBrowser). Rendered only when showFilesTab. */
  filesPanel?: React.ReactNode;
  /** Whether to show the Files tab (mobile only). */
  showFilesTab?: boolean;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
}

/** Bottom bar: tabbed Quick Commands / Env Files / (mobile) File browser. */
export function BottomBar({
  activeTab,
  onTabChange,
  envPanel,
  commandsPanel,
  filesPanel,
  showFilesTab = false,
  sheetOpen,
  onSheetToggle,
}: BottomBarProps) {
  // Mobile: tapping a tab both selects it and opens the sheet.
  const selectTab = (tab: BottomTab) => {
    onTabChange(tab);
    onSheetToggle(true);
  };

  // A stale 'files' tab (e.g. after a mobile→desktop resize, or if fileOps drops)
  // must not render the files panel when the Files tab isn't shown — fall back
  // to Commands so we never mount an orphan/duplicate FileBrowser.
  const effectiveTab = activeTab === 'files' && !showFilesTab ? 'commands' : activeTab;

  // The Files browser needs more vertical room than the Commands grid / Env list.
  const maxH = effectiveTab === 'files' ? 'max-h-[85dvh] sm:max-h-[40dvh]' : 'max-h-[70dvh] sm:max-h-[40dvh]';

  return (
    <div className={cn('border-t flex-shrink-0 flex flex-col pb-[env(safe-area-inset-bottom)]', maxH)}>
      <div className="flex border-b items-center">
        <button
          type="button"
          onClick={() => selectTab('commands')}
          className={cn(
            'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
            effectiveTab === 'commands'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <TerminalIcon className="w-3 h-3" /> Commands
        </button>
        <button
          type="button"
          onClick={() => selectTab('env')}
          className={cn(
            'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
            effectiveTab === 'env'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <Package className="w-3 h-3" /> Env
        </button>
        {showFilesTab && (
          <button
            type="button"
            onClick={() => selectTab('files')}
            className={cn(
              'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
              effectiveTab === 'files'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <FolderTree className="w-3 h-3" /> Files
          </button>
        )}
        {/* Mobile-only sheet toggle: expand when collapsed, collapse when open. */}
        <button
          type="button"
          onClick={() => onSheetToggle(!sheetOpen)}
          className="ml-auto px-3 py-1 text-xs text-muted-foreground hover:text-foreground sm:hidden"
          title={sheetOpen ? 'Collapse' : 'Expand'}
        >
          {sheetOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
      </div>
      {/* Content: always shown at sm+; on mobile only when the sheet is open */}
      <div
        className={cn(
          'flex-1 min-h-0 overflow-y-auto',
          sheetOpen ? 'block' : 'hidden sm:block',
        )}
      >
        {effectiveTab === 'files' ? filesPanel : effectiveTab === 'env' ? envPanel : commandsPanel}
      </div>
    </div>
  );
}
