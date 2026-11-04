// The web app's own data format (described in docs/data-format.md): one folder,
// every file encrypted except utility-soft.json (see core/crypto.ts).
//
//   utility-soft.json            format, version and the data key, wrapped by the password and the recovery code
//   settings.dat                 letterhead, tabs, drop-down lists, auto-backup folder
//   years/<YY-YY>/<id>.dat       one client in one year: name, S.No., Bill No. and all its bills
//   open/<hash>.lock             a client open on a computer (the name does not reveal which)
//   journal/<id>.dat             a change of several files, while it is being made
//   history/<path>/<time>.dat    earlier versions of each client file and of the settings
//   bin/<time>-<id>.dat          deleted clients and bills, kept 30 days
//   extras/<id>.dat              files of the desktop data folder the app does not use
//   backups/<time>/              automatic backups (core/backup.ts)
//   logs/<month> <computer>.dat  problems, for support
//
// A client keeps its id from year to year, and a bill its id, so earlier years
// stay linked through renames. Everything here can be written back in the
// desktop (Java) layout (core/migrate.ts), so text follows the same rules.

import { sanitize } from './codec';
import { BillType, DEFAULT_BILL_TYPES, DEFAULT_DROPDOWNS, Letterhead, cleanLetterhead, dropdownItems, mergeDropdowns } from './config';
import { DamagedError, DataKey, PASSWORD_ITERATIONS, RECOVERY_ITERATIONS, Wrap, b64, newRecoveryCode, normalizeRecoveryCode, unb64 } from './crypto';
import { FsDir, findEntry, tryRead, writeFile } from './fs';
import { BillRow, HistoryColumn, SEPARATOR, amountValue, historyColumns, linesFromRows, mergeHistory, parseBillLine, rowsFromLines } from './bill';
import { UserError, checkName, checkTabName } from './names';
import { SerialEntry, endsWithDigit, planInsert, planRemove, planRename } from './serial';
import { sameName, sortNames, sortStrings } from './sort';
import { isYear, nextYear, previousYear, previousYears } from './years';
import { mapLimit } from './util';
import { Vault } from './vault';
import { nextBillNo } from './billno';

export const MANIFEST = 'utility-soft.json';
export const FORMAT = 'utility-soft';
/** Version of the folder layout; a folder of a later version is refused (it must not be misread). */
export const VERSION = 1;
const SETTINGS = 'settings.dat';
const YEARS = 'years';
const CLIENTS = 'clients';
const OPEN = 'open';
const JOURNAL = 'journal';
const HISTORY = 'history';
const BIN = 'bin';
const LOGS = 'logs';
export const EXTRAS = 'extras';
export const BACKUPS = 'backups';
/** What a backup holds: the data itself, not the bookkeeping. */
export const DATA_ENTRIES = [MANIFEST, SETTINGS, YEARS, CLIENTS, EXTRAS];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A new earlier version of a file is kept at most this often while it is being edited. */
const VERSION_EVERY = 10 * MINUTE;
const VERSIONS_KEPT = 30;
const BIN_DAYS = 30;
/** An open client whose computer has not said so for this long is no longer considered open. */
export const LOCK_STALE = 5 * MINUTE;
/** A change of several files older than this was interrupted (the computer stopped). */
const JOURNAL_STALE = MINUTE;

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

export interface Manifest {
  format: string;
  version: number;
  note: string;
  keys: { password: Wrap; recovery: Wrap };
  /** False until someone has shown they saved the recovery code (the app then asks again). */
  recoverySaved?: boolean;
}

/** One line of ddown.txt: a tab title and its entries (as stored, possibly with empty ones). */
export interface DropdownList {
  tab: string;
  items: string[];
}

/** A file kept from the desktop data folder (path inside it, joined with /), stored as extras/<blob>.dat. */
export interface ExtraFile {
  path: string;
  blob: string;
}

export interface Settings {
  /** null until it is filled in (the first run asks for it). */
  letterhead: Letterhead | null;
  billTypes: BillType[];
  dropdowns: DropdownList[];
  /** Folder for the backup made when exiting ('' for none): a path or a folder name. */
  autoBackup: string;
  /** Things only the desktop version uses, kept so that exporting gives them back. */
  desktop: {
    /** impinfo.txt lines after the letterhead. */
    impinfoExtra: string[];
    /** The files and folders kept from the desktop data folder (top level of what was kept). */
    extras: string[];
    /** Every kept file. */
    files: ExtraFile[];
  };
  migratedFrom?: { at: string; folder: string; data: string };
  /** Backups to Google Drive: once a day when `daily`; `last` is when the last one was made (ms). */
  drive?: { daily: boolean; last?: number };
}

/**
 * A row of a bill. `amount` is a whole number, or null when empty. An amount the
 * desktop version stored that is not a plain whole number is kept in `raw`.
 */
export interface Row {
  text: string;
  amount: number | null;
  raw?: string;
}

/** Rows printed together with their own subtotal (the desktop version separates them with "New Name" rows). */
export interface Group {
  rows: Row[];
}

export interface StoredBill {
  id: string;
  /** Bill type (its folder name in the desktop layout). */
  type: string;
  name: string;
  groups: Group[];
  /** Money received for this bill, and reductions agreed with the client. */
  payments?: Payment[];
  /** Date last printed or saved as PDF (dd.mm.yyyy). */
  printed?: string;
}

export interface Payment {
  id: string;
  /** yyyy-mm-dd */
  date: string;
  /** Whole rupees, more than 0. */
  amount: number;
  /** Money received, or a reduction of the bill agreed with the client. */
  kind: 'received' | 'reduced';
  note?: string;
}

