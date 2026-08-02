/**
 * Runtime guards for API responses, so a server shape change fails loudly at
 * the fetch boundary instead of silently at a distant use site.
 */
export async function readJson<T>(
  response: Response,
  guard: (value: unknown) => value is T,
): Promise<T | null> {
  if (!response.ok) return null;
  const data: unknown = await response.json().catch(() => null);
  return guard(data) ? data : null;
}

export type CollectionSummary = { id: string; name: string; includesBook: boolean };

export function isCollectionPayload(value: unknown): value is { collection: CollectionSummary } {
  const payload = value as { collection?: CollectionSummary } | null;
  return (
    !!payload?.collection &&
    typeof payload.collection.id === "string" &&
    typeof payload.collection.name === "string" &&
    typeof payload.collection.includesBook === "boolean"
  );
}
