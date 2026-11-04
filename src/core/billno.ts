// Bill numbers: one Bill No. per client per year (as in the desktop version), which is
// a number, a range such as "145-147" for several bills, or a list "145, 150".
// The next number is offered, never forced: any text can be typed.

import { sameName } from './sort';

/** The numbers a Bill No. stands for, or null when it is not in one of the usual forms. */
export function billNumbers(text: string): number[] | null {
  const t = text.trim();
  if (t === '') return [];
  const out: number[] = [];
  for (const part of t.split(/\s*[,;]\s*/)) {
    const range = /^(\d{1,9})\s*(?:-|–|to)\s*(\d{1,9})$/i.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (b < a || b - a > 500) return null;
      for (let n = a; n <= b; n++) out.push(n);
    } else if (/^\d{1,9}$/.test(part)) out.push(Number(part));
    else return null;
  }
  return out;
}

/** "145", or "145-147" for three bills. */
export function billNoFor(first: number, bills: number): string {
  return bills > 1 ? `${first}-${first + bills - 1}` : String(first);
}

/** The number to offer next in a year: after the highest used in it, or else after the highest of the year before. */
export function nextBillNo(thisYear: string[], yearBefore: string[]): { next: number; from: 'this year' | 'the year before' | 'none' } {
  const highest = (list: string[]) => Math.max(0, ...list.flatMap((b) => billNumbers(b) ?? []));
  const here = highest(thisYear);
  if (here > 0) return { next: here + 1, from: 'this year' };
  const before = highest(yearBefore);
  return before > 0 ? { next: before + 1, from: 'the year before' } : { next: 1, from: 'none' };
}

/** Clients whose Bill No. shares a number with another client's, with the clients it clashes with. */
export function billNoClashes(clients: { name: string; billNo: string }[]): Map<string, string[]> {
  const owners = new Map<number, string[]>();
  for (const c of clients) {
    for (const n of new Set(billNumbers(c.billNo) ?? [])) owners.set(n, [...(owners.get(n) ?? []), c.name]);
  }
  const out = new Map<string, string[]>();
  for (const names of owners.values()) {
    if (names.length < 2) continue;
    for (const n of names) {
      const others = new Set([...(out.get(n) ?? []), ...names.filter((x) => !sameName(x, n))]);
      out.set(n, [...others]);
    }
  }
  return out;
}
