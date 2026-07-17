/** One in-flight run per key; concurrent callers share the same promise. */
export function singleFlight(
  active: Map<string, Promise<void>>,
  key: string,
  run: () => Promise<void>,
): Promise<void> {
  const existing = active.get(key);
  if (existing) return existing;
  const flight = run().finally(() => {
    if (active.get(key) === flight) active.delete(key);
  });
  active.set(key, flight);
  return flight;
}