/** Optional details of a client, the same in every year (kept by its id). */
export interface ClientDetails {
  pan?: string;
  gstin?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export const DETAIL_FIELDS: (keyof ClientDetails)[] = ['pan', 'gstin', 'address', 'phone', 'email'];

export interface ClientYear {
  v: number;
  id: string;
  name: string;
  serial: string;
  billNo: string;
  bills: StoredBill[];
}

export interface Client {
  name: string;
  serial: string;
  billNo: string;
  /** Total of all its bills this year. */
  billed?: number;
  /** What is still to be paid (billed less received and reduced). */
  due?: number;
}

export interface Computer {
  id: string;
  /** '' when not named. */
  name: string;
}

export interface LockInfo {
  computer: Computer;
  since: number;
  /** Open in another window of this browser. */
  mine: boolean;
}

/** A client file that could not be read. */
export interface Problem {
  path: string;
  year: string;
  /** From its last good version, when there is one. */
  name: string | null;
  restorable: boolean;
}

export interface LedgerRow {
  year: string;
  client: string;
  serial: string;
  billNo: string;
  folder: string;
  tab: string;
  bill: string;
  billed: number;
  received: number;
  reduced: number;
  due: number;
  /** Date of the last money received (yyyy-mm-dd). */
  lastPaid?: string;
  printed?: string;
}

export type BinEntry =
  | { file: string; kind: 'client'; at: number; year: string; record: ClientYear }
  | { file: string; kind: 'bill'; at: number; year: string; clientId: string; clientName: string; bill: StoredBill };

/** Thrown when a bill was changed (or deleted) elsewhere since it was read. */
export class BillConflict extends Error {
  constructor(readonly current: string[] | null) {
    super('This bill was changed on another computer.');
    this.name = 'BillConflict';
  }
}

export interface Options {
  computer?: Computer;
  now?: () => number;
  /** PBKDF2 rounds for the password (lower only in tests). */
  iterations?: number;
}

// ---------- rows and desktop lines ----------

const SEPARATOR_LINE = `${SEPARATOR},New`;

/** A row from desktop text and amount, keeping the amount exactly. */
export function rowFrom(text: string, amount: string): Row {
  if (amount === '') return { text, amount: null };
  if (/^-?\d+$/.test(amount)) {
    const n = Number(amount);
    if (String(n) === amount && n >= INT_MIN && n <= INT_MAX) return { text, amount: n };
  }
  return { text, amount: null, raw: amount };
}

export function amountText(r: Row): string {
  return r.amount !== null ? String(r.amount) : (r.raw ?? '');
}

/** Groups of a bill from its desktop lines ("text,amount"; "New Name" rows start a group). */
export function groupsFromLines(lines: string[]): Group[] {
  const groups: Group[] = [{ rows: [] }];
  for (const line of lines) {
    const { desc, amount } = parseBillLine(line);
    if (desc.trim() === SEPARATOR) groups.push({ rows: [] });
    // Trailing spaces only ever served the desktop version (see protectForJava).
    else groups[groups.length - 1].rows.push(rowFrom(desc.trimEnd(), amount));
  }
  return groups;
}

export function linesFromGroups(groups: Group[]): string[] {
  const out: string[] = [];
  groups.forEach((g, i) => {
    if (i > 0) out.push(SEPARATOR_LINE);
    for (const r of g.rows) out.push(`${r.text},${amountText(r)}`);
  });
  return out;
}

export function dropdownLines(lists: DropdownList[]): string[] {
  return lists.map((d) => [d.tab, ...d.items].join('^'));
}

export function dropdownsFromLines(lines: string[]): DropdownList[] {
  return lines
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [tab, ...items] = l.split('^');
      return { tab, items };
    });
}

/** Whole-number amounts typed in the app are stored without leading zeros or "+". */
function cleanAmount(a: string): string {
  const t = a.trim();
  if (!/^[+-]?\d+$/.test(t)) return t;
  const n = Number(t);
  return n >= INT_MIN && n <= INT_MAX ? String(n) : t;
}

// ---------- ids ----------

export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
}

/** The same id for the same client, type and bill name (bills migrated from the desktop layout). */
export function billIdFor(clientId: string, type: string, name: string): string {
  let h = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of `${clientId}|${type.toLowerCase()}|${name.toLowerCase()}`) {
    const c = ch.codePointAt(0)!;
    h = Math.imul(h ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `b${h.toString(36)}${h2.toString(36)}`;
}

// ---------- reading files ----------

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseRecord(v: unknown, path: string): ClientYear {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.bills)) {
    throw new DamagedError(path);
  }
  if (typeof r.v === 'number' && r.v > VERSION) throw new UserError('This data was saved by a newer Utility Soft. Please use the newest version of the app.');
  return {
    v: VERSION,
    id: r.id,
    name: r.name,
    serial: str(r.serial),
    billNo: str(r.billNo),
    bills: arr(r.bills).map((b) => {
      const x = b as Record<string, unknown>;
      const bill: StoredBill = {
        id: str(x.id) || newId(),
        type: str(x.type),
        name: str(x.name),
        groups: arr(x.groups).map((g) => ({
          rows: arr((g as Record<string, unknown>).rows).map((row) => {
            const y = row as Record<string, unknown>;
            const amount = typeof y.amount === 'number' && Number.isInteger(y.amount) ? y.amount : null;
            return typeof y.raw === 'string' && amount === null ? { text: str(y.text), amount, raw: y.raw } : { text: str(y.text), amount };
          }),
        })),
      };
      const payments = arr(x.payments)
        .map((p) => p as Record<string, unknown>)
        .filter((p) => typeof p.amount === 'number' && (p.kind === 'received' || p.kind === 'reduced'))
        .map((p) => ({ id: str(p.id) || newId(), date: str(p.date), amount: p.amount as number, kind: p.kind as Payment['kind'], ...(p.note ? { note: str(p.note) } : {}) }));
      if (payments.length) bill.payments = payments;
      if (typeof x.printed === 'string' && x.printed) bill.printed = x.printed;
      return bill;
    }),
  };
}

function parseSettings(v: unknown): Settings {
  const s = (v ?? {}) as Partial<Settings>;
  return {
    letterhead: s.letterhead ?? null,
    billTypes: s.billTypes ?? [],
    dropdowns: s.dropdowns ?? [],
    autoBackup: s.autoBackup ?? '',
    desktop: { impinfoExtra: s.desktop?.impinfoExtra ?? [], extras: s.desktop?.extras ?? [], files: s.desktop?.files ?? [] },
    ...(s.migratedFrom ? { migratedFrom: s.migratedFrom } : {}),
    ...(s.drive ? { drive: s.drive } : {}),
  };
}

export async function readManifest(dir: FsDir): Promise<Manifest | null> {
  const b = await tryRead(dir, MANIFEST);
  if (!b) return null;
  let m: Manifest;
  try {
    m = JSON.parse(new TextDecoder().decode(b));
  } catch {
    throw new UserError(`The file ${MANIFEST} is damaged. Open a backup of this folder instead.`);
  }
  if (m.format !== FORMAT || !m.keys?.password) throw new UserError('This is not a Utility Soft data folder.');
  if (m.version > VERSION) throw new UserError('This data was saved by a newer Utility Soft. Please use the newest version of the app.');
  return m;
}

export async function isWebStore(dir: FsDir): Promise<boolean> {
  return (await findEntry(dir, MANIFEST, 'file')) !== null;
}

export async function writeManifest(dir: FsDir, m: Manifest): Promise<void> {
  await writeFile(dir, MANIFEST, new TextEncoder().encode(`${JSON.stringify(m, null, 2)}\n`));
}

export function newManifest(keys: Manifest['keys']): Manifest {
  return {
    format: FORMAT,
    version: VERSION,
    note: 'Encrypted Utility Soft data. Open this folder with the Utility Soft app; the password or the recovery code is needed.',
    keys,
    recoverySaved: false,
  };
}

/** Wraps of a data key for a password and a fresh recovery code. */
export async function newKeys(key: DataKey, password: string, iterations = PASSWORD_ITERATIONS): Promise<{ keys: Manifest['keys']; recoveryCode: string }> {
  const recoveryCode = newRecoveryCode();
  return { keys: { password: await key.wrap(password, iterations), recovery: await key.wrap(recoveryCode, RECOVERY_ITERATIONS) }, recoveryCode };
}

/** A new, empty store with the desktop version's default tabs and drop-down lists. */
export async function createStore(dir: FsDir, password: string, opts: Options = {}): Promise<{ books: WebBooks; recoveryCode: string }> {
  const key = await DataKey.generate();
  const vault = new Vault(dir, key);
  await vault.dir([YEARS], true);
  await writeSettings(vault, {
    letterhead: null,
    billTypes: DEFAULT_BILL_TYPES,
    dropdowns: dropdownsFromLines(DEFAULT_DROPDOWNS),
    autoBackup: '',
    desktop: { impinfoExtra: [], extras: [], files: [] },
  });
  const { keys, recoveryCode } = await newKeys(key, password, opts.iterations);
  // Written last: a folder that stopped half way cannot be opened by mistake.
  await writeManifest(dir, newManifest(keys));
  return { books: new WebBooks(vault, opts), recoveryCode };
}

