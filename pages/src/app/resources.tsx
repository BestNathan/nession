import {useEffect, useState} from 'react';
import {
  initialResources,
  loadDocumentsResource,
  loadKnowledgeResource,
  loadMcpResource,
  loadPrototypeResource,
  loadSiteResource,
  type PagesResources,
} from '../data/load.ts';

export type {PagesResources, Resource, ResourceStatus} from '../data/load.ts';
export {initialResources} from '../data/load.ts';

// Each source is independent: a failed site.json must not block Knowledge,
// Documents, MCP or Prototypes, and vice versa.
export function usePagesResources(): PagesResources {
  const [resources, setResources] = useState<PagesResources>(initialResources);

  useEffect(() => {
    let cancelled = false;
    const options = {baseURI: document.baseURI};
    async function loadPrototypes(): Promise<void> {
      try {
        const resource = await loadPrototypeResource(options);
        if (!cancelled) setResources((current) => ({...current, prototypes: resource}));
      } catch (error) {
        console.warn('Pages prototype catalog unavailable', error);
        if (!cancelled) setResources((current) => ({...current, prototypes: {status: 'unavailable', data: null}}));
      }
    }
    async function loadKnowledge(): Promise<void> {
      try {
        const resource = await loadKnowledgeResource(options);
        if (!cancelled) setResources((current) => ({...current, knowledge: resource}));
      } catch (error) {
        console.warn('Pages Knowledge snapshot unavailable', error);
        if (!cancelled) setResources((current) => ({...current, knowledge: {status: 'unavailable', data: null}}));
      }
    }
    async function loadDocuments(): Promise<void> {
      try {
        const resource = await loadDocumentsResource(options);
        if (!cancelled) setResources((current) => ({...current, documents: resource}));
      } catch (error) {
        console.warn('Pages Documents snapshot unavailable', error);
        if (!cancelled) setResources((current) => ({...current, documents: {status: 'unavailable', data: null}}));
      }
    }
    async function loadMcp(): Promise<void> {
      try {
        const resource = await loadMcpResource(options);
        if (!cancelled) setResources((current) => ({...current, mcp: resource}));
      } catch (error) {
        console.warn('Pages MCP catalog unavailable', error);
        if (!cancelled) setResources((current) => ({...current, mcp: {status: 'unavailable', data: null}}));
      }
    }
    async function loadSite(): Promise<void> {
      try {
        const resource = await loadSiteResource(options);
        if (!cancelled) setResources((current) => ({...current, site: resource}));
      } catch (error) {
        console.warn('Pages public engineering snapshot unavailable', error);
        if (!cancelled) setResources((current) => ({...current, site: {status: 'unavailable', data: null}}));
      }
    }
    void loadPrototypes();
    void loadKnowledge();
    void loadDocuments();
    void loadMcp();
    void loadSite();
    return () => {
      cancelled = true;
    };
  }, []);

  return resources;
}
