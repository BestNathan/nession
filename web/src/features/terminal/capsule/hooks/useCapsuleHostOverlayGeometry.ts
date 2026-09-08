import { useLayoutEffect, useState, type RefObject } from 'react';

export interface CapsuleHostOverlayGeometry {
  host: HTMLElement | null;
  dockBottomPx: number;
  panelHeightPx: number;
  dismissBottomPx: number;
}

function readPanelHeightPx(host: HTMLElement): number {
  const raw = getComputedStyle(host).getPropertyValue('--composer-commands-panel-max-height').trim();
  if (raw.endsWith('vh')) {
    const vh = Number.parseFloat(raw);
    if (!Number.isNaN(vh)) {
      return (window.innerHeight * vh) / 100;
    }
  }
  if (raw.endsWith('px')) {
    const px = Number.parseFloat(raw);
    if (!Number.isNaN(px)) {
      return px;
    }
  }
  return (window.innerHeight * 40) / 100;
}

export function useCapsuleHostOverlayGeometry(
  dockRef: RefObject<HTMLElement | null>,
  active: boolean,
): CapsuleHostOverlayGeometry {
  const [geometry, setGeometry] = useState<CapsuleHostOverlayGeometry>({
    host: null,
    dockBottomPx: 0,
    panelHeightPx: 0,
    dismissBottomPx: 0,
  });

  useLayoutEffect(() => {
    if (!active) {
      return;
    }

    const dock = dockRef.current;
    const host = dock?.closest('[data-terminal-capsule-host]');
    if (!dock || !(host instanceof HTMLElement)) {
      return;
    }

    const update = () => {
      const hostRect = host.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const dockBottomPx = Math.max(0, hostRect.bottom - dockRect.top);
      const panelHeightPx = readPanelHeightPx(host);
      setGeometry({
        host,
        dockBottomPx,
        panelHeightPx,
        dismissBottomPx: dockBottomPx + panelHeightPx,
      });
    };

    const observer = new ResizeObserver(update);
    observer.observe(dock);
    observer.observe(host);
    window.addEventListener('resize', update);
    update();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [active, dockRef]);

  return geometry;
}