/** Writes the settings of a store being made (by a migration); the manifest still has to follow. */
export async function writeSettings(vault: Vault, s: Settings): Promise<void> {
  await vault.writeJson([SETTINGS], s);
}

export function recordPath(year: string, id: string): string[] {
  return [YEARS, year, `${id}.dat`];
}

export function extraPath(blob: string): string[] {
  return [EXTRAS, `${blob}.dat`];
}

export function encodeRecord(rec: ClientYear): Uint8Array {
  return enc.encode(JSON.stringify({ ...rec, v: VERSION, bills: sortBills(rec.bills) }));
}

/** A bill's total and what is still to be paid on it. */
export function billSums(b: StoredBill): { billed: number; received: number; reduced: number; due: number } {
  let billed = 0;
  for (const g of b.groups) for (const r of g.rows) billed += amountValue(amountText(r));
  let received = 0;
  let reduced = 0;
  for (const p of b.payments ?? []) {
    if (p.kind === 'received') received += p.amount;
    else reduced += p.amount;
  }
  return { billed, received, reduced, due: billed - received - reduced };
}

/** Names of a client's bills of one type, sorted. */
export function billNamesOf(rec: ClientYear | null, folder: string): string[] {
  return rec ? sortStrings(rec.bills.filter((b) => sameName(b.type, folder)).map((b) => b.name)) : [];
}

/** A client's bill as desktop lines, or null. */
export function billLinesOf(rec: ClientYear | null, folder: string, bill: string): string[] | null {
  const b = billOf(rec, folder, bill);
  return b ? linesFromGroups(b.groups) : null;
}

function billOf(rec: ClientYear | null, folder: string, bill: string): StoredBill | undefined {
  if (!rec) return undefined;
  const ofType = rec.bills.filter((b) => sameName(b.type, folder));
  return ofType.find((b) => b.name === bill) ?? ofType.find((b) => sameName(b.name, bill));
}

function sortBills(bills: StoredBill[]): StoredBill[] {
  return sortNames(bills, (b) => b.name);
}

