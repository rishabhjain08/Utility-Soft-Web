// The web app's own data format (described in docs/data-format.md): one folder of plain JSON.
//
//   <folder>/utility-soft.json         settings: password (hashed), letterhead, bill types, drop-down lists
//   <folder>/years/<YY-YY>/<id>.json   one client in one year: name, S.No., Bill No. and all its bills
//   <folder>/open/<YY-YY> <NAME>.lock  clients open on a computer right now
//   <folder>/desktop-extras/...        files of the desktop folder that the app does not use, kept as they were
//
// A client keeps the same id from year to year, so its bills of earlier years
// stay linked to it even after it is renamed.
// Everything stored here can be written back in the desktop (Java) layout
// (core/migrate.ts), so text follows the same rules as there.

import { sanitize } from './codec';
import {
  BillType, DEFAULT_BILL_TYPES, DEFAULT_DROPDOWNS, Letterhead, cleanLetterhead, dropdownItems, mergeDropdowns,
} from './config';
import { FsDir, copyTree, ensureDir, findEntry, listDirs, listFiles, removeEntry, tryDir, tryRead, writeFile } from './fs';
import { BillRow, HistoryColumn, SEPARATOR, historyColumns, linesFromRows, mergeHistory, parseBillLine, rowsFromLines } from './bill';
import { UserError, checkName, checkTabName } from './names';
import { SerialEntry, planInsert, planRemove, planRename } from './serial';
import { sameName, sortNames, sortStrings } from './sort';
import { isYear, nextYear, previousYear, previousYears } from './years';
import { Client, mapLimit } from './workspace';

export const MANIFEST = 'utility-soft.json';
export const FORMAT = 'utility-soft';
export const VERSION = 1;
const YEARS = 'years';
const OPEN = 'open';
export const EXTRAS = 'desktop-extras';

export interface PasswordHash {
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  hash: string;
}

/** One line of ddown.txt: a tab title and its entries (as stored, possibly with empty ones). */
export interface DropdownList {
  tab: string;
  items: string[];
}

export interface Settings {
  format: string;
  version: number;
  password: PasswordHash;
  /** null until it is filled in (the first run asks for it). */
  letterhead: Letterhead | null;
  billTypes: BillType[];
  dropdowns: DropdownList[];
  /** Folder for the backup made when exiting ('' for none); a path or folder name. */
  autoBackup: string;
  /** Things only the desktop version uses, kept so that exporting gives them back. */
  desktop: {
    /** impinfo.txt lines after the letterhead. */
    impinfoExtra: string[];
    /** Paths (inside the desktop data folder, joined with /) of the files and folders kept in desktop-extras. */
    extras: string[];
  };
  migratedFrom?: { at: string; folder: string; data: string };
}

export interface Row {
  /** Text as stored: the bill's own year is written ##. */
  text: string;
  amount: string;
}

/** Rows printed together with their own subtotal (the desktop version separates them with "New Name" rows). */
export interface Group {
  rows: Row[];
}

export interface StoredBill {
  /** Bill type (its folder name in the desktop layout). */
  type: string;
  name: string;
  groups: Group[];
}

export interface ClientYear {
  id: string;
  name: string;
  serial: string;
  billNo: string;
  bills: StoredBill[];
}

// ---------- bills as desktop lines ----------

const SEPARATOR_LINE = `${SEPARATOR},New`;

/** Groups of a bill from its desktop lines ("text,amount"; "New Name" rows start a group). */
export function groupsFromLines(lines: string[]): Group[] {
  const groups: Group[] = [{ rows: [] }];
  for (const line of lines) {
    const { desc, amount } = parseBillLine(line);
    if (desc.trim() === SEPARATOR) groups.push({ rows: [] });
    // Trailing spaces only ever served the desktop version (see protectForJava).
    else groups[groups.length - 1].rows.push({ text: desc.trimEnd(), amount });
  }
  return groups;
}

export function linesFromGroups(groups: Group[]): string[] {
  const out: string[] = [];
  groups.forEach((g, i) => {
    if (i > 0) out.push(SEPARATOR_LINE);
    for (const r of g.rows) out.push(`${r.text},${r.amount}`);
  });
  return out;
}

