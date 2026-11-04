// Moving between the desktop (Java) layout and the web format, always into a
// new, empty folder: the folder copied from is only read (see readOnly).
//
// Migration: desktop folder -> web format. Bills, clients, S.No., Bill No.,
// letterhead, tabs, drop-down lists, password and auto-backup folder become the
// web format; every other file in the data folder is kept byte for byte in
// desktop-extras. Export does the reverse. Both are checked with verify().

import {
  decodeCipherLines, decodeCipherValue, decodePlainLines, encodeCipherLines, encodeCipherValue, encodePlain, encodePlainLines,
} from './codec';
import {
  FILES, formatBillTypes, letterheadFromImpinfo, letterheadLines, readBackupPath, readDropdownLines, readImpinfo, readPassword,
} from './config';
import { FsDir, ensureDir, findEntry, readOnly, tryDir, writeFile } from './fs';
import { UserError } from './names';
import {
  ClientYear, EXTRAS, FORMAT, MANIFEST, Settings, StoredBill, VERSION, WebBooks, dropdownLines, dropdownsFromLines, encodeJson,
  groupsFromLines, hashPassword, linesFromGroups,
} from './webstore';
import { BILLS, LOCKS, Workspace, desktopBillTypes } from './workspace';
import { isYear } from './years';
import { VerifyReport, verify } from './verify';

const SERIAL = 'serialno.txt';
const BILLNO = 'billfromto.txt';
const JAVA_TEMP = '1q2m.txt';

/** A desktop installation: the program folder (pass.txt, impinfo.txt…) and its data folder (bills/…). */
export interface DesktopFolders {
  program: FsDir;
  /** null when there is no data folder yet. */
  data: FsDir | null;
  /** How the data folder is shown to the user (for the record in the copy). */
  dataLabel?: string;
}

export interface Progress {
  (label: string): void;
}

export interface MigrationResult {
  years: number;
  clients: number;
  bills: number;
  /** Files and folders kept as they were (paths inside the data folder). */
  extras: string[];
  /** "year,NAME" of clients that were open in the desktop version at the time. */
  openInDesktop: string[];
  report: VerifyReport;
}

async function assertEmpty(dest: FsDir, outside: (FsDir | null)[]): Promise<void> {
  for (const o of outside) {
    if (o && (await isInside(o, dest))) throw new UserError(`Choose a folder outside ${o.name}, so that it stays exactly as it is.`);
  }
  if ((await dest.list()).length > 0) throw new UserError(`The folder ${dest.name} is not empty. Choose an empty folder for the copy.`);
}

function idMaker() {
  const used = new Set<string>();
  return () => {
    let id: string;
    do id = Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
    while (used.has(id));
    used.add(id);
    return id;
  };
}

/** Copies a file or folder (recursively) from the desktop folder into desktop-extras. */
async function keep(from: FsDir, name: string, kind: 'file' | 'directory', to: FsDir): Promise<void> {
  if (kind === 'file') {
    await writeFile(to, name, await from.read(name));
    return;
  }
  const src = await from.dir(name);
  const dest = await ensureDir(to, name);
  for (const e of await src.list()) await keep(src, e.name, e.kind, dest);
}

/** Opens desktop-extras/<path> for writing, creating the folders on the way. */
async function extrasDir(dest: FsDir, path: string[]): Promise<FsDir> {
  let d = await ensureDir(dest, EXTRAS);
  for (const p of path) d = await ensureDir(d, p);
  return d;
}

/**
 * Copies a desktop installation into `dest` (an empty folder) in the web format,
 * then compares the two. The desktop folders are never written to.
 */
