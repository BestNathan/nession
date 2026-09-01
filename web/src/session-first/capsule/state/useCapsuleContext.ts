import { useContext } from 'react';
import { CapsuleContext, type CapsuleContextValue } from '@/session-first/capsule/state/capsuleContext';

export function useCapsuleContext(): CapsuleContextValue {
  const value = useContext(CapsuleContext);
  if (!value) {
    throw new Error('useCapsuleContext must be used within CapsuleProvider');
  }
  return value;
}