export function dropdownLines(lists: DropdownList[]): string[] {
  return lists.map((d) => [d.tab, ...d.items].join('^'));
}

export function dropdownsFromLines(lines: string[]): DropdownList[] {
  return lines.filter((l) => l.trim() !== '').map((l) => {
    const [tab, ...items] = l.split('^');
    return { tab, items };
  });
}

// ---------- password ----------

const ITERATIONS = 100_000;

const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), hash: b64(await derive(password, salt, ITERATIONS)) };
}

export async function passwordMatches(h: PasswordHash, password: string): Promise<boolean> {
  return b64(await derive(password, unb64(h.salt), h.iterations)) === h.hash;
}

// ---------- files ----------

function newId(): string {
  const a = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(a, (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
}

export function encodeJson(v: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);
}

function decodeJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UserError(`The file ${what} is damaged (it is not valid JSON).`);
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseRecord(v: unknown, what: string): ClientYear {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.name !== 'string') {
    throw new UserError(`The file ${what} is damaged (no client name).`);
  }
  return {
    id: r.id,
    name: r.name,
    serial: str(r.serial),
    billNo: str(r.billNo),
    bills: arr(r.bills).map((b) => {
      const x = b as Record<string, unknown>;
      return {
        type: str(x.type),
        name: str(x.name),
        groups: arr(x.groups).map((g) => ({
          rows: arr((g as Record<string, unknown>).rows).map((row) => ({
            text: str((row as Record<string, unknown>).text),
            amount: str((row as Record<string, unknown>).amount),
          })),
        })),
      };
    }),
  };
}

function parseSettings(v: unknown): Settings {
  const s = v as Partial<Settings> | null;
  if (!s || s.format !== FORMAT) throw new UserError('This is not a Utility Soft data folder.');
  if ((s.version ?? 0) > VERSION) throw new UserError('This data was saved by a newer Utility Soft. Please use the newest version of the app.');
  return {
    format: FORMAT,
    version: s.version ?? VERSION,
    password: s.password!,
    letterhead: s.letterhead ?? null,
    billTypes: s.billTypes ?? [],
    dropdowns: s.dropdowns ?? [],
    autoBackup: s.autoBackup ?? '',
    desktop: { impinfoExtra: s.desktop?.impinfoExtra ?? [], extras: s.desktop?.extras ?? [] },
    ...(s.migratedFrom ? { migratedFrom: s.migratedFrom } : {}),
  };
}

export async function isWebStore(dir: FsDir): Promise<boolean> {
  return (await findEntry(dir, MANIFEST, 'file')) !== null;
}

/** A new, empty store with the desktop version's default tabs and drop-down lists. */
export async function createStore(dir: FsDir, password: string): Promise<WebBooks> {
  await ensureDir(dir, YEARS);
  const settings: Settings = {
    format: FORMAT,
    version: VERSION,
    password: await hashPassword(password),
    letterhead: null,
    billTypes: DEFAULT_BILL_TYPES,
    dropdowns: dropdownsFromLines(DEFAULT_DROPDOWNS),
    autoBackup: '',
    desktop: { impinfoExtra: [], extras: [] },
  };
  await writeFile(dir, MANIFEST, encodeJson(settings));
  return new WebBooks(dir);
}

function billOf(rec: ClientYear | null, folder: string, bill: string): StoredBill | undefined {
  if (!rec) return undefined;
  const ofType = rec.bills.filter((b) => sameName(b.type, folder));
  return ofType.find((b) => b.name === bill) ?? ofType.find((b) => sameName(b.name, bill));
}

function sortBills(bills: StoredBill[]): StoredBill[] {
  return sortNames(bills, (b) => b.name);
}

export class WebBooks {
  readonly kind = 'web' as const;
  /** year -> lower-case name -> id; only a hint, checked against the file. */
  private ids = new Map<string, Map<string, string>>();

  constructor(readonly root: FsDir) {}

  // ---------- settings ----------

  async settings(): Promise<Settings> {
    const b = await tryRead(this.root, MANIFEST);
    if (!b) throw new UserError('This is not a Utility Soft data folder.');
    return parseSettings(decodeJson(b, MANIFEST));
  }

