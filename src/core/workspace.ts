// All operations on the data folder:
//   <data>/activelocation.txt               "year,NAME" per open client (plain)
//   <data>/bills/<YY-YY>/<CLIENT>/serialno.txt   S.No. (shifted, no newline)
//   <data>/bills/<YY-YY>/<CLIENT>/billfromto.txt Bill No. (shifted, no newline)
//   <data>/bills/<YY-YY>/<CLIENT>/<TypeFolder>/<BILL>.txt  bill rows (shifted)

import {
  decodeCipherLines, decodeCipherValue, decodePlainLines, encodeCipherLines, encodeCipherValue, encodePlainLines,
} from './codec';
import {
  BillType, Letterhead, billTypesFromImpinfo, dropdownItems, letterheadFromImpinfo, readBackupPath, readDropdownLines, readImpinfo,
  readPassword, writeBackupPath, writeBillTypes, writeDropdowns, writeLetterhead, writePassword,
} from './config';
import {
  FsDir, copyTree, ensureDir, findEntry, listDirs, listFiles, removeEntry, tryDir, tryRead, walk, writeFile,
} from './fs';
import { BillRow, HistoryColumn, historyColumns, linesFromRows, mergeHistory, protectForJava, rowsFromLines } from './bill';
import { SerialEntry, planInsert, planRemove, planRename } from './serial';
import { compareIgnoreCase, sameName, sortNames, sortStrings } from './sort';
import { isYear, nextYear, previousYear, previousYears } from './years';
import { UserError, checkName, checkTabName } from './names';

export interface CheckResult {
  checked: number;
  fixed: number;
}

export const BILLS = 'bills';
export const LOCKS = 'activelocation.txt';
const SERIAL = 'serialno.txt';
const BILLNO = 'billfromto.txt';
// Temporary file name used by the Java program while merging bills.
const JAVA_TEMP = '1q2m.txt';

export interface Client {
  name: string;
  serial: string;
  billNo: string;
}

export { UserError, checkName };

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

/** Bill-type folders found in the clients of the most recent year that has any. */
export async function billTypeFoldersOnDisk(data: FsDir): Promise<string[]> {
  const bills = await tryDir(data, BILLS);
  if (!bills) return [];
  const found: string[] = [];
  for (const year of sortStrings((await listDirs(bills)).filter(isYear)).reverse()) {
    const y = await bills.dir(year);
    for (const c of await listDirs(y)) {
      for (const f of await listDirs(await y.dir(c))) if (!found.some((x) => sameName(x, f))) found.push(f);
    }
    if (found.length) break;
  }
  return found;
}

/** The bill types of a desktop folder; when impinfo.txt lists none, the folders on disk (see repairBillTypes). */
export async function desktopBillTypes(program: FsDir, data: FsDir | null): Promise<BillType[]> {
  const types = billTypesFromImpinfo(await readImpinfo(program));
  if (types.length || !data) return types;
  return (await billTypeFoldersOnDisk(data)).map((f) => ({ folder: f, tab: f }));
}

/** The desktop (Java) program's own files: see the layout above and core/config.ts. */
export class Workspace {
  readonly kind = 'desktop' as const;
  constructor(readonly program: FsDir, readonly data: FsDir) {}

  // ---------- configuration ----------

  async billTypes(): Promise<BillType[]> {
    return billTypesFromImpinfo(await readImpinfo(this.program));
  }

  /**
   * Restores the bill-type line of impinfo.txt from the folders on disk when it
   * is empty (the Java registration "Cancel" button wiped it). Returns true if repaired.
   */
  async repairBillTypes(): Promise<boolean> {
    const lines = await readImpinfo(this.program);
    if (!lines || billTypesFromImpinfo(lines).length > 0) return false;
    const found = await billTypeFoldersOnDisk(this.data);
    if (!found.length) return false;
    await writeBillTypes(this.program, found.map((f) => ({ folder: f, tab: f })));
    return true;
  }

  async dropdown(tab: string, year: string): Promise<string[]> {
    return dropdownItems(await readDropdownLines(this.program), tab).map((s) => s.split('##').join(year));
  }

