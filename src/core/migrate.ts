// Moving between the desktop (Java) layout and the web format, always into a
// new, empty folder: the folder copied from is only read (see readOnly).
//
// Migration: desktop folder -> web format. Bills, clients, S.No., Bill No.,
// letterhead, tabs, drop-down lists, password and auto-backup folder become the
// web format; every other file in the data folder is kept byte for byte
// (encrypted, like everything else). Export does the reverse. Both are checked.

import { decodeCipherLines, decodeCipherValue, decodePlainLines, encodeCipherLines, encodeCipherValue, encodePlain, encodePlainLines } from './codec';
import { FILES, formatBillTypes, letterheadFromImpinfo, letterheadLines, readBackupPath, readDropdownLines, readImpinfo, readPassword } from './config';
import { DataKey } from './crypto';
import { FsDir, ensureDir, findEntry, pick, readOnly, tryDir, writeFile } from './fs';
import { UserError } from './names';
import {
  ClientYear, ExtraFile, Settings, StoredBill, WebBooks, billIdFor, dropdownLines, dropdownsFromLines, encodeRecord, extraPath, groupsFromLines,
  linesFromGroups, newId, newKeys, newManifest, recordPath, writeManifest, writeSettings,
} from './webstore';
import { BILLNO, BILLS, JAVA_TEMP, LOCKS, SERIAL, desktopBillTypes } from './desktop';
import { protectForJava } from './bill';
import { isYear, previousYears } from './years';

import { VerifyReport, verify } from './verify';
import { Vault } from './vault';
import { mapLimit } from './util';

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
  /** Opens the copy if the password is forgotten; shown once. */
  recoveryCode: string;
  report: VerifyReport;
  books: WebBooks;
}

/** True when `inner` is `outer` or inside it. */
export async function isInside(outer: FsDir, inner: FsDir): Promise<boolean> {
  return outer.resolve ? (await outer.resolve(inner)) !== null : false;
}

async function assertEmpty(dest: FsDir, outside: (FsDir | null)[]): Promise<void> {
  for (const o of outside) {
    if (o && (await isInside(o, dest))) throw new UserError(`Choose a folder outside ${o.name}, so that it stays exactly as it is.`);
  }
  if ((await dest.list()).length > 0) throw new UserError(`The folder ${dest.name} is not empty. Choose an empty folder.`);
}

/**
 * Copies a desktop installation into `dest` (an empty folder) in the web format,
 * then compares the two. The desktop folders are never written to.
 * `password` is used when the desktop folder has none (no pass.txt).
 */
