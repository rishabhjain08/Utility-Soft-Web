// Compares two sets of Utility Soft data and lists every difference: settings,
// years, clients (S.No., Bill No.), bills row by row, and the other files kept
// from a desktop data folder, byte for byte.
//
// Each side is read the way the app reads it (a desktop folder as the Java
// program would; web data through WebBooks), so what is compared is what each
// shows. Nothing is written to either side.

import { BillType, Letterhead, letterheadFromImpinfo, readBackupPath, readDropdownLines, readImpinfo, readPassword } from './config';
import { FsDir, findEntry, pick, readOnly } from './fs';
import { SEPARATOR, parseBillLine } from './bill';
import { compareIgnoreCase, sameName, sortStrings } from './sort';
import { ClientYear, WebBooks, billLinesOf, billNamesOf, dropdownLines } from './webstore';
import { BILLNO, BILLS, DesktopData, JAVA_TEMP, LOCKS, SERIAL, desktopBillTypes } from './desktop';
import { isYear } from './years';
import { mapLimit } from './util';
import type { DesktopFolders, Progress } from './migrate';

export interface Difference {
  where: string;
  /** What the first side has. */
  desktop: string;
  /** What the second side has. */
  web: string;
}

export interface VerifyReport {
  ok: boolean;
  counts: { years: number; clients: number; bills: number; rows: number; extras: number };
  /** The first differences found (at most LIMIT). */
  differences: Difference[];
  /** How many more differences there are. */
  more: number;
  /** Things worth knowing that are not differences. */
  notes: string[];
}

const LIMIT = 500;
const GROUP = '(new group)';

/** One side of a comparison. */
export interface Side {
  /** The password as stored in plain (desktop pass.txt); undefined when it cannot be read back. */
  password(): Promise<string | null | undefined>;
  checkPassword?(password: string): Promise<boolean>;
  types(): Promise<BillType[]>;
  letterhead(): Promise<Letterhead | null>;
  impinfoExtra(): Promise<string[]>;
  dropdowns(): Promise<string[]>;
  autoBackup(): Promise<string>;
  years(): Promise<string[]>;
  clients(year: string): Promise<{ name: string; serial: string; billNo: string; billTypes: string[] }[]>;
  bills(year: string, client: string, folder: string): Promise<string[]>;
  lines(year: string, client: string, folder: string, bill: string): Promise<string[] | null>;
  /** Other files kept from a desktop data folder: path -> reader. */
  others(): Promise<Map<string, () => Promise<Uint8Array | null>>>;
  /** What only the web format has (client details, payments), compared when both sides have it. */
  webOnly?(year: string, client: string): Promise<{ details: string; payments: string }>;
}

/** A desktop installation as a side (only read). */
export function desktopSide(f: DesktopFolders): Side {
  const program = readOnly(f.program);
  const data = f.data ? readOnly(f.data) : null;
  const d = data ? new DesktopData(data) : null;
  let types: Promise<BillType[]> | null = null;
  const t = () => (types ??= desktopBillTypes(program, data));
  return {
    password: () => readPassword(program),
    types: t,
    letterhead: async () => letterheadFromImpinfo(await readImpinfo(program)),
    impinfoExtra: async () => ((await readImpinfo(program)) ?? []).slice(4),
    dropdowns: async () => (await readDropdownLines(program)).filter((l) => l.trim() !== ''),
    autoBackup: () => readBackupPath(program),
    years: async () => (d ? d.years() : []),
    clients: async (year) => (d ? (await d.clients(year)).map((c) => ({ ...c, billTypes: [] })) : []),
    bills: async (year, client, folder) => (d ? d.bills(year, client, folder) : []),
    lines: async (year, client, folder, bill) => (d ? d.readBillLines(year, client, folder, bill) : null),
    others: async () => (data ? otherDesktopFiles(data, await t()) : new Map()),
  };
}

