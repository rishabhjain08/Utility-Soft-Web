// Client serial numbers ("S.No.") follow alphabetical order. A normal entry
// takes the next number and pushes everyone after it up by one. A "late entry"
// keeps everyone else's number (bills may already be printed) and gets the
// previous number plus a letter: 5, 5A, 5B, 6...
// Deleting a numbered client moves everyone after it down by one.

import { compareIgnoreCase } from './sort';

export interface SerialEntry {
  name: string;
  serial: string;
}

interface Parsed {
  num: number;
  letter: string; // '' when none
}

function isLetter(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

export function parseSerial(s: string): Parsed | null {
  const t = s.trim();
  if (t === '') return null;
  const last = t.charAt(t.length - 1);
  const letter = isLetter(last) ? last : '';
  const digits = letter ? t.slice(0, -1) : t;
  if (!/^[+-]?\d+$/.test(digits)) return null;
  return { num: parseInt(digits, 10), letter };
}

/** Java checks Character.isDigit on the last character to decide whether to renumber. */
export function endsWithDigit(s: string): boolean {
  return /\d$/.test(s);
}

export function shiftSerial(s: string, by: number): string {
  const p = parseSerial(s);
  if (!p) return s;
  return `${p.num + by}${p.letter}`;
}

function nextLetter(maxCode: number): string {
  if (maxCode === 0) return 'A';
  if (maxCode === 'Z'.charCodeAt(0)) return 'a';
  return String.fromCharCode(maxCode + 1);
}

/** Position where `name` goes in the sorted list (number of names before it). */
export function rankOf(entries: SerialEntry[], name: string): number {
  let rank = 0;
  while (rank < entries.length && compareIgnoreCase(name, entries[rank].name) > 0) rank++;
  return rank;
}

export interface InsertPlan {
  serial: string;
  /** Existing clients whose serial changes: name -> new serial. */
  updates: Map<string, string>;
}

/** `entries` must be the existing clients in sorted order, without `name`. */
export function planInsert(entries: SerialEntry[], name: string, late: boolean): InsertPlan {
  const rank = rankOf(entries, name);
  const updates = new Map<string, string>();
  const shiftFrom = (from: number) => {
    for (let i = from; i < entries.length; i++) {
      const s = shiftSerial(entries[i].serial, 1);
      if (s !== entries[i].serial) updates.set(entries[i].name, s);
    }
  };
  if (rank === 0) {
    shiftFrom(0);
    return { serial: '1', updates };
  }
  if (!late) {
    shiftFrom(rank);
    return { serial: String(baseNumberBefore(entries, rank) + 1), updates };
  }
  // Late entry: find the closest plain number at or before rank-1, then the
  // highest letter already used after it.
  let base = rank - 1;
  while (base > 0 && parseSerial(entries[base].serial)?.letter) base--;
  const baseNum = parseSerial(entries[base].serial)?.num ?? baseNumberBefore(entries, base);
  let maxCode = 0;
  for (let y = base + 1; y < entries.length; y++) {
    const p = parseSerial(entries[y].serial);
    if (!p || !p.letter || p.num !== baseNum) break;
    maxCode = Math.max(maxCode, p.letter.charCodeAt(0));
  }
  const own = parseSerial(entries[base].serial);
  if (own?.letter) maxCode = Math.max(maxCode, own.letter.charCodeAt(0));
  return { serial: `${baseNum}${nextLetter(maxCode)}`, updates };
}

/** Numeric part of the closest parsable serial before `rank`, or 0. */
function baseNumberBefore(entries: SerialEntry[], rank: number): number {
  for (let i = rank - 1; i >= 0; i--) {
    const p = parseSerial(entries[i].serial);
    if (p) return p.num;
  }
  return 0;
}

/** Serial changes caused by removing `name` from the sorted `entries`. */
export function planRemove(entries: SerialEntry[], name: string): Map<string, string> {
  const updates = new Map<string, string>();
  const idx = entries.findIndex((e) => e.name === name);
  if (idx === -1 || !endsWithDigit(entries[idx].serial)) return updates;
  for (let i = idx + 1; i < entries.length; i++) {
    const s = shiftSerial(entries[i].serial, -1);
    if (s !== entries[i].serial) updates.set(entries[i].name, s);
  }
  return updates;
}

/**
 * Serial changes for renaming `oldName` to `newName`. `entries` are the year's
 * clients in sorted order, including `oldName`.
 * - Renumbering (keep = false), as Java's Modify: the client is taken out of the
 *   numbering and put back in under the new name.
 * - Keeping the others' numbers (keep = true, Java's "late entry"): nobody else
 *   changes. The client keeps its own S.No. if it stays in the same place in the
 *   list, otherwise it gets a lettered one at its new place. (Java still moved
 *   everyone after the old place down by one.)
 */
export function planRename(entries: SerialEntry[], oldName: string, newName: string, keep: boolean): InsertPlan {
  const idx = entries.findIndex((e) => e.name === oldName);
  const rest = entries.filter((e) => e.name !== oldName);
  if (keep) {
    if (idx !== -1 && rankOf(rest, newName) === idx) return { serial: entries[idx].serial, updates: new Map() };
    return planInsert(rest, newName, true);
  }
  const removal = planRemove(entries, oldName);
  const shifted = rest.map((e) => ({ name: e.name, serial: removal.get(e.name) ?? e.serial }));
  const plan = planInsert(shifted, newName, false);
  const updates = new Map<string, string>();
  for (const e of shifted) {
    const now = plan.updates.get(e.name) ?? e.serial;
    if (now !== rest.find((r) => r.name === e.name)!.serial) updates.set(e.name, now);
  }
  return { serial: plan.serial, updates };
}

/** Whether two plans give every client the same S.No. */
export function samePlan(a: InsertPlan, b: InsertPlan): boolean {
  if (a.serial !== b.serial || a.updates.size !== b.updates.size) return false;
  for (const [k, v] of a.updates) if (b.updates.get(k) !== v) return false;
  return true;
}
