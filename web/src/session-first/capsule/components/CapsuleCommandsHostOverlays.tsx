import { createPortal } from 'react-dom';
import type { RefObject } from 'react';
import { CapsuleCommandsDismissLayer } from '@/session-first/capsule/CapsuleCommandsDismissLayer';
import { CapsuleCommandsPanel } from '@/session-first/capsule/CapsuleCommandsPanel';
import { useCapsuleHostOverlayGeometry } from '@/session-first/capsule/hooks/useCapsuleHostOverlayGeometry';
import { capsuleCommandsOverlayPanelClass } from '@/session-first/capsule/capsuleStyles';
import { useCapsuleContext } from '@/session-first/capsule/state/useCapsuleContext';

interface CapsuleCommandsHostOverlaysProps {
  dockRef: RefObject<HTMLElement | null>;
}

function CapsuleCommandsHostOverlays({ dockRef }: CapsuleCommandsHostOverlaysProps) {
  const { commandsOpen, setCommandsOpen, mode, sendText, disabled } = useCapsuleContext();
  const active = mode === 'commands' && commandsOpen;
  const { host, dockBottomPx, panelHeightPx, dismissBottomPx } = useCapsuleHostOverlayGeometry(
    dockRef,
    active,
  );

  if (!active || !host) {
    return null;
  }

  return createPortal(
    <>
      <CapsuleCommandsDismissLayer
        bottomPx={dismissBottomPx}
        onDismiss={() => setCommandsOpen(false)}
      />
      <div
        data-testid="capsule-commands-overlay"
        className={capsuleCommandsOverlayPanelClass}
        style={{
          bottom: dockBottomPx,
          height: panelHeightPx,
        }}
      >
        <CapsuleCommandsPanel
          sendText={sendText}
          disabled={disabled}
          onClose={() => setCommandsOpen(false)}
        />
      </div>
    </>,
    host,
  );
}

export { CapsuleCommandsHostOverlays };