/** Web data as a side. Each year's clients are read once (the data does not change during a comparison). */
export function webSide(web: WebBooks): Side {
  const years = new Map<string, Promise<ClientYear[]>>();
  const recs = (year: string) => {
    let p = years.get(year);
    if (!p) years.set(year, (p = web.records(year)));
    return p;
  };
  const rec = async (year: string, client: string) => {
    const all = await recs(year);
    return all.find((r) => r.name === client) ?? all.find((r) => sameName(r.name, client)) ?? null;
  };
  return {
    password: async () => undefined,
    checkPassword: (p) => web.checkPassword(p),
    types: () => web.billTypes(),
    letterhead: () => web.letterhead(),
    impinfoExtra: async () => (await web.settings()).desktop.impinfoExtra,
    dropdowns: async () => dropdownLines((await web.settings()).dropdowns),
    autoBackup: () => web.backupPath(),
    years: () => web.years(),
    clients: async (year) => (await recs(year)).map((r) => ({ name: r.name, serial: r.serial, billNo: r.billNo, billTypes: r.bills.map((b) => b.type) })),
    bills: async (year, client, folder) => billNamesOf(await rec(year, client), folder),
    lines: async (year, client, folder, bill) => billLinesOf(await rec(year, client), folder, bill),
    others: async () => new Map((await web.settings()).desktop.files.map((f) => [f.path, () => web.readExtra(f)])),
    webOnly: async (year, client) => {
      const r = await rec(year, client);
      const details = r ? JSON.stringify((await web.vault.readJson([`clients`, `${r.id}.dat`]).catch(() => null)) ?? {}) : '{}';
      const payments = JSON.stringify(
        (r?.bills ?? [])
          .filter((b) => b.payments?.length)
          .map((b) => [b.type, b.name, b.payments!.map((p) => [p.date, p.kind, p.amount, p.note ?? ''])])
          .sort(),
      );
      return { details, payments };
    },
  };
}

/** A bill line as both formats read it: trailing spaces and the form of a group break do not matter. */
function canonical(line: string): string {
  const { desc, amount } = parseBillLine(line);
  return desc.trim() === SEPARATOR ? GROUP : `${desc.trimEnd()},${amount}`;
}

/** How the web app writes the line back for the desktop version. */
function standard(line: string): string {
  const c = canonical(line);
  return c === GROUP ? `${SEPARATOR},New` : c;
}

const show = (line: string | undefined) => (line === undefined ? '(no row)' : line === GROUP ? 'a new group starts' : `“${line.replace(/,([^,]*)$/, '”, amount “$1')}”`);
const showValue = (v: string) => (v === '' ? '(empty)' : v);
const showTypes = (t: BillType[]) => t.map((x) => (x.folder === x.tab ? x.tab : `${x.tab} (folder ${x.folder})`)).join(', ') || '(none)';
const showLines = (l: string[]) => l.map((x) => `“${x}”`).join(' / ') || '(empty)';

async function allFiles(dir: FsDir, path: string[], out: Map<string, () => Promise<Uint8Array | null>>): Promise<void> {
  for (const e of await dir.list()) {
    if (e.kind === 'file') out.set([...path, e.name].join('/'), () => dir.read(e.name));
    else await allFiles(await dir.dir(e.name), [...path, e.name], out);
  }
}

