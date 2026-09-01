import { FileText } from 'lucide-react';
import type { WorkspaceTool } from '../toolTypes';
import { FileWorkspace } from '@/session-first/patterns/FileWorkspace';

export const filesTool: WorkspaceTool = {
  id: 'files',
  label: 'Files',
  icon: FileText,
  order: 10,
  availability: (ctx) => ctx.fileOps !== null,
  layout: {
    web: ({ ctx }) => <FileWorkspace fileOps={ctx.fileOps} />,
    app: ({ ctx }) => <FileWorkspace fileOps={ctx.fileOps} />,
  },
};
