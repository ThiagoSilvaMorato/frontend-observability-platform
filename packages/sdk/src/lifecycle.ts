export interface LifecycleHandlers {
  /** The page was hidden or is being unloaded; it may never run code again. */
  onExit: () => void;
  onOnline: () => void;
  onError: (error: unknown) => void;
}

/**
 * Subscribes to the browser signals the pipeline cares about and returns an
 * unsubscribe function.
 *
 * `visibilitychange → hidden` is the last event reliably delivered on mobile
 * (apps get killed from the background without `pagehide`/`unload`), so it is
 * the primary exit signal; `pagehide` covers desktop navigation. `unload` is
 * avoided: it disables the back/forward cache.
 */
export function watchLifecycle({ onExit, onOnline, onError }: LifecycleHandlers): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  // An exception escaping a listener would surface in the app as an uncaught
  // error — exactly what the SDK promises never to cause.
  const guard = (handler: () => void) => () => {
    try {
      handler();
    } catch (error) {
      onError(error);
    }
  };
  const onVisibilityChange = guard(() => {
    if (document.visibilityState === 'hidden') onExit();
  });
  const onPageHide = guard(onExit);
  const onOnlineEvent = guard(onOnline);

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnlineEvent);

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('online', onOnlineEvent);
  };
}
