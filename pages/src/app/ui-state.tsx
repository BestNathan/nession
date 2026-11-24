import {createContext, useContext, useMemo, useState, type ReactNode} from 'react';
import type {KnowledgeFilterState} from '../features/knowledge/model.ts';
import type {DocumentsFilterState} from '../features/documents/protocol/model.ts';

export interface PagesUiState {
  knowledge: KnowledgeFilterState;
  documents: DocumentsFilterState;
  mcp: {query: string};
}

interface PagesUiActions {
  setKnowledge: (patch: Partial<KnowledgeFilterState>) => void;
  setDocuments: (patch: Partial<DocumentsFilterState>) => void;
  setMcpQuery: (query: string) => void;
}

const UiStateContext = createContext<{state: PagesUiState; actions: PagesUiActions} | null>(null);

// Filter/search state is deliberately feature-local but survives hash
// navigation, matching the previous Pages lifetime.
export function UiStateProvider({children}: {children: ReactNode}) {
  const [state, setState] = useState<PagesUiState>({
    knowledge: {query: '', topic: 'all', category: 'all'},
    documents: {query: '', owner: 'All'},
    mcp: {query: ''},
  });
  const actions = useMemo<PagesUiActions>(
    () => ({
      setKnowledge: (patch) => setState((current) => ({...current, knowledge: {...current.knowledge, ...patch}})),
      setDocuments: (patch) => setState((current) => ({...current, documents: {...current.documents, ...patch}})),
      setMcpQuery: (query) => setState((current) => ({...current, mcp: {query}})),
    }),
    [],
  );
  return <UiStateContext.Provider value={{state, actions}}>{children}</UiStateContext.Provider>;
}

export function useUiState(): {state: PagesUiState; actions: PagesUiActions} {
  const context = useContext(UiStateContext);
  if (!context) throw new Error('Pages UI state is not mounted');
  return context;
}