export async function migrateDesktop(src: DesktopFolders, dest: FsDir, onProgress?: Progress): Promise<MigrationResult> {
  const program = readOnly(src.program);
  const data = src.data ? readOnly(src.data) : null;
  await assertEmpty(dest, [src.program, src.data]);
  const password = await readPassword(program);
  if (password === null) throw new UserError('This folder has no password (pass.txt).');

  const impinfo = await readImpinfo(program);
  const types = await desktopBillTypes(program, data);
  const extras: string[] = [];
  const openInDesktop: string[] = [];
  const nextId = idMaker();
  const idByName = new Map<string, string>();
  let clients = 0;
  let bills = 0;
  const years = await ensureDir(dest, 'years');
  let yearCount = 0;

  const extra = async (from: FsDir, path: string[], kind: 'file' | 'directory') => {
    await keep(from, path[path.length - 1], kind, await extrasDir(dest, path.slice(0, -1)));
    extras.push(path.join('/'));
  };

  const client = async (yearDir: FsDir, year: string, name: string, path: string[], usedIds: Set<string>) => {
    const c = await yearDir.dir(name);
    const serialName = (await findEntry(c, SERIAL, 'file'))?.name;
    const billNoName = (await findEntry(c, BILLNO, 'file'))?.name;
    const typeOf = new Map<string, string>();
    for (const t of types) {
      const e = await findEntry(c, t.folder, 'directory');
      if (e && !typeOf.has(e.name)) typeOf.set(e.name, t.folder);
    }
    let id = idByName.get(name.toLowerCase());
    if (!id || usedIds.has(id)) {
      id = nextId();
      if (!idByName.has(name.toLowerCase())) idByName.set(name.toLowerCase(), id);
    }
    usedIds.add(id);
    const rec: ClientYear = { id, name, serial: '', billNo: '', bills: [] };
    for (const e of await c.list()) {
      if (e.kind === 'file' && e.name === serialName) rec.serial = decodeCipherValue(await c.read(e.name));
      else if (e.kind === 'file' && e.name === billNoName) rec.billNo = decodeCipherValue(await c.read(e.name));
      else if (e.kind === 'directory' && typeOf.has(e.name)) {
        const t = await c.dir(e.name);
        for (const f of await t.list()) {
          if (f.kind === 'file' && /\.txt$/i.test(f.name) && f.name.toLowerCase() !== JAVA_TEMP) {
            const bill: StoredBill = { type: typeOf.get(e.name)!, name: f.name.slice(0, -4), groups: groupsFromLines(decodeCipherLines(await t.read(f.name))) };
            rec.bills.push(bill);
            bills++;
            onProgress?.(`Copying… ${bills} bills`);
          } else await extra(t, [...path, e.name, f.name], f.kind);
        }
      } else await extra(c, [...path, e.name], e.kind);
    }
    await writeFile(await ensureDir(years, year), `${id}.json`, encodeJson(rec));
    clients++;
  };

  if (data) {
    const billsName = (await findEntry(data, BILLS, 'directory'))?.name;
    const locksName = (await findEntry(data, LOCKS, 'file'))?.name;
    for (const e of await data.list()) {
      if (e.kind === 'file' && e.name === locksName) {
        openInDesktop.push(...decodePlainLines(await data.read(e.name)).filter((l) => l.trim() !== ''));
      } else if (e.kind === 'directory' && e.name === billsName) {
        const b = await data.dir(e.name);
        for (const y of await b.list()) {
          if (y.kind === 'directory' && isYear(y.name)) {
            const yd = await b.dir(y.name);
            await ensureDir(years, y.name);
            yearCount++;
            const usedIds = new Set<string>();
            for (const c of await yd.list()) {
              if (c.kind === 'directory') await client(yd, y.name, c.name, [e.name, y.name, c.name], usedIds);
              else await extra(yd, [e.name, y.name, c.name], c.kind);
            }
          } else await extra(b, [e.name, y.name], y.kind);
        }
      } else await extra(data, [e.name], e.kind);
    }
  }

  const settings: Settings = {
    format: FORMAT,
    version: VERSION,
    password: await hashPassword(password),
    letterhead: letterheadFromImpinfo(impinfo),
    billTypes: types,
    dropdowns: dropdownsFromLines(await readDropdownLines(program)),
    autoBackup: await readBackupPath(program),
    desktop: { impinfoExtra: (impinfo ?? []).slice(4), extras },
    migratedFrom: { at: new Date().toISOString(), folder: src.program.name, data: src.dataLabel ?? src.data?.name ?? '' },
  };
  // Written last: a copy that stopped half way cannot be opened by mistake.
  await writeFile(dest, MANIFEST, encodeJson(settings));

  onProgress?.('Checking the copy…');
  const report = await verify(src, new WebBooks(dest), { onProgress });
  return { years: yearCount, clients, bills, extras, openInDesktop, report };
}