  private async updateSettings(fn: (s: Settings) => void | Promise<void>): Promise<void> {
    const s = await this.settings();
    await fn(s);
    await writeFile(this.root, MANIFEST, encodeJson(s));
  }

  async billTypes(): Promise<BillType[]> {
    return (await this.settings()).billTypes;
  }

  async letterhead(): Promise<Letterhead | null> {
    return (await this.settings()).letterhead;
  }

  async saveLetterhead(lh: Letterhead): Promise<void> {
    await this.updateSettings((s) => {
      s.letterhead = cleanLetterhead(lh);
    });
  }

  async dropdown(tab: string, year: string): Promise<string[]> {
    return dropdownItems(dropdownLines((await this.settings()).dropdowns), tab).map((x) => x.split('##').join(year));
  }

  async saveDropdowns(types: BillType[], lists: Map<string, string[]>): Promise<void> {
    await this.updateSettings((s) => {
      s.dropdowns = dropdownsFromLines(mergeDropdowns(dropdownLines(s.dropdowns), types, lists));
    });
  }

  async checkPassword(password: string): Promise<boolean> {
    return passwordMatches((await this.settings()).password, password);
  }

  async setPassword(password: string): Promise<void> {
    const h = await hashPassword(password);
    await this.updateSettings((s) => {
      s.password = h;
    });
  }

  async backupPath(): Promise<string> {
    return (await this.settings()).autoBackup;
  }

  async setBackupPath(path: string): Promise<void> {
    await this.updateSettings((s) => {
      s.autoBackup = sanitize(path);
    });
  }

  async addBillType(rawName: string): Promise<void> {
    await this.updateSettings((s) => {
      const name = checkTabName(rawName, s.billTypes);
      s.billTypes = [...s.billTypes, { folder: name, tab: name }];
    });
  }

  // ---------- years ----------

  private async yearsDir(): Promise<FsDir> {
    return ensureDir(this.root, YEARS);
  }

  async years(): Promise<string[]> {
    return sortStrings((await listDirs(await this.yearsDir())).filter(isYear));
  }

  private async yearDir(year: string): Promise<FsDir> {
    const d = await tryDir(await this.yearsDir(), year);
    if (!d) throw new UserError(`Year ${year} does not exist.`);
    return d;
  }

  async addYear(year: string): Promise<void> {
    if (!isYear(year)) throw new UserError('Year must look like 26-27.');
    await ensureDir(await this.yearsDir(), year);
  }

  async addNextYear(): Promise<string> {
    const years = await this.years();
    if (years.length === 0) throw new UserError('There is no year yet; add the first year.');
    const next = nextYear(years[years.length - 1]);
    if (!next) throw new UserError('Cannot add a year after 99.');
    await this.addYear(next);
    return next;
  }

  // ---------- client records ----------

  /** Every client of a year, sorted by name. */
  async records(year: string): Promise<ClientYear[]> {
    const y = await tryDir(await this.yearsDir(), year);
    if (!y) return [];
    const files = (await listFiles(y)).filter((f) => f.toLowerCase().endsWith('.json'));
    const recs = await mapLimit(files, 16, async (f) => parseRecord(decodeJson(await y.read(f), `${YEARS}/${year}/${f}`), `${YEARS}/${year}/${f}`));
    this.ids.set(year, new Map(recs.map((r) => [r.name.toLowerCase(), r.id])));
    return sortNames(recs, (r) => r.name);
  }

  /** The client with this id in a year, if any. */
  async record(year: string, id: string): Promise<ClientYear | null> {
    const y = await tryDir(await this.yearsDir(), year);
    const b = y ? await tryRead(y, `${id}.json`) : null;
    return b ? parseRecord(decodeJson(b, `${YEARS}/${year}/${id}.json`), `${YEARS}/${year}/${id}.json`) : null;
  }

  private async find(year: string, name: string): Promise<ClientYear | null> {
    const hint = this.ids.get(year)?.get(name.toLowerCase());
    if (hint) {
      const r = await this.record(year, hint);
      if (r && r.name === name) return r;
    }
    const all = await this.records(year);
    return all.find((r) => r.name === name) ?? all.find((r) => sameName(r.name, name)) ?? null;
  }

