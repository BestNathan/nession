import { CapsuleContext, type CapsuleContextValue } from '@/session-first/capsule/state/capsuleContext';

export function CapsuleProvider({
  value,
  children,
}: {
  value: CapsuleContextValue;
  children: React.ReactNode;
}) {
  return <CapsuleContext.Provider value={value}>{children}</CapsuleContext.Provider>;
}