  async saveDropdowns(types: BillType[], lists: Map<string, string[]>): Promise<void> {
    await writeDropdowns(this.program, types, lists);
  }

  async letterhead(): Promise<Letterhead | null> {
    return letterheadFromImpinfo(await readImpinfo(this.program));
  }

  async saveLetterhead(lh: Letterhead): Promise<void> {
    await writeLetterhead(this.program, lh);
  }

  async checkPassword(password: string): Promise<boolean> {
    return (await readPassword(this.program)) === password;
  }

  async setPassword(password: string): Promise<void> {
    await writePassword(this.program, password);
  }

  async backupPath(): Promise<string> {
    return readBackupPath(this.program);
  }

  async setBackupPath(path: string): Promise<void> {
    await writeBackupPath(this.program, path);
  }

  // ---------- years ----------

  async billsDir(): Promise<FsDir> {
    return ensureDir(this.data, BILLS);
  }

  async years(): Promise<string[]> {
    return sortStrings((await listDirs(await this.billsDir())).filter(isYear));
  }

  async yearDir(year: string): Promise<FsDir> {
    const d = await tryDir(await this.billsDir(), year);
    if (!d) throw new UserError(`Year ${year} does not exist.`);
    return d;
  }

  async addYear(year: string): Promise<void> {
    if (!isYear(year)) throw new UserError('Year must look like 26-27.');
    await ensureDir(await this.billsDir(), year);
    await this.touch();
  }

  /** Adds the year after the last one (Utility > Add Next Year). Returns it. */
  async addNextYear(): Promise<string> {
    const years = await this.years();
    if (years.length === 0) throw new UserError('There is no year yet; add the first year.');
    const next = nextYear(years[years.length - 1]);
    if (!next) throw new UserError('Cannot add a year after 99.');
    await this.addYear(next);
    return next;
  }

  // ---------- clients ----------

  async clientNames(year: string): Promise<string[]> {
    return sortStrings(await listDirs(await this.yearDir(year)));
  }

  async clients(year: string): Promise<Client[]> {
    const y = await this.yearDir(year);
    const names = sortStrings(await listDirs(y));
    return mapLimit(names, 16, async (name) => {
      const d = await y.dir(name);
      const [s, b] = await Promise.all([tryRead(d, SERIAL), tryRead(d, BILLNO)]);
      return { name, serial: s ? decodeCipherValue(s) : '', billNo: b ? decodeCipherValue(b) : '' };
    });
  }

  async clientExists(year: string, name: string): Promise<boolean> {
    const y = await tryDir(await this.billsDir(), year);
    return !!y && (await findEntry(y, name, 'directory')) !== null;
  }

  async clientDir(year: string, name: string): Promise<FsDir> {
    const d = await tryDir(await this.yearDir(year), name);
    if (!d) throw new UserError(`${name} does not exist in ${year}.`);
    return d;
  }

  private async serialEntries(year: string, except?: string): Promise<SerialEntry[]> {
    return (await this.clients(year)).filter((c) => !(except && c.name === except)).map((c) => ({ name: c.name, serial: c.serial }));
  }

  private async applySerialUpdates(year: string, updates: Map<string, string>): Promise<void> {
    const y = await this.yearDir(year);
    for (const [name, serial] of updates) {
      await writeFile(await y.dir(name), SERIAL, encodeCipherValue(serial));
    }
  }

  async setBillNo(year: string, name: string, billNo: string): Promise<void> {
    await writeFile(await this.clientDir(year, name), BILLNO, encodeCipherValue(billNo));
    await this.touch();
  }

  async setSerial(year: string, name: string, serial: string): Promise<void> {
    await writeFile(await this.clientDir(year, name), SERIAL, encodeCipherValue(serial));
  }

  /** Creates the client folder with every bill-type folder, bill no. and serial. */
  private async createClientFolder(year: string, name: string, billNo: string, serial: string): Promise<FsDir> {
    const d = await ensureDir(await this.yearDir(year), name);
    for (const t of await this.billTypes()) await ensureDir(d, t.folder);
    await writeFile(d, BILLNO, encodeCipherValue(billNo));
    await writeFile(d, SERIAL, encodeCipherValue(serial));
    return d;
  }