  private async get(year: string, name: string): Promise<ClientYear> {
    const r = await this.find(year, name);
    if (!r) throw new UserError(`${name} does not exist in ${year}.`);
    return r;
  }

  async writeRecord(year: string, rec: ClientYear): Promise<void> {
    await writeFile(await this.yearDir(year), `${rec.id}.json`, encodeJson({ ...rec, bills: sortBills(rec.bills) }));
    const m = this.ids.get(year) ?? new Map<string, string>();
    m.set(rec.name.toLowerCase(), rec.id);
    this.ids.set(year, m);
  }

  private async removeRecord(year: string, rec: ClientYear): Promise<void> {
    await removeEntry(await this.yearDir(year), `${rec.id}.json`);
    this.ids.get(year)?.delete(rec.name.toLowerCase());
  }

  // ---------- clients ----------

  async clientNames(year: string): Promise<string[]> {
    return (await this.records(year)).map((r) => r.name);
  }

  async clients(year: string): Promise<Client[]> {
    await this.yearDir(year);
    return (await this.records(year)).map((r) => ({ name: r.name, serial: r.serial, billNo: r.billNo }));
  }

  async clientExists(year: string, name: string): Promise<boolean> {
    return (await this.find(year, name)) !== null;
  }

  private async applySerialUpdates(year: string, recs: ClientYear[], updates: Map<string, string>): Promise<void> {
    for (const [name, serial] of updates) {
      const r = recs.find((x) => x.name === name);
      if (r) await this.writeRecord(year, { ...r, serial });
    }
  }

  async setBillNo(year: string, name: string, billNo: string): Promise<void> {
    const r = await this.get(year, name);
    await this.writeRecord(year, { ...r, billNo: sanitize(billNo) });
  }

  async setSerial(year: string, name: string, serial: string): Promise<void> {
    const r = await this.get(year, name);
    await this.writeRecord(year, { ...r, serial: sanitize(serial) });
  }

  /**
   * The id a client called `name` had in the most recent of `years` that has one
   * (so its earlier bills stay linked), or a new id if none is free in `year`.
   */
  private async idFor(year: string, name: string, years: string[]): Promise<string> {
    const taken = new Set((await this.records(year)).map((r) => r.id));
    for (const y of years) {
      const r = (await this.records(y)).find((x) => sameName(x.name, name));
      if (r) return taken.has(r.id) ? newId() : r.id;
    }
    return newId();
  }

  /**
   * Bills of client `id` in `from` and the two years before, merged as the desktop
   * version does when copying a client to another year (amounts reset to 0).
   */
  private async carriedBills(from: string, id: string): Promise<StoredBill[]> {
    const recs = await Promise.all([from, ...previousYears(from, 2)].map((y) => this.record(y, id)));
    const out: StoredBill[] = [];
    for (const t of await this.billTypes()) {
      const names: string[] = [];
      for (const r of recs) for (const b of r?.bills ?? []) if (sameName(b.type, t.folder) && !names.some((n) => sameName(n, b.name))) names.push(b.name);
      for (const name of names) {
        const sources = recs.map((r) => billOf(r, t.folder, name)).filter((b): b is StoredBill => !!b).map((b) => linesFromGroups(b.groups));
        out.push({ type: t.folder, name, groups: groupsFromLines(mergeHistory(sources)) });
      }
    }
    return out;
  }

  async addClient(year: string, rawName: string, late: boolean): Promise<Client> {
    const name = checkName(rawName).toUpperCase();
    await this.yearDir(year);
    const recs = await this.records(year);
    if (recs.some((r) => sameName(r.name, name))) throw new UserError('This name already exists.');
    const plan = planInsert(entriesOf(recs), name, late);
    await this.applySerialUpdates(year, recs, plan.updates);
    const prev = previousYear(year);
    const id = await this.idFor(year, name, prev ? [prev, ...previousYears(prev, 2)] : []);
    const src = prev ? await this.record(prev, id) : null;
    const rec: ClientYear = { id, name, serial: plan.serial, billNo: src?.billNo ?? '', bills: prev ? await this.carriedBills(prev, id) : [] };
    await this.writeRecord(year, rec);
    return { name, serial: rec.serial, billNo: rec.billNo };
  }

