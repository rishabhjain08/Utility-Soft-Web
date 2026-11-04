// Compares a desktop (Java) folder with a web-format folder and lists every
// difference: settings, years, clients (S.No., Bill No.), bills row by row,
// and the other files of the data folder byte for byte.
//
// The desktop side is read the way the web app reads desktop files (Workspace),
// the web side the way it reads its own (WebBooks), so what is compared is what
// each shows. The desktop folder is only read.

import { BillType, Letterhead, letterheadFromImpinfo, readBackupPath, readDropdownLines, readImpinfo, readPassword } from './config';
import { FsDir, findEntry, readOnly, tryDir } from './fs';
import { SEPARATOR, parseBillLine } from './bill';
import { compareIgnoreCase, sortStrings } from './sort';
import { EXTRAS, WebBooks, dropdownLines } from './webstore';
import { BILLS, LOCKS, Workspace, desktopBillTypes } from './workspace';
import { isYear } from './years';
import type { DesktopFolders, Progress } from './migrate';

export interface Difference {
  where: string;
  desktop: string;
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
const SERIAL = 'serialno.txt';
const BILLNO = 'billfromto.txt';
const JAVA_TEMP = '1q2m.txt';
const GROUP = '(new group)';

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

type FileRef = { dir: FsDir; name: string };

async function allFiles(dir: FsDir, path: string[], out: Map<string, FileRef>): Promise<void> {
  for (const e of await dir.list()) {
    if (e.kind === 'file') out.set([...path, e.name].join('/'), { dir, name: e.name });
    else await allFiles(await dir.dir(e.name), [...path, e.name], out);
  }
}

/** Files of a desktop data folder that the app does not read as data (paths joined with /). */
async function otherDesktopFiles(data: FsDir, types: BillType[]): Promise<Map<string, FileRef>> {
  const out = new Map<string, FileRef>();
  const other = async (dir: FsDir, name: string, kind: 'file' | 'directory', path: string[]) => {
    if (kind === 'file') out.set([...path, name].join('/'), { dir, name });
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
        const values = new Set([(await findEntry(cd, SERIAL, 'file'))?.name, (await findEntry(cd, BILLNO, 'file'))?.name]);
        const typeDirs = new Set<string>();
        for (const t of types) {
          const td = await findEntry(cd, t.folder, 'directory');
          if (td) typeDirs.add(td.name);
        }
        for (const x of await cd.list()) {
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export async function verify(
  desktop: DesktopFolders,
  web: WebBooks,
  opts: { relocated?: string[]; onProgress?: Progress } = {},
): Promise<VerifyReport> {
  const program = readOnly(desktop.program);
  const data = desktop.data ? readOnly(desktop.data) : null;
  const differences: Difference[] = [];
  let more = 0;
  const differ = (where: string, d: string, w: string) => {
    if (differences.length < LIMIT) differences.push({ where, desktop: d, web: w });
    else more++;
  };
  const notes: string[] = [];
  const settings = await web.settings();

  // ---------- settings ----------
  const password = await readPassword(program);
  if (password === null) differ('Password', '(no pass.txt)', 'set');
  else if (!(await web.checkPassword(password))) differ('Password', 'one password', 'a different password');

  const types = await desktopBillTypes(program, data);
  if (showTypes(types) !== showTypes(settings.billTypes)) differ('Bill tabs', showTypes(types), showTypes(settings.billTypes));

  const impinfo = await readImpinfo(program);
  const lh = letterheadFromImpinfo(impinfo);
  const wlh = settings.letterhead;
  if (!lh || !wlh) {
    if (!!lh !== !!wlh) differ('Letterhead', lh ? 'filled in' : 'not filled in', wlh ? 'filled in' : 'not filled in');
  } else {
    const parts: [keyof Letterhead, string][] = [['firmAddress', 'address lines'], ['firmName', 'firm name lines'], ['indexTitles', 'index sheet title']];
    for (const [k, label] of parts) {
      if (JSON.stringify(lh[k]) !== JSON.stringify(wlh[k])) differ(`Letterhead, ${label}`, showLines(lh[k]), showLines(wlh[k]));
    }
    const extra = (impinfo ?? []).slice(4);
    if (JSON.stringify(extra) !== JSON.stringify(settings.desktop.impinfoExtra)) {
      differ('impinfo.txt, lines after the letterhead', showLines(extra), showLines(settings.desktop.impinfoExtra));
    }
  }

  const dd = (await readDropdownLines(program)).filter((l) => l.trim() !== '');
  const wdd = dropdownLines(settings.dropdowns);
  for (let i = 0; i < Math.max(dd.length, wdd.length); i++) {
    if (dd[i] !== wdd[i]) differ(`Drop-down lists, line ${i + 1}`, dd[i] ?? '(none)', wdd[i] ?? '(none)');
  }

  const backup = await readBackupPath(program);
  if (backup !== settings.autoBackup) differ('Auto-backup folder', showValue(backup), showValue(settings.autoBackup));

  // ---------- years, clients, bills ----------
  const counts = { years: 0, clients: 0, bills: 0, rows: 0, extras: 0 };
  let reworded = 0;
  const ws = data && (await findEntry(data, BILLS, 'directory')) ? new Workspace(program, data) : null;
  const dYears = ws ? await ws.years() : [];
  const wYears = await web.years();
  for (const year of sortStrings([...new Set([...dYears, ...wYears])])) {
    counts.years++;
    if (!dYears.includes(year) || !wYears.includes(year)) {
      differ(`Year ${year}`, dYears.includes(year) ? 'present' : '(missing)', wYears.includes(year) ? 'present' : '(missing)');
      continue;
    }
    const dc = await ws!.clients(year);
    const recs = await web.records(year);
    const names = [...new Set([...dc.map((c) => c.name), ...recs.map((r) => r.name)])].sort(compareIgnoreCase);
    for (const name of names) {
      counts.clients++;
      const d = dc.find((c) => c.name === name);
      const w = recs.find((r) => r.name === name);
      const at = `${year} › ${name}`;
      if (!d || !w) {
        differ(at, d ? 'present' : '(missing)', w ? 'present' : '(missing)');
        continue;
      }
      if (d.serial !== w.serial) differ(`${at} › S.No.`, showValue(d.serial), showValue(w.serial));
      if (d.billNo !== w.billNo) differ(`${at} › Bill No.`, showValue(d.billNo), showValue(w.billNo));
      for (const b of w.bills) {
        if (!types.some((t) => t.folder === b.type)) differ(`${at} › ${b.type} › ${b.name}`, '(no such tab)', 'present');
      }
      for (const t of types) {
        const db = await ws!.bills(year, name, t.folder);
        const wb = await web.bills(year, name, t.folder);
        for (const bill of sortStrings([...new Set([...db, ...wb])])) {
          counts.bills++;
          opts.onProgress?.(`Checking… ${counts.bills} bills`);
          const where = `${at} › ${t.tab} › ${bill}`;
          if (!db.includes(bill) || !wb.includes(bill)) {
            differ(where, db.includes(bill) ? 'present' : '(missing)', wb.includes(bill) ? 'present' : '(missing)');
            continue;
          }
          const dl = (await ws!.readBillLines(year, name, t.folder, bill)) ?? [];
          const wl = (await web.readBillLines(year, name, t.folder, bill)) ?? [];
          const dcan = dl.map(canonical);
          const wcan = wl.map(canonical);
          counts.rows += dl.length;
          reworded += dl.filter((l) => l !== standard(l)).length;
          for (let i = 0; i < Math.max(dcan.length, wcan.length); i++) {
            if (dcan[i] !== wcan[i]) {
              differ(`${where}, row ${i + 1}`, show(dcan[i]), show(wcan[i]));
              break;
            }
          }
        }
      }
    }
  }

  // ---------- other files of the data folder ----------
  const relocated = opts.relocated ?? [];
  const isRelocated = (p: string) => relocated.some((r) => p === r || p.startsWith(`${r}/`));
  const dOther = data ? await otherDesktopFiles(data, types) : new Map<string, FileRef>();
  const wOther = new Map<string, FileRef>();
  const kept = await tryDir(web.root, EXTRAS);
  if (kept) await allFiles(kept, [], wOther);
  for (const p of sortStrings([...new Set([...dOther.keys(), ...wOther.keys()])])) {
    if (isRelocated(p)) continue;
    counts.extras++;
    const d = dOther.get(p);
    const w = wOther.get(p);
    if (!d || !w) {
      differ(`File ${p}`, d ? 'present' : '(missing)', w ? 'present' : '(missing)');
      continue;
    }
    if (!sameBytes(await d.dir.read(d.name), await w.dir.read(w.name))) differ(`File ${p}`, 'one content', 'a different content');
  }

  if (counts.extras) {
    notes.push(`${counts.extras} other file${counts.extras === 1 ? '' : 's'} in the data folder (not bills) ${counts.extras === 1 ? 'is' : 'are'} kept exactly as ${counts.extras === 1 ? 'it was' : 'they were'}.`);
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
