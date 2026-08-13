import { useEffect, useState } from 'react';
import type { Extension } from '@codemirror/state';
import { ensureLanguage, getLanguage } from '../lib/codeMirrorLanguages';

/**
 * Resolve the CodeMirror language extensions for a language key, re-rendering
 * once a lazily-loaded language finishes loading asynchronously.
 *
 * Static languages resolve synchronously (via `getLanguage`). Lazy/legacy
 * languages (shell, go, rust, …) start as `[]` and flip to the loaded
 * extensions when the async import completes — CodeMirrorEditor reconfigures
 * its language compartment whenever this return value changes identity.
 */
export function useLanguageExtensions(langKey: string): Extension[] {
  const [exts, setExts] = useState<Extension[]>(() => getLanguage(langKey) ?? []);

  useEffect(() => {
    let cancelled = false;
    ensureLanguage(langKey).then((loaded) => {
      if (!cancelled) { setExts(loaded ?? []); }
    });
    return () => { cancelled = true; };
  }, [langKey]);

  return exts;
}
