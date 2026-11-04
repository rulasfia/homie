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
 * Like singleFlight, but keyed so one slow key does not hold up another. Only
 * one request per key can be in flight; the key is released once it settles.
 */
export function keyedSingleFlight<K, T>(load: (key: K) => Promise<T>) {
  const inFlight = new Map<K, Promise<T>>();

  return (key: K) => {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const request = startLoad(() => load(key));
    inFlight.set(key, request);
    const release = () => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    };
    void request.then(release, release);
    return request;
  };
}