  private async deleteClient(year: string, name: string): Promise<void> {
    const recs = await this.records(year);
    const r = recs.find((x) => x.name === name);
    if (!r) return;
    await this.applySerialUpdates(year, recs, planRemove(entriesOf(recs), name));
    await this.removeRecord(year, r);
  }

  async deleteClients(year: string, names: string[]): Promise<void> {
    for (const n of names) await this.deleteClient(year, n);
  }

  async modifyClient(year: string, oldName: string, rawNewName: string, billNo: string, late: boolean): Promise<string> {
    const newName = checkName(rawNewName).toUpperCase();
    const src = await this.get(year, oldName);
    if (newName === oldName) {
      await this.writeRecord(year, { ...src, billNo: sanitize(billNo) });
      return oldName;
    }
    const recs = await this.records(year);
    const existing = recs.find((r) => r.id !== src.id && sameName(r.name, newName));
    if (existing) {
      // Merge into the existing client: its S.No. stays; bills of the same name are replaced.
      const bills = existing.bills.filter((b) => !src.bills.some((x) => sameName(x.type, b.type) && sameName(x.name, b.name)));
      await this.deleteClient(year, oldName);
      const fresh = (await this.find(year, existing.name)) ?? existing;
      await this.writeRecord(year, { ...fresh, billNo: sanitize(billNo), bills: [...bills, ...src.bills] });
      return existing.name;
    }
    const plan = planRename(entriesOf(recs), oldName, newName, late);
    await this.applySerialUpdates(year, recs.filter((r) => r.id !== src.id), plan.updates);
    this.ids.get(year)?.delete(oldName.toLowerCase());
    await this.writeRecord(year, { ...src, name: newName, serial: plan.serial, billNo: sanitize(billNo) });
    return newName;
  }

  // ---------- bills ----------

  async bills(year: string, client: string, folder: string): Promise<string[]> {
    const r = await this.find(year, client);
    if (!r) return [];
    return sortStrings(r.bills.filter((b) => sameName(b.type, folder)).map((b) => b.name));
  }

  /** A bill as desktop lines ("text,amount", "New Name,New" between groups), or null. */
  async readBillLines(year: string, client: string, folder: string, bill: string): Promise<string[] | null> {
    const b = billOf(await this.find(year, client), folder, bill);
    return b ? linesFromGroups(b.groups) : null;
  }

  async readBill(year: string, client: string, folder: string, bill: string): Promise<BillRow[]> {
    return rowsFromLines((await this.readBillLines(year, client, folder, bill)) ?? [], year);
  }

  private async putBill(year: string, client: string, folder: string, bill: string, lines: string[]): Promise<void> {
    const r = await this.get(year, client);
    const old = billOf(r, folder, bill);
    const others = r.bills.filter((b) => b !== old);
    await this.writeRecord(year, { ...r, bills: [...others, { type: old?.type ?? folder, name: old?.name ?? bill, groups: groupsFromLines(lines) }] });
  }

  async writeBill(year: string, client: string, folder: string, bill: string, rows: BillRow[]): Promise<void> {
    await this.putBill(year, client, folder, bill, linesFromRows(rows, year));
  }

  /** The same bill of the same client (followed by its id, through renames) in the three previous years. */
  async historyLines(year: string, client: string, folder: string, bill: string): Promise<{ year: string; lines: string[] | null }[]> {
    const r = await this.find(year, client);
    return Promise.all(
      previousYears(year, 3).map(async (y) => {
        const b = r ? billOf(await this.record(y, r.id), folder, bill) : undefined;
        return { year: y, lines: b ? linesFromGroups(b.groups) : null };
      }),
    );
  }

  async billHistory(year: string, client: string, folder: string, bill: string, rows: BillRow[]): Promise<HistoryColumn[]> {
    return historyColumns(rows, year, await this.historyLines(year, client, folder, bill));
  }

