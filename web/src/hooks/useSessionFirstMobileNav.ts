import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';

/** Mobile shell: full-width session list XOR active session detail below lg. Above lg the list is hidden (sessions live in the drawer); showDetail stays true. */
export function useSessionFirstMobileNav(selectedId: string | null) {
  const isWide = useMediaQuery('(min-width: 1024px)');
  const [mobilePane, setMobilePane] = useState<'list' | 'detail'>('list');
  const wasWideRef = useRef(isWide);

  useEffect(() => {
    if (!isWide && !selectedId) {
      setMobilePane('list');
    }
    if (wasWideRef.current && !isWide && selectedId) {
      setMobilePane('detail');
    }
    wasWideRef.current = isWide;
  }, [isWide, selectedId]);

  const showList = !isWide && mobilePane === 'list';
  const showDetail = isWide || (mobilePane === 'detail' && selectedId !== null);

  const openDetail = useCallback(() => {
    setMobilePane('detail');
  }, []);

  const openList = useCallback(() => {
    setMobilePane('list');
  }, []);

  return { isWide, showList, showDetail, openDetail, openList };
}
