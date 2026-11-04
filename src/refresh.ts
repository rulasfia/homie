function startLoad<T>(load: () => Promise<T>): Promise<T> {
  try {
    return load();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Runs one load at a time. Callers that arrive while a load is in flight share
 * its promise, so a timer tick and a manual refresh cannot overlap. Once the
 * load settles, the next caller starts a fresh one.
 */
export function singleFlight<T>(load: () => Promise<T>) {
  let inFlight: Promise<T> | undefined;

  return () => {
    if (inFlight) return inFlight;

    const request = startLoad(load);
    inFlight = request;
    const release = () => {
      if (inFlight === request) inFlight = undefined;
    };
    void request.then(release, release);
    return request;
  };
}

/**
 * Calls `refresh` every `intervalMs` while the page is visible. The caller has
 * just refreshed, so the first tick is a full interval away. The timer pauses
 * while the tab is hidden; on return it refreshes at once if the last refresh
 * is older than the interval, otherwise it waits out the remaining time. There
 * is only ever one pending timer. Returns a function that refreshes now and
 * restarts the interval, for manual refreshes.
 */
export function scheduleRefresh(refresh: () => unknown, intervalMs: number) {
  let lastRefreshAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function arm(delay: number) {
    clearTimeout(timer);
    timer = document.visibilityState === "hidden" ? undefined : setTimeout(refreshNow, delay);
  }

  function refreshNow() {
    lastRefreshAt = Date.now();
    void refresh();
    arm(intervalMs);
  }

  document.addEventListener("visibilitychange", () => {
    const remaining = intervalMs - (Date.now() - lastRefreshAt);
    if (document.visibilityState === "visible" && remaining <= 0) refreshNow();
    else arm(remaining);
  });

  arm(intervalMs);
  return refreshNow;
}
