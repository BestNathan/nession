// web/src/terminal/state/ui.ts
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { ReconnectBanner } from '@/core/terminal-runtime/types';

export type { ReconnectBanner } from '@/core/terminal-runtime/types';

export const bannerAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<ReconnectBanner>('none');
});

export const bannerAttemptAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<number>(0);
});
