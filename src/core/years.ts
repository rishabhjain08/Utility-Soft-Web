// Financial-year folder names look like "06-07" (two digits, dash, two digits).

const YEAR_RE = /^(\d{2})-(\d{2})$/;

export function isYear(s: string): boolean {
  return YEAR_RE.test(s);
}

function shift(year: string, by: number): string | null {
  const m = YEAR_RE.exec(year);
  if (!m) return null;
  const l = Number(m[1]) + by;
  const r = (Number(m[2]) + by + 100) % 100;
  if (l < 0 || l > 99) return null;
  return `${String(l).padStart(2, '0')}-${String(r).padStart(2, '0')}`;
}

/** The year before, or null when out of range (Java: "Year out of range"). */
export function previousYear(year: string): string | null {
  return shift(year, -1);
}

export function nextYear(year: string): string | null {
  return shift(year, 1);
}

/** The `n` years before `year`, most recent first, skipping out-of-range ones. */
export function previousYears(year: string, n: number): string[] {
  const out: string[] = [];
  let y: string | null = year;
  for (let i = 0; i < n; i++) {
    y = y ? previousYear(y) : null;
    if (!y) break;
    out.push(y);
  }
  return out;
}

/** Year folder for the financial year (April-March) containing `date`. */
export function financialYearOf(date: Date): string {
  const y = date.getFullYear() - (date.getMonth() < 3 ? 1 : 0);
  const l = y % 100;
  return `${String(l).padStart(2, '0')}-${String((l + 1) % 100).padStart(2, '0')}`;
}

/** Number of years from `a` to `b` (b - a), using the first two digits. */
export function yearDiff(a: string, b: string): number {
  return Number(b.slice(0, 2)) - Number(a.slice(0, 2));
}
