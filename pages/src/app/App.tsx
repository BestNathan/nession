import {Component, useEffect, useState, type ReactNode} from 'react';
import {AgentDetailPage, AgentsPage} from '../features/agents/AgentsPage.tsx';
import {CollaborationPage, WorkDetailPage} from '../features/collaboration/CollaborationPage.tsx';
import {McpPage} from '../features/documents/mcp/McpPage.tsx';
import {DocumentsIndex, ProtocolPage} from '../features/documents/protocol/ProtocolPage.tsx';
import {validDocumentsSnapshot, validMcpSnapshot} from '../data/validation.ts';
import {EvidencePage} from '../features/evidence/EvidencePage.tsx';
import {KnowledgePage} from '../features/knowledge/KnowledgePage.tsx';
import {OverviewPage} from '../features/overview/OverviewPage.tsx';
import {PrototypesPage} from '../features/prototypes/PrototypesPage.tsx';
import {RepositoryPage} from '../features/repository/RepositoryPage.tsx';
import {WorkflowsPage} from '../features/workflows/WorkflowsPage.tsx';
import {Shell} from '../layouts/Shell.tsx';
import {LocalLink} from '../components/Links.tsx';
import {Empty, Failure, Loading} from '../components/Primitives.tsx';
import {loadingTitle, parseRoute, readyTitle, type RouteState} from './router.ts';
import {usePagesResources, type PagesResources} from './resources.tsx';
import {UiStateProvider} from './ui-state.tsx';

class RouteBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError(): {failed: boolean} {
    return {failed: true};
  }
  componentDidCatch(error: unknown): void {
    console.error('Pages render failure', error);
  }
  render(): ReactNode {
    return this.state.failed ? (
      <Failure text="The public snapshot could not be rendered. See the source repository for authoritative information." />
    ) : (
      this.props.children
    );
  }
}

function useHash(): string {
  const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash));
  useEffect(() => {
    const sync = (): void => setHash(window.location.hash);
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return hash;
}

export function IndexContent({hash, resources}: {hash: string; resources: PagesResources}): ReactNode {
  const route: RouteState = parseRoute(hash);
  const snapshot = resources.site.data;
  if (route.needsSite && !snapshot) {
    return resources.site.status === 'unavailable' ? (
      <Failure text="Engineering snapshot unavailable. Source data could not be loaded or validated; this does not imply zero activity." />
    ) : (
      <Loading text="Loading public engineering snapshot…" />
    );
  }
  if (route.agentMatch && snapshot) {
    return <AgentDetailPage snapshot={snapshot} hash={hash} match={route.agentMatch} />;
  }
  if (route.invalidAgentReference) {
    return (
      <>
        <LocalLink text="← AI Agents" path="/agents" />
        <Empty title="Invalid Agent reference" text="This is not a valid source-backed Agent identity." />
      </>
    );
  }
  if (route.workMatch && snapshot) {
    return <WorkDetailPage snapshot={snapshot} kind={route.workMatch.kind} number={route.workMatch.number} />;
  }
  if (route.invalidWorkReference) {
    return (
      <>
        <LocalLink text="← All recent work" path="/work" />
        <Empty
          title="Invalid evidence reference"
          text="This address does not identify a bounded public Issue or PR. No source has been verified."
        />
      </>
    );
  }
  switch (route.route) {
    case '/knowledge':
      if (resources.knowledge.status === 'loading') return <Loading text="Loading public Knowledge snapshot…" />;
      return <KnowledgePage data={resources.knowledge.data} hash={hash} />;
    case '/documents/mcp':
      if (resources.mcp.status === 'loading') return <Loading text="Loading MCP Tools…" />;
      return <McpPage data={resources.mcp.data} hash={hash} />;
    case '/documents/protocol':
      if (resources.documents.status === 'loading') return <Loading text="Loading technical Documents…" />;
      return <ProtocolPage data={resources.documents.data} hash={hash} />;
    case '/documents':
      return (
        <DocumentsIndex
          protocolStatus={resources.documents.status}
          protocolCount={
            resources.documents.status === 'available' && validDocumentsSnapshot(resources.documents.data)
              ? resources.documents.data.protocols.length
              : null
          }
          mcpStatus={resources.mcp.status}
          mcpCount={
            resources.mcp.status === 'available' && validMcpSnapshot(resources.mcp.data)
              ? resources.mcp.data.tools.length
              : null
          }
        />
      );
    case '/missing':
      return <Empty title="Route unavailable" text="The requested public page does not exist." />;
    case '/prototypes':
      return <PrototypesPage catalog={resources.prototypes} />;
    case '/':
      return snapshot ? <OverviewPage snapshot={snapshot} /> : null;
    case '/agents':
      return snapshot ? <AgentsPage snapshot={snapshot} hash={hash} /> : null;
    case '/work':
      return snapshot ? <CollaborationPage snapshot={snapshot} /> : null;
    case '/repository':
      return snapshot ? <RepositoryPage snapshot={snapshot} /> : null;
    case '/evidence':
      return snapshot ? <EvidencePage snapshot={snapshot} /> : null;
    default:
      return <Empty title="Route unavailable" text="The requested public page does not exist." />;
  }
}

export function BrowserIndexApp(): ReactNode {
  const hash = useHash();
  const resources = usePagesResources();
  const route = parseRoute(hash);
  const loading = route.needsSite && resources.site.status !== 'available';
  useEffect(() => {
    document.title = loading ? loadingTitle(route) : readyTitle(route);
  }, [route, loading]);
  return (
    <UiStateProvider>
      <Shell page="index" hash={hash} site={resources.site}>
        <RouteBoundary>
          <IndexContent hash={hash} resources={resources} />
        </RouteBoundary>
      </Shell>
    </UiStateProvider>
  );
}

export function BrowserWorkflowsApp(): ReactNode {
  const hash = useHash();
  return (
    <UiStateProvider>
      <Shell page="workflows" hash={hash} site={{status: 'loading', data: null}}>
        <RouteBoundary>
          <WorkflowsPage />
        </RouteBoundary>
      </Shell>
    </UiStateProvider>
  );
}