export async function migrateDesktop(
  src: DesktopFolders,
  dest: FsDir,
  opts: { password?: string; iterations?: number; onProgress?: Progress } = {},
): Promise<MigrationResult> {
  const onProgress = opts.onProgress;
  const program = readOnly(src.program);
  const data = src.data ? readOnly(src.data) : null;
  await assertEmpty(dest, [src.program, src.data]);
  const password = (await readPassword(program)) ?? opts.password;
  if (password === undefined) throw new UserError('This folder has no password (pass.txt). Choose one for the copy.');

  const key = await DataKey.generate();
  const vault = new Vault(dest, key);
  const impinfo = await readImpinfo(program);
  const types = await desktopBillTypes(program, data);
  const extras: string[] = [];
  const files: ExtraFile[] = [];
  const openInDesktop: string[] = [];
  const idByName = new Map<string, string>();
  let clients = 0;
  let bills = 0;
  let yearCount = 0;
  await vault.dir(['years'], true);

  // Kept files are stored one by one, encrypted, under names that say nothing.
  const keepTree = async (from: FsDir, name: string, kind: 'file' | 'directory', path: string): Promise<void> => {
    if (kind === 'file') {
      const blob = newId();
      await vault.write(extraPath(blob), await from.read(name));
      files.push({ path, blob });
      return;
    }
    const d = await from.dir(name);
    for (const e of await d.list()) await keepTree(d, e.name, e.kind, `${path}/${e.name}`);
  };
  const extra = async (from: FsDir, path: string[], kind: 'file' | 'directory') => {
    await keepTree(from, path[path.length - 1], kind, path.join('/'));
    extras.push(path.join('/'));
  };

  /** The id of a client: the same as in the other years for the same name (unless taken this year). */
  const idOf = (name: string, usedIds: Set<string>) => {
    let id = idByName.get(name.toLowerCase());
    if (!id || usedIds.has(id)) {
      id = newId();
      if (!idByName.has(name.toLowerCase())) idByName.set(name.toLowerCase(), id);
    }
    usedIds.add(id);
    return id;
  };

  const client = async (yearDir: FsDir, year: string, name: string, path: string[], id: string) => {
    const c = await yearDir.dir(name);
    const entries = await c.list();
    const serialName = pick(entries, SERIAL, 'file')?.name;
    const billNoName = pick(entries, BILLNO, 'file')?.name;
    const typeOf = new Map<string, string>();
    for (const t of types) {
      const e = pick(entries, t.folder, 'directory');
      if (e && !typeOf.has(e.name)) typeOf.set(e.name, t.folder);
    }
    const rec: ClientYear = { v: 1, id, name, serial: '', billNo: '', bills: [] };
    for (const e of entries) {
      if (e.kind === 'file' && e.name === serialName) rec.serial = decodeCipherValue(await c.read(e.name));
      else if (e.kind === 'file' && e.name === billNoName) rec.billNo = decodeCipherValue(await c.read(e.name));
      else if (e.kind === 'directory' && typeOf.has(e.name)) {
        const t = await c.dir(e.name);
        const type = typeOf.get(e.name)!;
        for (const f of await t.list()) {
          if (f.kind === 'file' && /\.txt$/i.test(f.name) && f.name.toLowerCase() !== JAVA_TEMP) {
            const billName = f.name.slice(0, -4);
            // The same bill in every year gets the same id, so earlier years stay linked.
            const bill: StoredBill = { id: billIdFor(id, type, billName), type, name: billName, groups: groupsFromLines(decodeCipherLines(await t.read(f.name))) };
            if (rec.bills.some((b) => b.id === bill.id)) bill.id = newId();
            rec.bills.push(bill);
            bills++;
            onProgress?.(`Copying… ${bills} bills`);
          } else await extra(t, [...path, e.name, f.name], f.kind);
        }
      } else await extra(c, [...path, e.name], e.kind);
    }
    await vault.write(recordPath(year, id), encodeRecord(rec));
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
            await vault.dir(['years', y.name], true);
            yearCount++;
            const usedIds = new Set<string>();
            const entries = await yd.list();
            for (const c of entries) if (c.kind !== 'directory') await extra(yd, [e.name, y.name, c.name], c.kind);
            const clients = entries.filter((c) => c.kind === 'directory').map((c) => ({ name: c.name, id: idOf(c.name, usedIds) }));
            await mapLimit(clients, 8, (c) => client(yd, y.name, c.name, [e.name, y.name, c.name], c.id));
          } else await extra(b, [e.name, y.name], y.kind);
        }
      } else await extra(data, [e.name], e.kind);
    }
  }

  const settings: Settings = {
    letterhead: letterheadFromImpinfo(impinfo),
    billTypes: types,
    dropdowns: dropdownsFromLines(await readDropdownLines(program)),
    autoBackup: await readBackupPath(program),
    desktop: { impinfoExtra: (impinfo ?? []).slice(4), extras, files },
    migratedFrom: { at: new Date().toISOString(), folder: src.program.name, data: src.dataLabel ?? src.data?.name ?? '' },
  };
  await writeSettings(vault, settings);
  const { keys, recoveryCode } = await newKeys(key, password, opts.iterations);
  // Written last: a copy that stopped half way cannot be opened by mistake.
  await writeManifest(dest, newManifest(keys));

  onProgress?.('Checking the copy…');
  const books = new WebBooks(vault, { iterations: opts.iterations });
  const report = await verify(src, books, { onProgress });
  return { years: yearCount, clients, bills, extras, openInDesktop, recoveryCode, report, books };
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
 * `password` must be the current password (pass.txt stores it). The result is
 * not encrypted: the desktop version cannot read encrypted files.
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

  // The folder is new and empty and every name is distinct, so files are written directly.
  const data = await dest.dir('data', true);
  await data.write(LOCKS, new Uint8Array());
  const bills = await data.dir(BILLS, true);
  let n = 0;
  // Each bill as written, by year and "client|type|bill": the Java program compares a bill with the
  // same bill (by name, ignoring case) of the three years before.
  const written = new Map<string, Map<string, string[]>>();
  const key = (client: string, type: string, bill: string) => `${client}|${type}|${bill}`.toLowerCase();
  for (const year of await web.years()) {
    const y = await bills.dir(year, true);
    const these = new Map<string, string[]>();
    written.set(year, these);
    const earlier = previousYears(year, 3).map((p) => written.get(p));
    await mapLimit(await web.records(year), 8, async (rec) => {
      const c = await y.dir(rec.name, true);
      await c.write(SERIAL, encodeCipherValue(rec.serial));
      await c.write(BILLNO, encodeCipherValue(rec.billNo));
      const typeDirs = new Map<string, FsDir>();
      for (const t of s.billTypes) typeDirs.set(t.folder, await c.dir(t.folder, true));
      for (const b of rec.bills) {
        const k = key(rec.name, b.type, b.name);
        // Rows the desktop version could not open get trailing spaces (see protectForJava).
        const lines = protectForJava(linesFromGroups(b.groups), earlier.map((m) => m?.get(k) ?? null));
        these.set(k, lines);
        const td = typeDirs.get(b.type) ?? (await c.dir(b.type, true));
        await td.write(`${b.name}.txt`, encodeCipherLines(lines));
        n++;
        onProgress?.(`Writing… ${n} bills`);
      }
    });
  }

  // Kept files go back where they were, unless their folder is gone (a deleted or renamed client).
  const relocated: string[] = [];
  for (const item of s.desktop.extras) {
    const parts = item.split('/');
    let container: FsDir | null = data;
    for (const x of parts.slice(0, -1)) container = container ? await tryDir(container, x) : null;
    const base = container ? data : await ensureDir(dest, OTHER_FILES);
    if (!container) relocated.push(item);
    for (const f of s.desktop.files.filter((x) => x.path === item || x.path.startsWith(`${item}/`))) {
      const p = f.path.split('/');
      let d = base;
      for (const x of p.slice(0, -1)) d = await ensureDir(d, x);
      const bytes = await web.readExtra(f);
      if (bytes) await writeFile(d, p[p.length - 1], bytes);
    }
  }

  onProgress?.('Checking the export…');
  const report = await verify({ program: dest, data }, web, { relocated, onProgress });
  return { relocated, report };
}
