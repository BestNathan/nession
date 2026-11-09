import { AppPageHeader } from '@/app/patterns/AppPageHeader';
import {
  ProjectDetailContent,
  type ProjectDetailProps,
} from '@/product/project/components/ProjectDetail';

/** App: one pushed depth with exactly one host-owned Back/Header (#3025). */
export function AppProjectDetail(props: ProjectDetailProps & { onBack: () => void }) {
  const { onBack, ...rest } = props;
  return (
    <div
      data-testid="app-project-detail"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <AppPageHeader backLabel="Sessions" onBack={onBack} title={props.project.name} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ProjectDetailContent {...rest} />
      </div>
    </div>
  );
}
