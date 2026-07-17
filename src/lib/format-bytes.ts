export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) {
    const megabytes = bytes / (1024 * 1024);
    return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
