// Bill files: one line per row, "description,amount". The description is
// everything before the last comma. Occurrences of the bill's own year in the
// description are stored as "##" and shown as the year.
// A row whose description is "New Name" separates the bill into groups (one
// per person); it is stored as "New Name,New" and prints a group subtotal.

import { sanitize } from './codec';

export const SEPARATOR = 'New Name';
const SEPARATOR_AMOUNT = 'New';

export interface BillRow {
  /** Description as displayed (year substituted for "##"). */
  desc: string;
  amount: string;
}

export function isSeparator(row: BillRow): boolean {
  return row.desc.trim() === SEPARATOR;
}

export function parseBillLine(line: string): { desc: string; amount: string } {
  const i = line.lastIndexOf(',');
  if (i === -1) return { desc: line, amount: '' };
  return { desc: line.slice(0, i), amount: line.slice(i + 1) };
}

export function expandYear(desc: string, year: string): string {
  return desc.split('##').join(year);
}

export function collapseYear(desc: string, year: string): string {
  return year ? desc.split(year).join('##') : desc;
}

export function rowsFromLines(lines: string[], year: string): BillRow[] {
  return lines.map((l) => {
    const { desc, amount } = parseBillLine(l);
    // Trailing spaces may have been added for the Java program (see protectForJava).
    return { desc: expandYear(desc.trimEnd(), year), amount };
  });
}

/** Lines to store; rows with neither description nor amount are dropped (as in Java). */
export function linesFromRows(rows: BillRow[], year: string): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (isSeparator(r)) {
      out.push(`${SEPARATOR},${SEPARATOR_AMOUNT}`);
      continue;
    }
    const desc = sanitize(r.desc).trimEnd();
    // Older Java runtimes reject a leading "+".
    const amount = sanitize(r.amount).trim().replace(/^\+/, '');
    if (desc === '' && amount === '') continue;
    out.push(`${collapseYear(desc, year)},${amount}`);
  }
  return out;
}

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/** Amounts must be whole numbers that Java's Integer.parseInt accepts (or empty). */
export function isValidAmount(s: string): boolean {
  const t = s.trim();
  if (t === '') return true;
  if (!/^[+-]?\d+$/.test(t)) return false;
  const n = Number(t);
  return n >= INT_MIN && n <= INT_MAX;
}

export function amountValue(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) return 0;
  return Number(t);
}

export function normalizeAmount(s: string): string {
  const t = s.trim().replace(/,/g, '').replace(/\/-$/, '');
  if (t === '' || !/^[+-]?\d+$/.test(t)) return t;
  return String(Number(t));
}

/** Key used to match rows across years: description with year placeholder, case-insensitive. */
export function matchKey(desc: string, year: string): string {
  return collapseYear(desc.trimEnd(), year).toLowerCase();
}

/** Same key with a trailing "NN-NN" year removed, for matching older bills that stored a literal year. */
function looseKey(key: string): string {
  return /\d{2}-\d{2}$/.test(key) ? key.slice(0, -5) : key;
}

/**
 * Builds a new bill from the same bill in earlier years (most recent first):
 * every row of the most recent bill, then rows from older bills whose
 * description is not already present. Amounts are reset to 0, as the Java
 * program does.
 * Input rows are raw stored lines (with "##").
 */
export function mergeHistory(sources: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  sources.forEach((lines, idx) => {
    const before = new Set(seen);
    for (const line of lines) {
      const { desc } = parseBillLine(line);
      if (desc.trim() === SEPARATOR) {
        if (idx === 0) out.push(`${SEPARATOR},${SEPARATOR_AMOUNT}`);
        continue;
      }
      if (desc.trim() === '') continue;
      const key = desc.trimEnd().toLowerCase();
      if (idx > 0 && (before.has(key) || before.has(looseKey(key)))) continue;
      seen.add(key);
      seen.add(looseKey(key));
      out.push(`${desc.trimEnd()},0`);
    }
  });
  return out;
}

export interface HistoryColumn {
  year: string;
  /** Per current row: amounts found in that year ("--" when none), joined with ",". */
  values: string[];
  /** Per current row: how much it adds to `total` (repeated descriptions count once). */
  counted: number[];
  total: number;
}

/**
 * Amounts for each current row in earlier years' versions of the bill.
 * `rows` are the current rows (displayed), `history` the raw lines per earlier year.
 */
