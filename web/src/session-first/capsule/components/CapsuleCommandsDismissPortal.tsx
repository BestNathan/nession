import { useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CapsuleCommandsDismissLayer } from '@/session-first/capsule/CapsuleCommandsDismissLayer';
import { useCapsuleContext } from '@/session-first/capsule/state/useCapsuleContext';

interface CapsuleCommandsDismissPortalProps {
  dockRef: RefObject<HTMLElement | null>;
}

function CapsuleCommandsDismissPortal({ dockRef }: CapsuleCommandsDismissPortalProps) {
  const { commandsOpen, setCommandsOpen, mode } = useCapsuleContext();
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const host = dockRef.current?.closest('[data-terminal-capsule-host]');
    if (host instanceof HTMLElement) {
      setPortalHost(host);
    }
  }, [dockRef]);

  if (mode !== 'commands' || !commandsOpen || !portalHost) {
    return null;
  }

  return createPortal(
    <CapsuleCommandsDismissLayer
      dockRef={dockRef}
      onDismiss={() => setCommandsOpen(false)}
    />,
    portalHost,
  );
}

export { CapsuleCommandsDismissPortal };
