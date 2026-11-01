// Ordering identical to the Java program (SortAlphabatically uses
// String.compareToIgnoreCase), so serial-number positions match.

export function compareIgnoreCase(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let c1 = a.charAt(i);
    let c2 = b.charAt(i);
    if (c1 !== c2) {
      c1 = c1.toUpperCase();
      c2 = c2.toUpperCase();
      if (c1 !== c2) {
        c1 = c1.toLowerCase();
        c2 = c2.toLowerCase();
        if (c1 !== c2) return c1.charCodeAt(0) - c2.charCodeAt(0);
      }
    }
  }
  return a.length - b.length;
}

export function sortNames<T>(items: T[], key: (t: T) => string): T[] {
  return [...items].sort((x, y) => compareIgnoreCase(key(x), key(y)));
}

export function sortStrings(items: string[]): string[] {
  return sortNames(items, (s) => s);
}

export function sameName(a: string, b: string): boolean {
  return compareIgnoreCase(a, b) === 0;
}