  /**
   * Utility "Add New": creates a client with the next serial number (or a
   * lettered one for a late entry) and brings in bills from earlier years.
   */
  async addClient(year: string, rawName: string, late: boolean): Promise<Client> {
    const name = checkName(rawName).toUpperCase();
    const entries = await this.serialEntries(year);
    if (entries.some((e) => sameName(e.name, name))) throw new UserError('This name already exists.');
    const plan = planInsert(entries, name, late);
    await this.applySerialUpdates(year, plan.updates);
    await this.createClientFolder(year, name, '', plan.serial);
    const prev = previousYear(year);
    if (prev) await this.copyClientContent(prev, year, name, { copySerial: false });
    await this.touch();
    return { name, serial: plan.serial, billNo: (await this.clients(year)).find((c) => c.name === name)?.billNo ?? '' };
  }

  /** Removes a client folder and renumbers the clients after it. */
  async deleteClient(year: string, name: string): Promise<void> {
    const entries = await this.serialEntries(year);
    await this.applySerialUpdates(year, planRemove(entries, name));
    await removeEntry(await this.yearDir(year), name);
  }

  async deleteClients(year: string, names: string[]): Promise<void> {
    for (const n of names) await this.deleteClient(year, n);
    await this.touch();
  }

  /**
   * Utility "Modify": optionally renames the client (re-sorting its serial
   * number like Add New, or merging into an existing client of that name) and
   * sets the bill no.
   */
  async modifyClient(year: string, oldName: string, rawNewName: string, billNo: string, late: boolean): Promise<string> {
    const newName = checkName(rawNewName).toUpperCase();
    if (newName === oldName) {
      await this.setBillNo(year, oldName, billNo);
      return oldName;
    }
    const y = await this.yearDir(year);
    const src = await this.clientDir(year, oldName);
    const existing = (await this.clientNames(year)).find((n) => n !== oldName && sameName(n, newName));
    if (existing) {
      // Merge into the existing client: its serial stays, bills are moved over.
      const dest = await y.dir(existing);
      await this.moveBills(src, dest);
      await this.deleteClient(year, oldName);
      await writeFile(dest, BILLNO, encodeCipherValue(billNo));
      await this.protectClient(year, existing);
      await this.touch();
      return existing;
    }
    const plan = planRename(await this.serialEntries(year), oldName, newName, late);
    await this.applySerialUpdates(year, plan.updates);
    const sameIgnoringCase = sameName(oldName, newName);
    // Case-only renames need a temporary name on case-insensitive disks.
    const tmpName = sameIgnoringCase ? `${newName}.renaming` : newName;
    const dest = await y.dir(tmpName, true);
    await copyTree(src, dest);
    await y.remove(oldName);
    let final = dest;
    if (sameIgnoringCase) {
      final = await y.dir(newName, true);
      await copyTree(dest, final);
      await y.remove(tmpName);
    }
    for (const t of await this.billTypes()) await ensureDir(final, t.folder);
    await writeFile(final, SERIAL, encodeCipherValue(plan.serial));
    await writeFile(final, BILLNO, encodeCipherValue(billNo));
    await this.protectClient(year, newName);
    await this.touch();
    return newName;
  }

  private async moveBills(src: FsDir, dest: FsDir): Promise<void> {
    for (const t of await this.billTypes()) {
      const from = await tryDir(src, t.folder);
      const to = await ensureDir(dest, t.folder);
      if (from) await copyTree(from, to);
    }
  }

  // ---------- bills ----------

  private async typeDir(year: string, client: string, folder: string, create = false): Promise<FsDir | null> {
    const c = await walk(await this.billsDir(), [year, client]);
    if (!c) return null;
    return create ? ensureDir(c, folder) : tryDir(c, folder);
  }

  async bills(year: string, client: string, folder: string): Promise<string[]> {
    const d = await this.typeDir(year, client, folder);
    if (!d) return [];
    const files = (await listFiles(d)).filter((f) => /\.txt$/i.test(f) && f.toLowerCase() !== JAVA_TEMP);
    return sortStrings(files).map((f) => f.slice(0, -4));
  }