  async createBill(year: string, client: string, folder: string, rawName: string): Promise<string> {
    const name = checkName(rawName, 'Bill name').toUpperCase();
    if ((await this.bills(year, client, folder)).some((b) => sameName(b, name))) throw new UserError('This bill name already exists.');
    const sources = (await this.historyLines(year, client, folder, name)).map((h) => h.lines).filter((l): l is string[] => l !== null);
    await this.putBill(year, client, folder, name, mergeHistory(sources));
    return name;
  }

  async renameBill(year: string, client: string, folder: string, oldName: string, rawNewName: string): Promise<string> {
    const name = checkName(rawNewName, 'Bill name').toUpperCase();
    const r = await this.get(year, client);
    const b = billOf(r, folder, oldName);
    if (!b) throw new UserError('Bill not found.');
    if (name === oldName) return name;
    if (r.bills.some((x) => x !== b && sameName(x.type, folder) && sameName(x.name, name))) throw new UserError('This bill name already exists.');
    await this.writeRecord(year, { ...r, bills: r.bills.map((x) => (x === b ? { ...x, name } : x)) });
    return name;
  }

  async deleteBill(year: string, client: string, folder: string, bill: string): Promise<void> {
    const r = await this.find(year, client);
    const b = billOf(r, folder, bill);
    if (r && b) await this.writeRecord(year, { ...r, bills: r.bills.filter((x) => x !== b) });
  }

  // ---------- copying clients between years ----------

  async planCopy(from: string, to: string): Promise<{ fresh: Client[]; collided: Client[] }> {
    const src = await this.clients(from);
    const dest = await this.clientNames(to);
    const fresh: Client[] = [];
    const collided: Client[] = [];
    for (const c of src) (dest.some((d) => sameName(d, c.name)) ? collided : fresh).push(c);
    return { fresh, collided };
  }

  /** A copy of `from`'s client in `to`, with its S.No. and Bill No. and bills carried forward. */
  private async copyClient(from: string, to: string, name: string): Promise<void> {
    const src = await this.get(from, name);
    const taken = (await this.records(to)).some((r) => r.id === src.id);
    await this.yearDir(to);
    await this.writeRecord(to, { id: taken ? newId() : src.id, name: src.name, serial: src.serial, billNo: src.billNo, bills: await this.carriedBills(from, src.id) });
  }

  async copyClients(from: string, to: string, names: string[], onProgress?: (done: number) => void): Promise<void> {
    if (from === to) throw new UserError('Choose two different years.');
    let done = 0;
    for (const name of names) {
      const old = (await this.records(to)).find((r) => sameName(r.name, name));
      if (old) await this.removeRecord(to, old);
      await this.copyClient(from, to, name);
      onProgress?.(++done);
    }
  }

  async copyClientToNextYear(year: string, name: string): Promise<string | null> {
    const next = nextYear(year);
    if (!next || !(await this.years()).includes(next)) return null;
    await this.copyClient(year, next, name);
    return next;
  }

  // ---------- open clients ----------

  private lockFile(year: string, name: string): string {
    return `${year} ${name}.lock`;
  }

  async isLocked(year: string, name: string): Promise<boolean> {
    const d = await tryDir(this.root, OPEN);
    return !!d && (await findEntry(d, this.lockFile(year, name), 'file')) !== null;
  }

  async lock(year: string, name: string): Promise<void> {
    await writeFile(await ensureDir(this.root, OPEN), this.lockFile(year, name), encodeJson({ since: new Date().toISOString() }));
  }

  async unlock(year: string, name: string): Promise<void> {
    const d = await tryDir(this.root, OPEN);
    if (d) await removeEntry(d, this.lockFile(year, name));
  }

  // ---------- backup ----------

  /** Copies everything (but the list of open clients) into `dest`, which can then be opened like this folder. */
  async backupTo(dest: FsDir, onFile?: () => void): Promise<void> {
    for (const e of await this.root.list()) {
      if (e.name === OPEN) continue;
      if (e.kind === 'directory') await copyTree(await this.root.dir(e.name), await ensureDir(dest, e.name), onFile);
      else {
        await writeFile(dest, e.name, await this.root.read(e.name));
        onFile?.();
      }
    }
  }
}

function entriesOf(recs: ClientYear[]): SerialEntry[] {
  return recs.map((r) => ({ name: r.name, serial: r.serial }));
}
