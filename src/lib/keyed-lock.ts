/**
 * Cross-tab critical section named by `name`: Web Locks where available,
 * otherwise a same-tab FIFO promise queue. Runners see each other's writes;
 * failures release the lock and propagate to the caller only.
 */
const fallbackQueues = new Map<string, Promise<unknown>>();

export async function withKeyedLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(name, operation);
  }
  const previous = fallbackQueues.get(name) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  fallbackQueues.set(name, current);
  try {
    return await current;
  } finally {
    if (fallbackQueues.get(name) === current) fallbackQueues.delete(name);
  }
}
