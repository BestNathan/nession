import { CapsuleContext, type CapsuleContextValue } from '@/features/terminal/capsule/state/capsuleContext';

export function CapsuleProvider({
  value,
  children,
}: {
  value: CapsuleContextValue;
  children: React.ReactNode;
}) {
  return <CapsuleContext.Provider value={value}>{children}</CapsuleContext.Provider>;
}