  async readBillLines(year: string, client: string, folder: string, bill: string): Promise<string[] | null> {
    const d = await this.typeDir(year, client, folder);
    if (!d) return null;
    const b = await tryRead(d, `${bill}.txt`);
    return b === null ? null : decodeCipherLines(b);
  }

  async readBill(year: string, client: string, folder: string, bill: string): Promise<BillRow[]> {
    return rowsFromLines((await this.readBillLines(year, client, folder, bill)) ?? [], year);
  }

  async writeBill(year: string, client: string, folder: string, bill: string, rows: BillRow[]): Promise<void> {
    await this.saveLines(year, client, folder, bill, linesFromRows(rows, year));
  }

  /** The same bill in the three previous years (raw lines, null where there is none). */
  async historyLines(year: string, client: string, folder: string, bill: string): Promise<{ year: string; lines: string[] | null }[]> {
    return Promise.all(previousYears(year, 3).map(async (y) => ({ year: y, lines: await this.readBillLines(y, client, folder, bill) })));
  }

  /** Amounts of the same bill in the three previous years. */
  async billHistory(year: string, client: string, folder: string, bill: string, rows: BillRow[]): Promise<HistoryColumn[]> {
    return historyColumns(rows, year, await this.historyLines(year, client, folder, bill));
  }

  /** Utility "New Bill": creates an empty bill pre-filled with rows from earlier years. */
  async createBill(year: string, client: string, folder: string, rawName: string): Promise<string> {
    const name = checkName(rawName, 'Bill name').toUpperCase();
    const existing = await this.bills(year, client, folder);
    if (existing.some((b) => sameName(b, name))) throw new UserError('This bill name already exists.');
    const sources = await this.historySources(year, client, folder, name);
    await this.saveLines(year, client, folder, name, mergeHistory(sources));
    return name;
  }

  private async historySources(year: string, client: string, folder: string, bill: string, includeYear = false): Promise<string[][]> {
    const years = includeYear ? [year, ...previousYears(year, 2)] : previousYears(year, 3);
    const out: string[][] = [];
    for (const y of years) {
      const lines = await this.readBillLines(y, client, folder, bill);
      if (lines) out.push(lines);
    }
    return out;
  }

  async renameBill(year: string, client: string, folder: string, oldName: string, rawNewName: string): Promise<string> {
    const name = checkName(rawNewName, 'Bill name').toUpperCase();
    const d = await this.typeDir(year, client, folder);
    if (!d) throw new UserError('Bill not found.');
    if (name === oldName) return name;
    const others = (await this.bills(year, client, folder)).filter((b) => b !== oldName);
    if (others.some((b) => sameName(b, name))) throw new UserError('This bill name already exists.');
    const data = await d.read(`${oldName}.txt`);
    if (sameName(name, oldName)) {
      await d.write(`${name}.renaming.tmp`, data);
      await d.remove(`${oldName}.txt`);
      await d.write(`${name}.txt`, data);
      await d.remove(`${name}.renaming.tmp`);
    } else {
      await d.write(`${name}.txt`, data);
      await d.remove(`${oldName}.txt`);
    }
    await this.protectBill(year, client, folder, name);
    await this.protectFollowing(year, client, folder, name);
    return name;
  }

  async deleteBill(year: string, client: string, folder: string, bill: string): Promise<void> {
    const d = await this.typeDir(year, client, folder);
    if (d) await d.remove(`${bill}.txt`);
  }

  // ---------- keeping bills openable by the Java program ----------

  private async previousLines(year: string, client: string, folder: string, bill: string): Promise<(string[] | null)[]> {
    return Promise.all(previousYears(year, 3).map((y) => this.readBillLines(y, client, folder, bill)));
  }

  /** `lines` adjusted so the Java program can open the bill (see protectForJava). */
  private async protectLines(year: string, client: string, folder: string, bill: string, lines: string[]): Promise<string[]> {
    return protectForJava(lines, await this.previousLines(year, client, folder, bill));
  }

