import { FileWarning } from 'lucide-react';

export interface UnsupportedViewProps {
  filename: string;
}

export function UnsupportedView({ filename }: UnsupportedViewProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-2 py-1 border-b flex-shrink-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[200px]">
          {filename}
        </span>
      </div>
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileWarning className="h-10 w-10" />
        <p className="text-sm">Preview not supported</p>
      </div>
    </div>
  );
}
