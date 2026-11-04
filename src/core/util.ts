// Small helpers shared by the core modules.

/** Runs `fn` on every item, at most `limit` at a time; results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Folder name for an automatic backup, as the Java program names it: 01.11.2026+3.5.9PM */
export function backupFolderName(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const h = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${dd}.${mm}.${d.getFullYear()}+${h}.${d.getMinutes()}.${d.getSeconds()}${ampm}`;
}

/** Date as printed on bills: 01.11.2026 */
export function dateString(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