  /** Writes a bill (adjusted for the Java program) and re-checks the next three years' copies. */
  private async saveLines(year: string, client: string, folder: string, bill: string, lines: string[]): Promise<void> {
    const d = await this.typeDir(year, client, folder, true);
    await writeFile(d!, `${bill}.txt`, encodeCipherLines(await this.protectLines(year, client, folder, bill, lines)));
    await this.protectFollowing(year, client, folder, bill);
  }

  /** Re-checks one existing bill file; returns true if it had to be changed. */
  async protectBill(year: string, client: string, folder: string, bill: string): Promise<boolean> {
    const lines = await this.readBillLines(year, client, folder, bill);
    if (!lines) return false;
    const safe = protectForJava(lines, await this.previousLines(year, client, folder, bill));
    if (safe.every((l, i) => l === lines[i])) return false;
    const d = await this.typeDir(year, client, folder);
    await writeFile(d!, `${bill}.txt`, encodeCipherLines(safe));
    return true;
  }

  /** The next three years' copies of a bill treat this one as history. */
  private async protectFollowing(year: string, client: string, folder: string, bill: string): Promise<void> {
    let y: string | null = year;
    for (let i = 0; i < 3; i++) {
      y = y ? nextYear(y) : null;
      if (!y) return;
      await this.protectBill(y, client, folder, bill);
    }
  }

  private async protectClient(year: string, client: string): Promise<void> {
    for (const t of await this.billTypes()) {
      for (const b of await this.bills(year, client, t.folder)) {
        await this.protectBill(year, client, t.folder, b);
        await this.protectFollowing(year, client, t.folder, b);
      }
    }
  }

  /** Checks every bill of every year (oldest first) and fixes those the Java program could not open. */
  async protectAll(onProgress?: (r: CheckResult) => void, opts: { skipOpen?: boolean } = {}): Promise<CheckResult> {
    const r: CheckResult = { checked: 0, fixed: 0 };
    const types = await this.billTypes();
    // Clients open on a computer are left alone (their bills are about to be saved anyway).
    const open = opts.skipOpen ? await this.lockLines() : [];
    for (const year of await this.years()) {
      for (const client of await this.clientNames(year)) {
        if (open.some((l) => sameName(l, `${year},${client}`))) continue;
        for (const t of types) {
          for (const b of await this.bills(year, client, t.folder)) {
            if (await this.protectBill(year, client, t.folder, b)) r.fixed++;
            r.checked++;
            onProgress?.(r);
          }
        }
      }
    }
    return r;
  }

  // ---------- copying clients between years ----------

  /**
   * Copies a client's bills from `from` (merging in the two years before it)
   * into `to`, plus its bill no. and, optionally, its serial number.
   */
  async copyClientContent(from: string, to: string, name: string, opts: { copySerial: boolean }): Promise<void> {
    const src = await walk(await this.billsDir(), [from, name]);
    const destYear = await this.yearDir(to);
    const destEntry = await findEntry(destYear, name, 'directory');
    const dest = await destYear.dir(destEntry ? destEntry.name : name, true);
    const years = [from, ...previousYears(from, 2)];
    for (const t of await this.billTypes()) {
      const destType = await ensureDir(dest, t.folder);
      const billNames: string[] = [];
      for (const y of years) {
        for (const b of await this.bills(y, name, t.folder)) if (!billNames.some((x) => sameName(x, b))) billNames.push(b);
      }
      for (const b of billNames) {
        const sources: string[][] = [];
        for (const y of years) {
          const lines = await this.readBillLines(y, name, t.folder, b);
          if (lines) sources.push(lines);
        }
        await writeFile(destType, `${b}.txt`, encodeCipherLines(await this.protectLines(to, name, t.folder, b, mergeHistory(sources))));
        await this.protectFollowing(to, name, t.folder, b);
      }
    }
    if (src) {
      const billNo = await tryRead(src, BILLNO);
      if (billNo) await writeFile(dest, BILLNO, billNo);
      if (opts.copySerial) {
        const serial = await tryRead(src, SERIAL);
        if (serial) await writeFile(dest, SERIAL, serial);
      }
    }
    if (!(await findEntry(dest, BILLNO, 'file'))) await writeFile(dest, BILLNO, encodeCipherValue(''));
    if (!(await findEntry(dest, SERIAL, 'file'))) await writeFile(dest, SERIAL, encodeCipherValue(''));
  }