function sameLines(a: string[] | null, b: string[] | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const stamp = (t: number) => new Date(t).toISOString().replace(/[:.]/g, '-');
const stampTime = (s: string) => Date.parse(s.replace(/^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z.*$/, '$1T$2:$3:$4.$5Z'));

interface Change {
  path: string[];
  after: Uint8Array | null;
  /** Routine changes (S.No. renumbering) keep no earlier version. */
  routine?: boolean;
}

interface JournalFile {
  at: number;
  label: string;
  changes: { path: string[]; before: string | null; after: string | null }[];
}

export class WebBooks {
  readonly kind = 'web' as const;
  readonly root: FsDir;
  readonly computer: Computer;
  private readonly now: () => number;
  private readonly iterations: number;
  /** year -> lower-case name -> id; only a hint, checked against the file. */
  private ids = new Map<string, Map<string, string>>();
  /** Client files already read, by path, while they stay unchanged. */
  private cache = new Map<string, { size: number; modified: number; rec: ClientYear }>();
  private settingsCache: { size: number; modified: number; s: Settings } | null = null;
  private lastVersion = new Map<string, number>();
  private damaged = new Map<string, Problem>();

  constructor(
    readonly vault: Vault,
    opts: Options = {},
  ) {
    this.root = vault.root;
    this.computer = opts.computer ?? { id: 'this', name: '' };
    this.now = opts.now ?? Date.now;
    this.iterations = opts.iterations ?? PASSWORD_ITERATIONS;
    // Changes made here run one after another: each reads what the one before wrote
    // (two quick clicks must not both start from the same old file).
    const self = this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const m of CHANGES) {
      const f = self[m];
      self[m] = (...a: unknown[]) => this.exclusive(() => f.apply(this, a));
    }
  }

  private queue: Promise<unknown> = Promise.resolve();

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Opens a store with its password; null when the password is wrong. */
  static async unlock(dir: FsDir, password: string, opts: Options = {}): Promise<WebBooks | null> {
    const m = await readManifest(dir);
    if (!m) throw new UserError('This is not a Utility Soft data folder.');
    const key = await DataKey.unwrap(m.keys.password, password);
    return key ? new WebBooks(new Vault(dir, key), opts) : null;
  }

  /** Opens a store with its recovery code (then a new password must be set); null when the code is wrong. */
  static async unlockWithRecovery(dir: FsDir, code: string, opts: Options = {}): Promise<WebBooks | null> {
    const m = await readManifest(dir);
    if (!m) throw new UserError('This is not a Utility Soft data folder.');
    const c = normalizeRecoveryCode(code);
    const key = c ? await DataKey.unwrap(m.keys.recovery, c) : null;
    return key ? new WebBooks(new Vault(dir, key), opts) : null;
  }

  /** The same data, as another computer (or at another time) would see it. */
  as(opts: Options): WebBooks {
    return new WebBooks(this.vault, { computer: this.computer, now: this.now, iterations: this.iterations, ...opts });
  }

  /** Finishes changes interrupted earlier and empties the bin of old entries. Run when opening. */
  async open(): Promise<{ recovered: number; skipped: number }> {
    const r = await this.recover();
    await this.purgeBin();
    return r;
  }

  // ---------- password and recovery code ----------

  async checkPassword(password: string): Promise<boolean> {
    const m = await readManifest(this.root);
    return !!m && (await DataKey.unwrap(m.keys.password, password)) !== null;
  }

  async setPassword(password: string): Promise<void> {
    const m = (await readManifest(this.root))!;
    await this.keepManifestVersion(m);
    await writeManifest(this.root, { ...m, keys: { ...m.keys, password: await this.vault.key.wrap(password, this.iterations) } });
  }

  /** Replaces the recovery code (the old one stops working) and returns the new one. */
  async newRecoveryCode(): Promise<string> {
    const code = newRecoveryCode();
    await this.setRecoveryCode(code);
    return code;
  }

  /** Makes `code` (from newRecoveryCode in core/crypto.ts) the recovery code, once it has been saved. */
  async setRecoveryCode(code: string): Promise<void> {
    const m = (await readManifest(this.root))!;
    await this.keepManifestVersion(m);
    await writeManifest(this.root, { ...m, keys: { ...m.keys, recovery: await this.vault.key.wrap(code, RECOVERY_ITERATIONS) }, recoverySaved: true });
  }

  /** Whether the recovery code was saved (shown and confirmed). */
  async recoverySaved(): Promise<boolean> {
    return (await readManifest(this.root))?.recoverySaved !== false;
  }

  private async keepManifestVersion(m: Manifest): Promise<void> {
    // The wrapped keys are safe to keep as they are: they need the password or recovery code.
    const d = (await this.vault.dir([HISTORY, MANIFEST], true))!;
    await d.write(`${stamp(this.now())}.json`, enc.encode(JSON.stringify(m)));
  }

  // ---------- several files at once, safely ----------

  /**
   * Makes all the changes, or (if the computer stops half way) lets the next
   * opening finish them: the intended changes are written to the journal first.
   */
  private async commit(changes: Change[], label: string, opts: { keepVersions?: boolean } = {}): Promise<void> {
    const before = await mapLimit(changes, 16, (c) => this.vault.read(c.path).catch(() => null));
    const tx = changes.length > 1 ? [JOURNAL, `${stamp(this.now())}-${newId()}.dat`] : null;
    if (tx) {
      const j: JournalFile = {
        at: this.now(),
        label,
        changes: changes.map((c, i) => ({ path: c.path, before: before[i] && b64(before[i]!), after: c.after && b64(c.after) })),
      };
      await this.vault.writeJson(tx, j);
    }
    // In any order: the journal makes the whole change safe.
    await mapLimit([...changes.keys()], 8, (i) => this.apply(changes[i], before[i], (opts.keepVersions ?? true) && !changes[i].routine));
    if (tx) await this.vault.remove(tx);
  }

  private async apply(c: Change, before: Uint8Array | null, keepVersion: boolean): Promise<void> {
    if (before && keepVersion) await this.keepVersion(c.path, before, c.after === null);
    if (c.after === null) await this.vault.remove(c.path);
    else await this.vault.write(c.path, c.after);
    this.cache.delete(c.path.join('/'));
    if (c.path[0] === SETTINGS) this.settingsCache = null;
  }

  /** Finishes changes that a computer was making when it stopped. */
  async recover(): Promise<{ recovered: number; skipped: number }> {
    let recovered = 0;
    let skipped = 0;
    for (const e of await this.vault.list([JOURNAL])) {
      if (e.kind !== 'file') continue;
      let j: JournalFile | null;
      try {
        j = await this.vault.readJson<JournalFile>([JOURNAL, e.name]);
      } catch {
        await this.log(`Journal ${e.name} could not be read; it was left as it is.`);
        continue;
      }
      if (!j || this.now() - j.at < JOURNAL_STALE) continue;
      let done = 0;
      let left = 0;
      for (const c of j.changes) {
        const cur = await this.vault.read(c.path).catch(() => undefined);
        const now = cur === undefined ? undefined : cur && b64(cur);
        if (now === c.after) continue;
        if (now === c.before) {
          await this.apply({ path: c.path, after: c.after === null ? null : unb64(c.after) }, cur ?? null, true);
          done++;
        } else left++; // Changed since by someone else: theirs is newer.
      }
      recovered += done;
      skipped += left;
      await this.vault.remove([JOURNAL, e.name]);
      await this.log(`Finished an interrupted change (${j.label}): ${done} files; ${left} changed since, left as they were.`);
    }
    return { recovered, skipped };
  }

  // ---------- earlier versions ----------

  private historyDir(path: string[]): string[] {
    return [HISTORY, ...path];
  }

  /** Keeps `before` as an earlier version of `path`, at most every few minutes (always when `force`). */
  private async keepVersion(path: string[], before: Uint8Array, force: boolean): Promise<void> {
    if (path[0] !== YEARS && path[0] !== SETTINGS && path[0] !== CLIENTS) return;
    const key = path.join('/');
    const now = this.now();
    let last = this.lastVersion.get(key);
    if (last === undefined) {
      const v = await this.versionStamps(path);
      last = v.length ? stampTime(v[0]) : 0;
    }
    if (!force && now - last < VERSION_EVERY) return;
    const dir = this.historyDir(path);
    await this.vault.write([...dir, `${stamp(now)}.dat`], before);
    this.lastVersion.set(key, now);
    const all = await this.versionStamps(path);
    for (const old of all.slice(VERSIONS_KEPT)) await this.vault.remove([...dir, `${old}.dat`]);
  }

  /** Stamps of the earlier versions of a file, newest first. */
  private async versionStamps(path: string[]): Promise<string[]> {
    return (await this.vault.list(this.historyDir(path)))
      .filter((e) => e.kind === 'file' && e.name.endsWith('.dat'))
      .map((e) => e.name.slice(0, -4))
      .sort()
      .reverse();
  }

  /** Earlier versions of a client's file in a year, newest first. */
  async recordVersions(year: string, id: string): Promise<{ at: number; record: ClientYear }[]> {
    const path = recordPath(year, id);
    const out: { at: number; record: ClientYear }[] = [];
    for (const s of await this.versionStamps(path)) {
      try {
        const v = await this.vault.readJson<unknown>([...this.historyDir(path), `${s}.dat`]);
        out.push({ at: stampTime(s), record: parseRecord(v, path.join('/')) });
      } catch {
        // A damaged earlier version is simply not offered.
      }
    }
    return out;
  }

  // ---------- settings ----------

  async settings(): Promise<Settings> {
    const st = await this.vault.stat([SETTINGS]);
    const c = this.settingsCache;
    if (st && c && c.size === st.size && c.modified === st.modified) return c.s;
    const s = parseSettings(await this.vault.readJson([SETTINGS]));
    this.settingsCache = st && this.now() - st.modified > 5000 ? { ...st, s } : null;
    return s;
  }

  private async updateSettings(fn: (s: Settings) => void | Promise<void>): Promise<void> {
    const s = structuredClone(await this.settings());
    await fn(s);
    await this.commit([{ path: [SETTINGS], after: enc.encode(JSON.stringify(s)) }], 'settings');
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

  async backupPath(): Promise<string> {
    return (await this.settings()).autoBackup;
  }

  async setBackupPath(path: string): Promise<void> {
    await this.updateSettings((s) => {
      s.autoBackup = sanitize(path);
    });
  }

  async setDriveDaily(daily: boolean): Promise<void> {
    await this.updateSettings((s) => {
      s.drive = { ...s.drive, daily };
    });
  }

  async noteDriveBackup(at: number): Promise<void> {
    await this.updateSettings((s) => {
      s.drive = { daily: s.drive?.daily ?? false, last: at };
    });
  }

  /** An id for this data in Google Drive that says nothing about it (the same on every computer). */
  async storeId(): Promise<string> {
    return this.vault.key.name('google drive store');
  }

  async addBillType(rawName: string): Promise<void> {
    await this.updateSettings((s) => {
      const name = checkTabName(rawName, s.billTypes);
      s.billTypes = [...s.billTypes, { folder: name, tab: name }];
    });
  }

  /** A kept desktop file's bytes. */
  async readExtra(f: ExtraFile): Promise<Uint8Array | null> {
    return this.vault.read(extraPath(f.blob));
  }

  // ---------- years ----------

  async years(): Promise<string[]> {
    return sortStrings((await this.vault.list([YEARS])).filter((e) => e.kind === 'directory' && isYear(e.name)).map((e) => e.name));
  }

  private async assertYear(year: string): Promise<void> {
    if (!(await this.years()).includes(year)) throw new UserError(`Year ${year} does not exist.`);
  }

  async addYear(year: string): Promise<void> {
    if (!isYear(year)) throw new UserError('Year must look like 26-27.');
    await this.vault.dir([YEARS, year], true);
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

  private async readRecord(path: string[]): Promise<ClientYear | null> {
    const key = path.join('/');
    const st = await this.vault.stat(path);
    const c = this.cache.get(key);
    if (st && c && c.size === st.size && c.modified === st.modified) return c.rec;
    let rec: ClientYear | null;
    try {
      const v = await this.vault.readJson<unknown>(path);
      rec = v === null ? null : parseRecord(v, key);
    } catch (e) {
      if (e instanceof DamagedError || e instanceof SyntaxError) {
        await this.noteDamaged(path);
        return null;
      }
      throw e;
    }
    this.damaged.delete(key);
    // Files changed in the last seconds are read again next time (coarse clocks of some disks).
    if (rec && st && this.now() - st.modified > 5000) this.cache.set(key, { ...st, rec });
    else this.cache.delete(key);
    return rec;
  }

  private async noteDamaged(path: string[]): Promise<void> {
    const key = path.join('/');
    if (this.damaged.has(key)) return;
    const versions = await this.recordVersions(path[1], path[2].replace(/\.dat$/, ''));
    this.damaged.set(key, { path: key, year: path[1], name: versions[0]?.record.name ?? null, restorable: versions.length > 0 });
    await this.log(`Could not read ${key}${versions.length ? ` (${versions[0].record.name})` : ''}.`);
  }

  /** Client files that could not be read (they are left out of the list until restored). */
  problems(): Problem[] {
    return [...this.damaged.values()];
  }

  /** Puts back the last good version of a damaged client file; the damaged one is kept in history. */
  async restoreDamaged(p: Problem): Promise<string> {
    const path = p.path.split('/');
    const [v] = await this.recordVersions(path[1], path[2].replace(/\.dat$/, ''));
    if (!v) throw new UserError('There is no earlier version of this client to restore.');
    const raw = await this.vault.readRaw(path);
    if (raw) await this.vault.writeRaw([HISTORY, 'damaged', `${stamp(this.now())}-${path.join('_')}`], raw);
    await this.commit([{ path, after: encodeRecord(v.record) }], 'restore a damaged client', { keepVersions: false });
    this.damaged.delete(p.path);
    return v.record.name;
  }

  /** Every client of a year, sorted by name. */
  async records(year: string): Promise<ClientYear[]> {
    const files = (await this.vault.list([YEARS, year])).filter((e) => e.kind === 'file' && e.name.endsWith('.dat'));
    const recs = (await mapLimit(files, 16, (f) => this.readRecord([YEARS, year, f.name]))).filter((r): r is ClientYear => r !== null);
    for (const k of this.damaged.keys()) if (k.startsWith(`${YEARS}/${year}/`) && !files.some((f) => k.endsWith(`/${f.name}`))) this.damaged.delete(k);
    this.ids.set(year, new Map(recs.map((r) => [r.name.toLowerCase(), r.id])));
    return sortNames(recs, (r) => r.name);
  }

  /** The client with this id in a year, if any. */
  async record(year: string, id: string): Promise<ClientYear | null> {
    return this.readRecord(recordPath(year, id));
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

  private put(year: string, rec: ClientYear): Change {
    const m = this.ids.get(year) ?? new Map<string, string>();
    m.set(rec.name.toLowerCase(), rec.id);
    this.ids.set(year, m);
    return { path: recordPath(year, rec.id), after: encodeRecord(rec) };
  }

  private drop(year: string, rec: ClientYear): Change {
    this.ids.get(year)?.delete(rec.name.toLowerCase());
    return { path: recordPath(year, rec.id), after: null };
  }

  private async write(year: string, rec: ClientYear, label: string): Promise<void> {
    await this.commit([this.put(year, rec)], label);
  }

  // ---------- clients ----------

  async clientNames(year: string): Promise<string[]> {
    return (await this.records(year)).map((r) => r.name);
  }

  async clients(year: string): Promise<Client[]> {
    await this.assertYear(year);
    return (await this.records(year)).map((r) => {
      const sum = r.bills.map(billSums).reduce((a, b) => ({ billed: a.billed + b.billed, due: a.due + b.due }), { billed: 0, due: 0 });
      return { name: r.name, serial: r.serial, billNo: r.billNo, billed: sum.billed, due: sum.due };
    });
  }

  async clientExists(year: string, name: string): Promise<boolean> {
    return (await this.find(year, name)) !== null;
  }

  private serialChanges(year: string, recs: ClientYear[], updates: Map<string, string>): Change[] {
    const byName = new Map(recs.map((r) => [r.name, r]));
    const out: Change[] = [];
    for (const [name, serial] of updates) {
      const r = byName.get(name);
      if (r) out.push({ ...this.put(year, { ...r, serial }), routine: true });
    }
    return out;
  }

  async setBillNo(year: string, name: string, billNo: string): Promise<void> {
    const r = await this.get(year, name);
    await this.write(year, { ...r, billNo: sanitize(billNo) }, 'Bill No.');
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
      const ofType = recs.map((r) => (r?.bills ?? []).filter((b) => sameName(b.type, t.folder)));
      const firsts: StoredBill[] = [];
      for (const list of ofType) for (const b of list) if (!firsts.some((x) => x.id === b.id || sameName(x.name, b.name))) firsts.push(b);
      for (const b of firsts) {
        const sources = ofType.map((list) => list.find((x) => x.id === b.id)).filter((x): x is StoredBill => !!x).map((x) => linesFromGroups(x.groups));
        out.push({ id: b.id, type: t.folder, name: b.name, groups: groupsFromLines(mergeHistory(sources)) });
      }
    }
    return out;
  }

  /** `billNo`, when given, is used instead of the one the client had the year before. */
  async addClient(year: string, rawName: string, late: boolean, billNo?: string): Promise<Client> {
    const name = checkName(rawName).toUpperCase();
    await this.assertYear(year);
    const recs = await this.records(year);
    if (recs.some((r) => sameName(r.name, name))) throw new UserError('This name already exists.');
    const plan = planInsert(entriesOf(recs), name, late);
    const prev = previousYear(year);
    const id = await this.idFor(year, name, prev ? [prev, ...previousYears(prev, 2)] : []);
    const src = prev ? await this.record(prev, id) : null;
    const rec: ClientYear = { v: VERSION, id, name, serial: plan.serial, billNo: billNo !== undefined ? sanitize(billNo.trim()) : (src?.billNo ?? ''), bills: prev ? await this.carriedBills(prev, id) : [] };
    await this.commit([...this.serialChanges(year, recs, plan.updates), this.put(year, rec)], `add ${name}`);
    return { name, serial: rec.serial, billNo: rec.billNo };
  }

  async deleteClients(year: string, names: string[]): Promise<void> {
    let recs = await this.records(year);
    const changes = new Map<string, Change>();
    const gone: ClientYear[] = [];
    for (const n of names) {
      const r = recs.find((x) => x.name === n);
      if (!r) continue;
      const updates = planRemove(entriesOf(recs), n);
      for (const c of this.serialChanges(year, recs, updates)) changes.set(c.path.join('/'), c);
      recs = recs.filter((x) => x !== r).map((x) => (updates.has(x.name) ? { ...x, serial: updates.get(x.name)! } : x));
      changes.set(recordPath(year, r.id).join('/'), this.drop(year, r));
      gone.push(r);
    }
    for (const r of gone) await this.toBin({ kind: 'client', year, record: r });
    await this.commit([...changes.values()], `delete ${names.join(', ')}`);
  }

  async modifyClient(year: string, oldName: string, rawNewName: string, billNo: string, late: boolean): Promise<string> {
    const newName = checkName(rawNewName).toUpperCase();
    const src = await this.get(year, oldName);
    if (newName === oldName) {
      await this.write(year, { ...src, billNo: sanitize(billNo) }, 'Bill No.');
      return oldName;
    }
    const recs = await this.records(year);
    const existing = recs.find((r) => r.id !== src.id && sameName(r.name, newName));
    if (existing) {
      // Merge into the existing client: its S.No. stays (renumbered as the old one leaves); bills of the same name are replaced.
      const updates = planRemove(entriesOf(recs), oldName);
      const bills = existing.bills.filter((b) => !src.bills.some((x) => sameName(x.type, b.type) && sameName(x.name, b.name)));
      const merged = { ...existing, serial: updates.get(existing.name) ?? existing.serial, billNo: sanitize(billNo), bills: [...bills, ...src.bills] };
      const others = this.serialChanges(year, recs.filter((r) => r.id !== existing.id), updates);
      await this.commit([...others, this.drop(year, src), this.put(year, merged)], `merge ${oldName} into ${existing.name}`);
      return existing.name;
    }
    const plan = planRename(entriesOf(recs), oldName, newName, late);
    this.ids.get(year)?.delete(oldName.toLowerCase());
    const others = this.serialChanges(year, recs.filter((r) => r.id !== src.id), plan.updates);
    await this.commit([...others, this.put(year, { ...src, name: newName, serial: plan.serial, billNo: sanitize(billNo) })], `rename ${oldName} to ${newName}`);
    return newName;
  }

  // ---------- bills ----------

  async bills(year: string, client: string, folder: string): Promise<string[]> {
    return billNamesOf(await this.find(year, client), folder);
  }

  /** A bill as desktop lines ("text,amount", "New Name,New" between groups), or null. */
  async readBillLines(year: string, client: string, folder: string, bill: string): Promise<string[] | null> {
    return billLinesOf(await this.find(year, client), folder, bill);
  }

  async readBill(year: string, client: string, folder: string, bill: string): Promise<BillRow[]> {
    return rowsFromLines((await this.readBillLines(year, client, folder, bill)) ?? [], year);
  }

  /**
   * Saves a bill and returns it as stored (desktop lines). With `expected` (the
   * bill as it was read), refuses with BillConflict when it was changed elsewhere.
   */
  async writeBill(year: string, client: string, folder: string, bill: string, rows: BillRow[], expected?: string[] | null): Promise<string[]> {
    const r = await this.get(year, client);
    const old = billOf(r, folder, bill);
    const current = old ? linesFromGroups(old.groups) : null;
    if (expected !== undefined && !sameLines(current, expected)) throw new BillConflict(current);
    const groups = groupsFromLines(linesFromRows(rows.map((x) => ({ ...x, amount: cleanAmount(x.amount) })), year));
    const others = r.bills.filter((b) => b !== old);
    const kept: StoredBill = old ? { ...old, groups } : { id: newId(), type: folder, name: bill, groups };
    await this.write(year, { ...r, bills: [...others, kept] }, `bill ${bill}`);
    return linesFromGroups(groups);
  }

  /** The same bill (followed by its id, through renames) of the same client in the three previous years. */
  async historyLines(year: string, client: string, folder: string, bill: string): Promise<{ year: string; lines: string[] | null }[]> {
    const r = await this.find(year, client);
    const b = billOf(r, folder, bill);
    return Promise.all(
      previousYears(year, 3).map(async (y) => {
        const p = r && b ? (await this.record(y, r.id))?.bills.find((x) => x.id === b.id) : undefined;
        return { year: y, lines: p ? linesFromGroups(p.groups) : null };
      }),
    );
  }

  async billHistory(year: string, client: string, folder: string, bill: string, rows: BillRow[]): Promise<HistoryColumn[]> {
    return historyColumns(rows, year, await this.historyLines(year, client, folder, bill));
  }

  async createBill(year: string, client: string, folder: string, rawName: string): Promise<string> {
    const name = checkName(rawName, 'Bill name').toUpperCase();
    const r = await this.get(year, client);
    if (r.bills.some((b) => sameName(b.type, folder) && sameName(b.name, name))) throw new UserError('This bill name already exists.');
    // The same bill in earlier years: its id, and its rows to start from.
    const earlier = await Promise.all(previousYears(year, 3).map(async (y) => billOf(await this.record(y, r.id), folder, name)));
    const id = earlier.find((b) => b)?.id ?? newId();
    const sources = earlier.filter((b): b is StoredBill => !!b && b.id === id).map((b) => linesFromGroups(b.groups));
    await this.write(year, { ...r, bills: [...r.bills, { id, type: folder, name, groups: groupsFromLines(mergeHistory(sources)) }] }, `new bill ${name}`);
    return name;
  }

  async renameBill(year: string, client: string, folder: string, oldName: string, rawNewName: string): Promise<string> {
    const name = checkName(rawNewName, 'Bill name').toUpperCase();
    const r = await this.get(year, client);
    const b = billOf(r, folder, oldName);
    if (!b) throw new UserError('Bill not found.');
    if (name === oldName) return name;
    if (r.bills.some((x) => x !== b && sameName(x.type, folder) && sameName(x.name, name))) throw new UserError('This bill name already exists.');
    await this.write(year, { ...r, bills: r.bills.map((x) => (x === b ? { ...x, name } : x)) }, `rename bill ${oldName}`);
    return name;
  }

  async deleteBill(year: string, client: string, folder: string, bill: string): Promise<void> {
    const r = await this.find(year, client);
    const b = billOf(r, folder, bill);
    if (!r || !b) return;
    await this.toBin({ kind: 'bill', year, clientId: r.id, clientName: r.name, bill: b });
    await this.write(year, { ...r, bills: r.bills.filter((x) => x !== b) }, `delete bill ${bill}`);
  }

  /** Earlier versions of a bill (by its id) that differ from each other and from now, newest first. */
  async billVersions(year: string, client: string, folder: string, bill: string): Promise<{ at: number; lines: string[] }[]> {
    const r = await this.get(year, client);
    const b = billOf(r, folder, bill);
    if (!b) return [];
    let last = JSON.stringify(linesFromGroups(b.groups));
    const out: { at: number; lines: string[] }[] = [];
    for (const v of await this.recordVersions(year, r.id)) {
      const old = v.record.bills.find((x) => x.id === b.id);
      if (!old) continue;
      const lines = linesFromGroups(old.groups);
      if (JSON.stringify(lines) === last) continue;
      last = JSON.stringify(lines);
      out.push({ at: v.at, lines });
    }
    return out;
  }

  // ---------- payments ----------

  private async updateBill(year: string, client: string, folder: string, bill: string, fn: (b: StoredBill) => StoredBill, label: string): Promise<void> {
    const r = await this.get(year, client);
    const b = billOf(r, folder, bill);
    if (!b) throw new UserError('Bill not found.');
    await this.write(year, { ...r, bills: r.bills.map((x) => (x === b ? fn(x) : x)) }, label);
  }

  /** Records money received for a bill, or a reduction agreed with the client. */
  async addPayment(year: string, client: string, folder: string, bill: string, p: Omit<Payment, 'id'>): Promise<void> {
    if (!Number.isInteger(p.amount) || p.amount <= 0 || p.amount > INT_MAX) throw new UserError('The amount must be a whole number of rupees, more than 0.');
    if (!/^\d{4}-\d\d-\d\d$/.test(p.date) || Number.isNaN(Date.parse(p.date))) throw new UserError('Choose the date.');
    const entry: Payment = { id: newId(), date: p.date, amount: p.amount, kind: p.kind, ...(p.note?.trim() ? { note: sanitize(p.note.trim()) } : {}) };
    await this.updateBill(year, client, folder, bill, (b) => ({ ...b, payments: [...(b.payments ?? []), entry].sort((x, y) => x.date.localeCompare(y.date)) }), `payment ${bill}`);
  }

  async removePayment(year: string, client: string, folder: string, bill: string, id: string): Promise<void> {
    await this.updateBill(year, client, folder, bill, (b) => {
      const payments = (b.payments ?? []).filter((x) => x.id !== id);
      const { payments: _, ...rest } = b;
      return payments.length ? { ...rest, payments } : rest;
    }, `remove payment ${bill}`);
  }

  async payments(year: string, client: string, folder: string, bill: string): Promise<{ payments: Payment[]; sums: ReturnType<typeof billSums>; printed?: string } | null> {
    const b = billOf(await this.find(year, client), folder, bill);
    return b ? { payments: b.payments ?? [], sums: billSums(b), printed: b.printed } : null;
  }

  /** Notes the date bills were printed (or saved as PDF). */
  async markPrinted(year: string, items: { client: string; folder: string; bill: string }[], date: string): Promise<void> {
    const byClient = new Map<string, { folder: string; bill: string }[]>();
    for (const i of items) byClient.set(i.client, [...(byClient.get(i.client) ?? []), i]);
    const changes: Change[] = [];
    for (const [client, list] of byClient) {
      const r = await this.find(year, client);
      if (!r) continue;
      const bills = r.bills.map((b) => (list.some((i) => billOf(r, i.folder, i.bill) === b) ? { ...b, printed: date } : b));
      changes.push({ ...this.put(year, { ...r, bills }), routine: true });
    }
    if (changes.length) await this.commit(changes, 'printed');
  }

  /** Every bill of a year with what it was billed and what is due, for the payments page. */
  async ledger(year: string): Promise<LedgerRow[]> {
    const types = await this.billTypes();
    const out: LedgerRow[] = [];
    for (const r of await this.records(year)) {
      for (const b of r.bills) {
        const sums = billSums(b);
        const last = (b.payments ?? []).filter((p) => p.kind === 'received').map((p) => p.date).sort().pop();
        out.push({
          year, client: r.name, serial: r.serial, billNo: r.billNo, folder: b.type, tab: types.find((t) => t.folder === b.type)?.tab ?? b.type,
          bill: b.name, ...sums, lastPaid: last, printed: b.printed,
        });
      }
    }
    return out;
  }

  /** The Bill No. to offer for a new client of a year (see nextBillNo). */
  async suggestBillNo(year: string): Promise<{ next: number; from: 'this year' | 'the year before' | 'none' }> {
    const prev = previousYear(year);
    const before = prev && (await this.years()).includes(prev) ? await this.records(prev) : [];
    return nextBillNo((await this.records(year)).map((r) => r.billNo), before.map((r) => r.billNo));
  }

  // ---------- client details ----------

  async clientDetails(year: string, client: string): Promise<ClientDetails> {
    const r = await this.get(year, client);
    return (await this.vault.readJson<ClientDetails>([CLIENTS, `${r.id}.dat`]).catch(() => null)) ?? {};
  }

  /** Saves the optional details (the same in every year of the client). Empty fields are dropped. */
  async saveClientDetails(year: string, client: string, d: ClientDetails): Promise<void> {
    const r = await this.get(year, client);
    const clean: ClientDetails = {};
    for (const k of DETAIL_FIELDS) {
      const v = sanitize(d[k] ?? '').trim();
      if (v) clean[k] = k === 'pan' || k === 'gstin' ? v.toUpperCase() : v;
    }
    const empty = Object.keys(clean).length === 0;
    await this.commit([{ path: [CLIENTS, `${r.id}.dat`], after: empty ? null : enc.encode(JSON.stringify(clean)) }], `details of ${client}`);
  }

  // ---------- tabs ----------

  async renameBillType(folder: string, rawTab: string): Promise<void> {
    await this.updateSettings((s) => {
      const t = s.billTypes.find((x) => x.folder === folder);
      if (!t) throw new UserError('No such tab.');
      const name = checkTabName(rawTab, s.billTypes.filter((x) => x !== t));
      // The drop-down list belongs to the tab by its title.
      s.dropdowns = s.dropdowns.map((d) => (sameName(d.tab, t.tab) ? { ...d, tab: name } : d));
      t.tab = name;
    });
  }

  async setBillTypeOrder(folders: string[]): Promise<void> {
    await this.updateSettings((s) => {
      s.billTypes = [...s.billTypes].sort((a, b) => folders.indexOf(a.folder) - folders.indexOf(b.folder));
    });
  }

  async setBillTypeHidden(folder: string, hidden: boolean): Promise<void> {
    await this.updateSettings((s) => {
      s.billTypes = s.billTypes.map((t) => (t.folder === folder ? (hidden ? { ...t, hidden: true } : { folder: t.folder, tab: t.tab }) : t));
    });
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

  /** `from`'s client as it would be copied into `to`, with its S.No., Bill No. and bills carried forward. */
  private async copyOf(from: string, name: string, taken: Set<string>): Promise<ClientYear> {
    const src = await this.get(from, name);
    return { v: VERSION, id: taken.has(src.id) ? newId() : src.id, name: src.name, serial: src.serial, billNo: src.billNo, bills: await this.carriedBills(from, src.id) };
  }

  async copyClients(from: string, to: string, names: string[], onProgress?: (done: number) => void): Promise<void> {
    if (from === to) throw new UserError('Choose two different years.');
    await this.assertYear(to);
    let done = 0;
    for (const name of names) {
      const dest = await this.records(to);
      const old = dest.find((r) => sameName(r.name, name));
      const copy = await this.copyOf(from, name, new Set(dest.filter((r) => r !== old).map((r) => r.id)));
      if (old) await this.toBin({ kind: 'client', year: to, record: old });
      await this.commit([...(old && old.id !== copy.id ? [this.drop(to, old)] : []), this.put(to, copy)], `copy ${name} to ${to}`);
      onProgress?.(++done);
    }
  }

  async copyClientToNextYear(year: string, name: string): Promise<string | null> {
    const next = nextYear(year);
    if (!next || !(await this.years()).includes(next)) return null;
    const taken = new Set((await this.records(next)).map((r) => r.id));
    await this.write(next, await this.copyOf(year, name, taken), `copy ${name} to ${next}`);
    return next;
  }

  // ---------- deleted clients and bills ----------

  private lastBin = 0;

  private async toBin(e: { kind: 'client'; year: string; record: ClientYear } | { kind: 'bill'; year: string; clientId: string; clientName: string; bill: StoredBill }): Promise<void> {
    // Strictly later than the one before, so the bin lists them in the order they were deleted.
    const at = (this.lastBin = Math.max(this.now(), this.lastBin + 1));
    await this.vault.writeJson([BIN, `${stamp(at)}-${newId()}.dat`], { ...e, at });
  }

  /** What was deleted in the last 30 days, newest first. */
  async bin(): Promise<BinEntry[]> {
    const out: BinEntry[] = [];
    for (const f of await this.vault.list([BIN])) {
      if (f.kind !== 'file') continue;
      try {
        const e = await this.vault.readJson<BinEntry>([BIN, f.name]);
        if (e) out.push({ ...e, file: f.name });
      } catch {
        // Damaged entries are not offered.
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  private async purgeBin(): Promise<void> {
    for (const e of await this.bin()) if (this.now() - e.at > BIN_DAYS * DAY) await this.vault.remove([BIN, e.file]);
  }

  /** Puts a deleted client or bill back. Returns a message saying what was restored. */
  async restore(e: BinEntry): Promise<string> {
    if (!(await this.years()).includes(e.year)) throw new UserError(`The year ${e.year} no longer exists.`);
    const recs = await this.records(e.year);
    if (e.kind === 'client') {
      const r = e.record;
      if (recs.some((x) => sameName(x.name, r.name))) throw new UserError(`${e.year} already has a client called ${r.name}. Rename that one first.`);
      // Back to its place: lettered numbers did not move anyone, numbers did.
      const plan = planInsert(entriesOf(recs), r.name, !endsWithDigit(r.serial) && r.serial !== '');
      const id = recs.some((x) => x.id === r.id) ? newId() : r.id;
      await this.commit([...this.serialChanges(e.year, recs, plan.updates), this.put(e.year, { ...r, id, serial: plan.serial })], `restore ${r.name}`);
      await this.vault.remove([BIN, e.file]);
      return `${r.name} (${e.year}) is back, S.No. ${plan.serial}.`;
    }
    const r = recs.find((x) => x.id === e.clientId) ?? recs.find((x) => sameName(x.name, e.clientName));
    if (!r) throw new UserError(`${e.clientName} is no longer in ${e.year}. Restore the client first.`);
    if (r.bills.some((b) => sameName(b.type, e.bill.type) && sameName(b.name, e.bill.name))) {
      throw new UserError(`${r.name} already has a bill called ${e.bill.name}. Rename that one first.`);
    }
    await this.write(e.year, { ...r, bills: [...r.bills, e.bill] }, `restore bill ${e.bill.name}`);
    await this.vault.remove([BIN, e.file]);
    return `The bill ${e.bill.name} of ${r.name} (${e.year}) is back.`;
  }

  // ---------- open clients ----------

  private async lockPath(year: string, name: string): Promise<string[]> {
    return [OPEN, `${await this.vault.key.name(`${year}|${name.toUpperCase()}`)}.lock`];
  }

  /** Who has this client open, or null (also when that computer has stopped saying so). */
  async lockInfo(year: string, name: string): Promise<LockInfo | null> {
    let l: { computer: Computer; since: number; beat: number } | null;
    try {
      l = await this.vault.readJson(await this.lockPath(year, name));
    } catch {
      return null;
    }
    if (!l || this.now() - l.beat > LOCK_STALE) return null;
    return { computer: l.computer, since: l.since, mine: l.computer.id === this.computer.id };
  }

  async isLocked(year: string, name: string): Promise<boolean> {
    return (await this.lockInfo(year, name)) !== null;
  }

  async lock(year: string, name: string): Promise<void> {
    const t = this.now();
    await this.vault.writeJson(await this.lockPath(year, name), { computer: this.computer, year, name, since: t, beat: t });
  }

  /** Says again that this computer still has the client open (see LOCK_STALE); not if it was released. */
  async heartbeat(year: string, name: string): Promise<void> {
    const path = await this.lockPath(year, name);
    const l = await this.vault.readJson<{ computer: Computer; since: number; beat: number }>(path).catch(() => null);
    // Not when released meanwhile, or taken over elsewhere ("Open anyway").
    if (!l || l.computer.id !== this.computer.id) return;
    await this.vault.writeJson(path, { computer: this.computer, year, name, since: l.since, beat: this.now() });
  }

  /** Every client marked open (also by other computers, also stale ones), as [year, name]. */
  async openClients(): Promise<[string, string][]> {
    const out: [string, string][] = [];
    for (const f of await this.vault.list([OPEN])) {
      const l = await this.vault.readJson<{ year: string; name: string }>([OPEN, f.name]).catch(() => null);
      if (l?.year) out.push([l.year, l.name]);
    }
    return out;
  }

  async unlock(year: string, name: string): Promise<void> {
    const path = await this.lockPath(year, name);
    const l = await this.vault.readJson<{ computer: Computer }>(path).catch(() => null);
    if (!l || l.computer.id === this.computer.id) await this.vault.remove(path);
  }

  // ---------- problem log ----------

  private logPath(): string[] {
    return [LOGS, `${new Date(this.now()).toISOString().slice(0, 7)} ${this.computer.id}.dat`];
  }

  /** Adds a line to this computer's problem log (kept short). Never fails. */
  async log(message: string): Promise<void> {
    try {
      const path = this.logPath();
      const old = (await this.vault.readText(path).catch(() => null)) ?? '';
      const line = `${new Date(this.now()).toISOString()} ${this.computer.name || this.computer.id}: ${message.replace(/\s+/g, ' ')}\n`;
      await this.vault.writeText(path, (old + line).slice(-100_000));
    } catch {
      // Logging must never get in the way.
    }
  }

  /** The problem logs of every computer, oldest first. */
  async logText(): Promise<string> {
    const files = (await this.vault.list([LOGS])).filter((e) => e.kind === 'file').map((e) => e.name).sort();
    const lines: string[] = [];
    for (const f of files) lines.push(...((await this.vault.readText([LOGS, f]).catch(() => null)) ?? '').split('\n').filter((l) => l));
    return lines.sort().join('\n');
  }

  // ---------- backups ----------

  /** Paths of the data files: the settings, client files and kept desktop files. */
  async dataPaths(): Promise<string[][]> {
    const out: string[][] = [[SETTINGS]];
    for (const y of await this.vault.list([YEARS])) {
      if (y.kind !== 'directory') continue;
      for (const f of await this.vault.list([YEARS, y.name])) if (f.kind === 'file' && f.name.endsWith('.dat')) out.push([YEARS, y.name, f.name]);
    }
    for (const f of await this.vault.list([CLIENTS])) if (f.kind === 'file') out.push([CLIENTS, f.name]);
    for (const f of await this.vault.list([EXTRAS])) if (f.kind === 'file') out.push([EXTRAS, f.name]);
    return out;
  }

  /**
   * Replaces the data with `files` (path -> decrypted contents) in one safe
   * change: files not listed are removed, years not listed are emptied.
   * `settings` decides what of the restored settings to take.
   */
  async replaceData(files: Map<string, Uint8Array>, years: string[], settings: (restored: Settings, current: Settings) => Settings): Promise<void> {
    const current = await this.settings();
    const changes: Change[] = [];
    for (const p of await this.dataPaths()) if (!files.has(p.join('/'))) changes.push({ path: p, after: null });
    for (const [k, v] of files) {
      const after = k === SETTINGS ? enc.encode(JSON.stringify(settings(parseSettings(JSON.parse(dec.decode(v))), current))) : v;
      changes.push({ path: k.split('/'), after });
    }
    for (const y of years) await this.addYear(y);
    await this.commit(changes, 'restore a backup');
    for (const y of await this.years()) {
      if (!years.includes(y) && (await this.vault.list([YEARS, y])).length === 0) await this.vault.remove([YEARS, y]);
    }
    this.cache.clear();
    this.ids.clear();
  }
}

/** Methods that change the data (serialized per WebBooks; none calls another). */
const CHANGES = [
  'setPassword', 'setRecoveryCode', 'saveLetterhead', 'saveDropdowns', 'setBackupPath', 'addBillType', 'renameBillType', 'setBillTypeOrder',
  'setBillTypeHidden', 'setDriveDaily', 'noteDriveBackup', 'setBillNo', 'addClient', 'deleteClients', 'modifyClient', 'writeBill', 'createBill', 'renameBill',
  'deleteBill', 'addPayment', 'removePayment', 'markPrinted', 'saveClientDetails', 'copyClients', 'copyClientToNextYear', 'restore',
  'restoreDamaged', 'replaceData',
] as const satisfies readonly (keyof WebBooks)[];

function entriesOf(recs: ClientYear[]): SerialEntry[] {
  return recs.map((r) => ({ name: r.name, serial: r.serial }));
}