export interface ExportResult {
  /** Kept files whose client is no longer there: put in "Other files" next to data. */
  relocated: string[];
  report: VerifyReport;
}

export const OTHER_FILES = 'Other files';

/**
 * Writes the web data into `dest` (an empty folder) in the desktop layout:
 * the program files (pass.txt, impinfo.txt…) and data\bills\…, then compares the two.
 * `password` must be the current password (pass.txt stores it).
 */
export async function exportToDesktop(web: WebBooks, dest: FsDir, password: string, onProgress?: Progress): Promise<ExportResult> {
  await assertEmpty(dest, [web.root]);
  if (!(await web.checkPassword(password))) throw new UserError('The password is wrong.');
  const s = await web.settings();

  await writeFile(dest, FILES.pass, encodeCipherValue(password));
  const impinfo = [formatBillTypes(s.billTypes), ...(s.letterhead ? [...letterheadLines(s.letterhead), ...s.desktop.impinfoExtra] : [])];
  await writeFile(dest, FILES.impinfo, encodeCipherLines(impinfo));
  await writeFile(dest, FILES.ddown, encodePlainLines(dropdownLines(s.dropdowns)));
  await writeFile(dest, FILES.backupto, encodeCipherValue(s.autoBackup));
  await writeFile(dest, FILES.loaddatafrom, encodePlain(''));

  const data = await ensureDir(dest, 'data');
  await writeFile(data, LOCKS, new Uint8Array());
  const bills = await ensureDir(data, BILLS);
  let n = 0;
  for (const year of await web.years()) {
    const y = await ensureDir(bills, year);
    for (const rec of await web.records(year)) {
      const c = await y.dir(rec.name, true);
      await writeFile(c, SERIAL, encodeCipherValue(rec.serial));
      await writeFile(c, BILLNO, encodeCipherValue(rec.billNo));
      for (const t of s.billTypes) await ensureDir(c, t.folder);
      for (const b of rec.bills) {
        await writeFile(await ensureDir(c, b.type), `${b.name}.txt`, encodeCipherLines(linesFromGroups(b.groups)));
        n++;
        onProgress?.(`Writing… ${n} bills`);
      }
    }
  }

  // Kept files go back where they were, unless their folder is gone (a deleted or renamed client).
  const relocated: string[] = [];
  const kept = await tryDir(web.root, EXTRAS);
  for (const p of s.desktop.extras) {
    const parts = p.split('/');
    let from: FsDir | null = kept;
    for (const x of parts.slice(0, -1)) from = from ? await tryDir(from, x) : null;
    const last = parts[parts.length - 1];
    const e = from ? await findEntry(from, last) : null;
    if (!from || !e) continue;
    let to: FsDir | null = data;
    for (const x of parts.slice(0, -1)) to = to ? await tryDir(to, x) : null;
    if (!to) {
      relocated.push(p);
      to = await ensureDir(dest, OTHER_FILES);
      for (const x of parts.slice(0, -1)) to = await ensureDir(to, x);
    }
    await keep(from, e.name, e.kind, to);
  }

  // Rows the desktop version could not open get trailing spaces, as when the web app saves desktop files.
  onProgress?.('Preparing the bills for the desktop version…');
  await new Workspace(dest, data).protectAll();

  onProgress?.('Checking the export…');
  const report = await verify({ program: dest, data }, web, { relocated, onProgress });
  return { relocated, report };
}

/** True when `inner` is `outer` or inside it. */
export async function isInside(outer: FsDir, inner: FsDir): Promise<boolean> {
  return outer.resolve ? (await outer.resolve(inner)) !== null : false;
}

