import type { ReactNode } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { compactJson, copyJsonValue, prettyJson } from './jsonCopy';

interface JsonCopyMenuProps {
  path: string;
  value: unknown;
  children: ReactNode;
}

/** Quiet contextual copy affordance for JsonTree rows (#1199). */
export function JsonCopyMenu({ path, value, children }: JsonCopyMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block min-w-0">{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[12rem]">
        <ContextMenuItem onClick={() => { void copyJsonValue('value', compactJson(value)); }}>
          Copy value
        </ContextMenuItem>
        <ContextMenuItem onClick={() => { void copyJsonValue('compact JSON', compactJson(value)); }}>
          Copy compact JSON
        </ContextMenuItem>
        <ContextMenuItem onClick={() => { void copyJsonValue('pretty JSON', prettyJson(value)); }}>
          Copy pretty JSON
        </ContextMenuItem>
        <ContextMenuItem onClick={() => { void copyJsonValue('path', path); }}>
          Copy path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