/** Files of a desktop data folder that are not read as data (paths joined with /). */
export async function otherDesktopFiles(data: FsDir, types: BillType[]): Promise<Map<string, () => Promise<Uint8Array | null>>> {
  const out = new Map<string, () => Promise<Uint8Array | null>>();
  const other = async (dir: FsDir, name: string, kind: 'file' | 'directory', path: string[]) => {
    if (kind === 'file') out.set([...path, name].join('/'), () => dir.read(name));
    else await allFiles(await dir.dir(name), [...path, name], out);
  };
  const billsName = (await findEntry(data, BILLS, 'directory'))?.name;
  const locksName = (await findEntry(data, LOCKS, 'file'))?.name;
  for (const e of await data.list()) {
    if (e.kind === 'file' && e.name === locksName) continue;
    if (e.kind !== 'directory' || e.name !== billsName) {
      await other(data, e.name, e.kind, []);
      continue;
    }
    const bills = await data.dir(e.name);
    for (const y of await bills.list()) {
      if (y.kind !== 'directory' || !isYear(y.name)) {
        await other(bills, y.name, y.kind, [e.name]);
        continue;
      }
      const yd = await bills.dir(y.name);
      for (const c of await yd.list()) {
        const path = [e.name, y.name];
        if (c.kind !== 'directory') {
          await other(yd, c.name, c.kind, path);
          continue;
        }
        const cd = await yd.dir(c.name);
        const entries = await cd.list();
        const values = new Set([pick(entries, SERIAL, 'file')?.name, pick(entries, BILLNO, 'file')?.name]);
        const typeDirs = new Set<string>();
        for (const t of types) {
          const td = pick(entries, t.folder, 'directory');
          if (td) typeDirs.add(td.name);
        }
        for (const x of entries) {
          if (x.kind === 'file' && values.has(x.name)) continue;
          if (x.kind === 'directory' && typeDirs.has(x.name)) {
            const td = await cd.dir(x.name);
            for (const f of await td.list()) {
              if (f.kind === 'file' && /\.txt$/i.test(f.name) && f.name.toLowerCase() !== JAVA_TEMP) continue;
              await other(td, f.name, f.kind, [...path, c.name, x.name]);
            }
          } else await other(cd, x.name, x.kind, [...path, c.name]);
        }
      }
    }
  }
  return out;
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  return !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Compares a desktop installation with web data. */
export function verify(desktop: DesktopFolders, web: WebBooks, opts: { relocated?: string[]; onProgress?: Progress } = {}): Promise<VerifyReport> {
  return compare(desktopSide(desktop), webSide(web), opts);
}

/** Compares two sides; differences say what `a` has and what `b` has. */
export async function compare(a: Side, b: Side, opts: { relocated?: string[]; onProgress?: Progress; ignoreAutoBackup?: boolean } = {}): Promise<VerifyReport> {
  const differences: Difference[] = [];
  let more = 0;
  const differ = (where: string, x: string, y: string) => {
    if (differences.length < LIMIT) differences.push({ where, desktop: x, web: y });
    else more++;
  };
  const notes: string[] = [];

  // ---------- settings ----------
  const pa = await a.password();
  if (pa === null) notes.push('The desktop folder had no password (pass.txt); the web data has the one chosen when it was made.');
  else if (pa !== undefined && b.checkPassword && !(await b.checkPassword(pa))) differ('Password', 'one password', 'a different password');

  const types = await a.types();
  const btypes = await b.types();
  if (showTypes(types) !== showTypes(btypes)) differ('Bill tabs', showTypes(types), showTypes(btypes));

  const la = await a.letterhead();
  const lb = await b.letterhead();
  if (!la || !lb) {
    if (!!la !== !!lb) differ('Letterhead', la ? 'filled in' : 'not filled in', lb ? 'filled in' : 'not filled in');
  } else {
    const parts: [keyof Letterhead, string][] = [['firmAddress', 'address lines'], ['firmName', 'firm name lines'], ['indexTitles', 'index sheet title']];
    for (const [k, label] of parts) if (JSON.stringify(la[k]) !== JSON.stringify(lb[k])) differ(`Letterhead, ${label}`, showLines(la[k]), showLines(lb[k]));
    const ea = await a.impinfoExtra();
    const eb = await b.impinfoExtra();
    if (JSON.stringify(ea) !== JSON.stringify(eb)) differ('impinfo.txt, lines after the letterhead', showLines(ea), showLines(eb));
  }

  const da = await a.dropdowns();
  const db = await b.dropdowns();
  for (let i = 0; i < Math.max(da.length, db.length); i++) if (da[i] !== db[i]) differ(`Drop-down lists, line ${i + 1}`, da[i] ?? '(none)', db[i] ?? '(none)');

  const ba = await a.autoBackup();
  const bb = await b.autoBackup();
  if (ba !== bb && !opts.ignoreAutoBackup) differ('Auto-backup folder', showValue(ba), showValue(bb));

  // ---------- years, clients, bills ----------
  const counts = { years: 0, clients: 0, bills: 0, rows: 0, extras: 0 };
  let reworded = 0;
  const ya = await a.years();
  const yb = await b.years();
  for (const year of sortStrings([...new Set([...ya, ...yb])])) {
    counts.years++;
    if (!ya.includes(year) || !yb.includes(year)) {
      differ(`Year ${year}`, ya.includes(year) ? 'present' : '(missing)', yb.includes(year) ? 'present' : '(missing)');
      continue;
    }
    const ca = await a.clients(year);
    const cb = await b.clients(year);
    const names = [...new Set([...ca.map((c) => c.name), ...cb.map((c) => c.name)])].sort(compareIgnoreCase);
    // Clients are checked 8 at a time; their differences are listed in name order.
    const results = await mapLimit(names, 8, async (name) => {
      const found: Difference[] = [];
      const local = (where: string, x: string, y: string) => found.push({ where, desktop: x, web: y });
      const c = { bills: 0, rows: 0, reworded: 0 };
      const x = ca.find((v) => v.name === name);
      const y = cb.find((v) => v.name === name);
      const at = `${year} › ${name}`;
      if (!x || !y) {
        local(at, x ? 'present' : '(missing)', y ? 'present' : '(missing)');
        return { found, c };
      }
      if (x.serial !== y.serial) local(`${at} › S.No.`, showValue(x.serial), showValue(y.serial));
      if (x.billNo !== y.billNo) local(`${at} › Bill No.`, showValue(x.billNo), showValue(y.billNo));
      if (a.webOnly && b.webOnly) {
        const [wa, wb] = await Promise.all([a.webOnly(year, name), b.webOnly(year, name)]);
        if (wa.details !== wb.details) local(`${at} › Client details`, 'one set', 'a different set');
        if (wa.payments !== wb.payments) local(`${at} › Payments`, 'one list', 'a different list');
      }
      for (const t of new Set([...x.billTypes, ...y.billTypes])) if (!types.some((k) => k.folder === t)) local(`${at} › ${t}`, '(no such tab)', 'has bills');
      for (const t of types) {
        const xb = await a.bills(year, name, t.folder);
        const yb2 = await b.bills(year, name, t.folder);
        for (const bill of sortStrings([...new Set([...xb, ...yb2])])) {
          c.bills++;
          const where = `${at} › ${t.tab} › ${bill}`;
          if (!xb.includes(bill) || !yb2.includes(bill)) {
            local(where, xb.includes(bill) ? 'present' : '(missing)', yb2.includes(bill) ? 'present' : '(missing)');
            continue;
          }
          const xl = (await a.lines(year, name, t.folder, bill)) ?? [];
          const yl = (await b.lines(year, name, t.folder, bill)) ?? [];
          const xc = xl.map(canonical);
          const yc = yl.map(canonical);
          c.rows += xl.length;
          c.reworded += xl.filter((l) => l !== standard(l)).length;
          for (let i = 0; i < Math.max(xc.length, yc.length); i++) {
            if (xc[i] !== yc[i]) {
              local(`${where}, row ${i + 1}`, show(xc[i]), show(yc[i]));
              break;
            }
          }
        }
      }
      return { found, c };
    });
    for (const r of results) {
      counts.clients++;
      counts.bills += r.c.bills;
      counts.rows += r.c.rows;
      reworded += r.c.reworded;
      for (const d of r.found) differ(d.where, d.desktop, d.web);
    }
    opts.onProgress?.(`Checking… ${counts.bills} bills`);
  }

  // ---------- other files kept from the desktop data folder ----------
  const relocated = opts.relocated ?? [];
  const isRelocated = (p: string) => relocated.some((r) => p === r || p.startsWith(`${r}/`));
  const oa = await a.others();
  const ob = await b.others();
  for (const p of sortStrings([...new Set([...oa.keys(), ...ob.keys()])])) {
    if (isRelocated(p)) continue;
    counts.extras++;
    const x = oa.get(p);
    const y = ob.get(p);
    if (!x || !y) {
      differ(`File ${p}`, x ? 'present' : '(missing)', y ? 'present' : '(missing)');
      continue;
    }
    if (!sameBytes(await x(), await y())) differ(`File ${p}`, 'one content', 'a different content');
  }

  if (counts.extras) {
    notes.push(`${counts.extras} other file${counts.extras === 1 ? '' : 's'} from the desktop data folder (not bills) ${counts.extras === 1 ? 'is' : 'are'} kept exactly as ${counts.extras === 1 ? 'it was' : 'they were'}.`);
  }
  if (reworded) {
    notes.push(
      `${reworded} row${reworded === 1 ? ' is' : 's are'} written slightly differently in the two formats (spaces at the end that only the desktop version needs, or the way a new group is marked); the content is the same.`,
    );
  }
  if (relocated.length) {
    notes.push(`${relocated.length} kept file${relocated.length === 1 ? '' : 's'} belonged to clients that are no longer there, so ${relocated.length === 1 ? 'it was' : 'they were'} put in the “Other files” folder.`);
  }
  return { ok: differences.length === 0 && more === 0, counts, differences, more, notes };
}
