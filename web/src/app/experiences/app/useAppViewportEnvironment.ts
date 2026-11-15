import { useLayoutEffect, type RefObject } from 'react';
import {
  APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE,
} from '@/platform/viewport/appViewport';
import {
  AppViewportEnvironment,
  createBrowserAppViewportEnvironmentHost,
} from '@/platform/viewport/AppViewportEnvironment';

/**
 * Mount the App Experience's viewport environment on its frame element (#3523).
 *
 * The frame keeps its CSS layout height. This hook measures what the browser
 * actually makes visible and publishes a shell-local snapshot on the frame; it
 * never writes the shell's height and never touches terminal geometry. The
 * active layer's keyboard-avoidance scrollport is a consumer.
 */
export function useAppViewportEnvironment(shellRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    shell.setAttribute(APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE, '');
    const environment = new AppViewportEnvironment(
      shell,
      createBrowserAppViewportEnvironmentHost(shell),
    );
    environment.start();
    return () => {
      environment.stop();
      shell.removeAttribute(APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE);
    };
  }, [shellRef]);
}
