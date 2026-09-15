import { FileText } from 'lucide-react';
import type { WorkspaceViewBinding } from '../workspaceContext';
import { FilesWebLayout } from './filesWeb';
import { FilesAppLayout } from './filesApp';

export const filesView: WorkspaceViewBinding = {
  id: 'files',
  icon: FileText,
  layout: { web: FilesWebLayout, app: FilesAppLayout },
};