  /** Splits `from`'s clients into those missing in `to` and those already there. */
  async planCopy(from: string, to: string): Promise<{ fresh: Client[]; collided: Client[] }> {
    const src = await this.clients(from);
    const dest = await this.clientNames(to);
    const fresh: Client[] = [];
    const collided: Client[] = [];
    for (const c of src) (dest.some((d) => sameName(d, c.name)) ? collided : fresh).push(c);
    return { fresh, collided };
  }

  /** Utility "Copy Data": copies clients (serial and bill no. included); collided ones are replaced. */
  async copyClients(from: string, to: string, names: string[], onProgress?: (done: number) => void): Promise<void> {
    if (from === to) throw new UserError('Choose two different years.');
    const destNames = await this.clientNames(to);
    let done = 0;
    for (const name of names) {
      const old = destNames.find((d) => sameName(d, name));
      if (old) await (await this.yearDir(to)).remove(old);
      await this.copyClientContent(from, to, name, { copySerial: true });
      onProgress?.(++done);
    }
    await this.touch();
  }

  /** "Update bill to next year" when leaving a client that is missing in the next year. */
  async copyClientToNextYear(year: string, name: string): Promise<string | null> {
    const next = nextYear(year);
    if (!next || !(await this.years()).includes(next)) return null;
    await this.copyClientContent(year, next, name, { copySerial: true });
    await this.touch();
    return next;
  }

  // ---------- bill types (tabs) ----------

  async addBillType(rawName: string): Promise<void> {
    const types = await this.billTypes();
    const name = checkTabName(rawName, types);
    const bills = await this.billsDir();
    for (const year of await listDirs(bills)) {
      if (!isYear(year)) continue;
      const y = await bills.dir(year);
      for (const client of await listDirs(y)) await ensureDir(await y.dir(client), name);
    }
    await writeBillTypes(this.program, [...types, { folder: name, tab: name }]);
  }

  // ---------- locks (activelocation.txt) ----------

  private async lockLines(): Promise<string[]> {
    const b = await tryRead(this.data, LOCKS);
    return b ? decodePlainLines(b).filter((l) => l.trim() !== '') : [];
  }

  async isLocked(year: string, name: string): Promise<boolean> {
    const key = `${year},${name}`;
    return (await this.lockLines()).some((l) => sameName(l, key));
  }

  async lock(year: string, name: string): Promise<void> {
    const lines = await this.lockLines();
    const key = `${year},${name}`;
    if (!lines.some((l) => sameName(l, key))) lines.push(key);
    await writeFile(this.data, LOCKS, encodePlainLines(lines));
  }

  async unlock(year: string, name: string): Promise<void> {
    const key = `${year},${name}`;
    const lines = await this.lockLines();
    const kept = lines.filter((l) => !sameName(l, key));
    if (kept.length !== lines.length || !(await findEntry(this.data, LOCKS, 'file'))) {
      await writeFile(this.data, LOCKS, encodePlainLines(kept));
    }
  }

  // ---------- backup ----------

  /** Copies the data (bills and an empty activelocation.txt) into `dest`. */
  async backupTo(dest: FsDir, onFile?: () => void): Promise<void> {
    await writeFile(dest, LOCKS, new Uint8Array());
    await copyTree(await this.billsDir(), await ensureDir(dest, BILLS), onFile);
  }

  /** Lets Java instances (which watch the bills folder's modified time) refresh their lists. */
  async touch(): Promise<void> {
    try {
      const bills = await this.billsDir();
      const name = '~refresh';
      await bills.dir(name, true);
      await bills.remove(name);
    } catch {
      // Best effort only.
    }
  }
}

/** Folder name for an automatic backup, as the Java program names it: 01.11.2026+3.5.9PM */
export function backupFolderName(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const h = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${dd}.${mm}.${d.getFullYear()}+${h}.${d.getMinutes()}.${d.getSeconds()}${ampm}`;
}

export function dateString(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export { compareIgnoreCase, sortNames };
