import { FileText } from 'lucide-react';
import type { WorkspaceTool } from '../toolTypes';
import { FilesWebLayout } from './filesWeb';
import { FilesAppLayout } from './filesApp';

export const filesTool: WorkspaceTool = {
  id: 'files',
  label: 'Files',
  icon: FileText,
  order: 10,
  availability: (ctx) => ctx.fileOps !== null,
  layout: { web: FilesWebLayout, app: FilesAppLayout },
};