export function historyColumns(rows: BillRow[], year: string, history: { year: string; lines: string[] | null }[]): HistoryColumn[] {
  const keys = rows.map((r) => matchKey(r.desc, year));
  // Only the first occurrence of a description counts towards the totals.
  const firstIdx = new Map<string, number>();
  keys.forEach((k, i) => {
    if (!firstIdx.has(k)) firstIdx.set(k, i);
  });
  return history.map(({ year: y, lines }) => {
    const found: (string[] | null)[] = rows.map(() => null);
    for (const line of lines ?? []) {
      const { desc, amount } = parseBillLine(line);
      const k = desc.trimEnd().toLowerCase();
      rows.forEach((r, i) => {
        if (isSeparator(r) || keys[i] !== k) return;
        if (found[i] === null) found[i] = [amount];
        else if (amount !== '') found[i]!.push(amount);
      });
    }
    const counted = found.map((vals, i) => (vals && firstIdx.get(keys[i]) === i ? vals.reduce((t, v) => t + amountValue(v), 0) : 0));
    const total = counted.reduce((t, v) => t + v, 0);
    return { year: y, values: found.map((v) => (v === null ? '--' : v.join(','))), counted, total };
  });
}

export function billTotal(rows: BillRow[]): number {
  return rows.reduce((t, r) => (isSeparator(r) ? t : t + amountValue(r.amount)), 0);
}

/**
 * The bill's groups (Java's "New Name" separators start a new one; printed with
 * their own subtotals): row indices of each group and the separator starting it.
 */
export function rowGroups(rows: BillRow[]): { start: number | null; rows: number[] }[] {
  const out: { start: number | null; rows: number[] }[] = [{ start: null, rows: [] }];
  rows.forEach((r, i) => {
    if (isSeparator(r)) out.push({ start: i, rows: [] });
    else out[out.length - 1].rows.push(i);
  });
  return out;
}

/** Serial numbers shown in the editor: separators get none. */
export function rowNumbers(rows: BillRow[]): string[] {
  let n = 0;
  return rows.map((r) => (isSeparator(r) ? '' : String(++n)));
}

// ---------- keeping bills openable by the Java program ----------
//
// When the Java program opens a bill it collects, for every row, the amounts of
// the rows with the same text (ignoring case) in the previous three years'
// copies of the bill. If exactly one such amount is found, or several of which
// only the first is not blank, it is read with Integer.parseInt without any
// error handling, and a blank or non-numeric value makes the bill impossible
// to open. Typical cause: a row typed without an amount (such as a person's
// name) last year, and the same row this year. Adding trailing spaces to this
// year's row makes the texts differ for Java (it compares them exactly apart
// from case) while nothing visible changes.

function javaInt(v: string): boolean {
  if (!/^-?\d+$/.test(v)) return false;
  const n = Number(v);
  return n >= INT_MIN && n <= INT_MAX;
}

/** The value Java collects for a row with text `desc` from one earlier year's lines. */
function javaHistoryValue(desc: string, lines: string[]): string | null {
  let v: string | null = null;
  for (const line of lines) {
    const i = line.lastIndexOf(',');
    if (i === -1) continue;
    if (!sameText(line.slice(0, i), desc)) continue;
    const amount = line.slice(i + 1);
    if (v === null) v = amount;
    else if (amount !== '') v += `,${amount}`;
  }
  return v;
}

function sameText(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

function crashesJava(desc: string, previous: (string[] | null)[]): boolean {
  if (desc === SEPARATOR) return false;
  return previous.some((lines) => {
    const v = lines ? javaHistoryValue(desc, lines) : null;
    return v !== null && !v.includes(',') && !javaInt(v);
  });
}

/**
 * Returns the bill lines with trailing spaces added to any row text that would
 * stop the Java program from opening the bill, given the same bill's lines in
 * the previous three years (most recent first).
 */
export function protectForJava(lines: string[], previous: (string[] | null)[]): string[] {
  return lines.map((line) => {
    const i = line.lastIndexOf(',');
    if (i === -1) return line;
    const base = line.slice(0, i).trimEnd();
    const amount = line.slice(i + 1);
    let desc = line.slice(0, i);
    if (!crashesJava(desc, previous) && (desc === base || crashesJava(base, previous))) return line;
    // Prefer the plain text; otherwise the fewest trailing spaces that are safe.
    desc = base;
    while (crashesJava(desc, previous)) desc += ' ';
    return `${desc},${amount}`;
  });
}
