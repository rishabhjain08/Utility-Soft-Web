// The desktop (Java) program's folders, read when moving to the web format or
// comparing, and written only by an export (see core/migrate.ts):
//   <program>/pass.txt, impinfo.txt, ddown.txt, backupto.txt, loaddatafrom.txt   (core/config.ts)
//   <data>/activelocation.txt                       "year,NAME" per open client (plain)
//   <data>/bills/<YY-YY>/<CLIENT>/serialno.txt      S.No. (shifted, no newline)
//   <data>/bills/<YY-YY>/<CLIENT>/billfromto.txt    Bill No. (shifted, no newline)
//   <data>/bills/<YY-YY>/<CLIENT>/<TypeFolder>/<BILL>.txt  bill rows (shifted)

import { decodeCipherLines, decodeCipherValue, encodeCipherLines } from './codec';
import { BillType, billTypesFromImpinfo, readImpinfo } from './config';
import { FsDir, listDirs, listFiles, pick, tryDir, writeFile } from './fs';
import { protectForJava } from './bill';
import { sameName, sortStrings } from './sort';
import { isYear, previousYears } from './years';
import { mapLimit } from './util';

export const BILLS = 'bills';
export const LOCKS = 'activelocation.txt';
export const SERIAL = 'serialno.txt';
export const BILLNO = 'billfromto.txt';
/** Temporary file the Java program uses while merging bills. */
export const JAVA_TEMP = '1q2m.txt';

export interface DesktopClient {
  name: string;
  serial: string;
  billNo: string;
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

/**
 * The bill types of a desktop folder. When impinfo.txt lists none (the Java
 * registration "Cancel" button wipes that line), the folders on disk.
 */
export async function desktopBillTypes(program: FsDir, data: FsDir | null): Promise<BillType[]> {
  const types = billTypesFromImpinfo(await readImpinfo(program));
  if (types.length || !data) return types;
  return (await billTypeFoldersOnDisk(data)).map((f) => ({ folder: f, tab: f }));
}

/**
 * Reads a desktop data folder the way the Java program does. Folders are looked
 * up once and remembered (it is read, or only has bill files rewritten).
 */
export class DesktopData {
  private dirs = new Map<string, Promise<FsDir | null>>();
  private files = new Map<string, Promise<Map<string, string>>>();

  constructor(readonly data: FsDir) {}

  /** The folder at `parts` (each found as the Java program would on Windows: exact, else ignoring case). */
  private folder(parts: string[]): Promise<FsDir | null> {
    const key = parts.join('/');
    let p = this.dirs.get(key);
    if (!p) {
      p = parts.length === 0 ? Promise.resolve(this.data) : this.folder(parts.slice(0, -1)).then(async (parent) => {
        if (!parent) return null;
        const name = parts[parts.length - 1];
        const names = await this.dirNames(parent, parts.slice(0, -1).join('/'));
        const e = names.get(name) ?? names.get(name.toLowerCase());
        return e ? parent.dir(e) : null;
      });
      this.dirs.set(key, p);
    }
    return p;
  }

  private dirNames(dir: FsDir, key: string): Promise<Map<string, string>> {
    let p = this.files.get(`d:${key}`);
    if (!p) {
      p = dir.list().then((entries) => {
        const m = new Map<string, string>();
        for (const e of entries) if (e.kind === 'directory') m.set(e.name, e.name);
        for (const e of entries) if (e.kind === 'directory' && !m.has(e.name.toLowerCase())) m.set(e.name.toLowerCase(), e.name);
        return m;
      });
      this.files.set(`d:${key}`, p);
    }
    return p;
  }

  async years(): Promise<string[]> {
    const b = await this.folder([BILLS]);
    return b ? sortStrings((await listDirs(b)).filter(isYear)) : [];
  }

  async clientNames(year: string): Promise<string[]> {
    const y = await this.folder([BILLS, year]);
    return y ? sortStrings(await listDirs(y)) : [];
  }

  async clients(year: string): Promise<DesktopClient[]> {
    const y = await this.folder([BILLS, year]);
    if (!y) return [];
    return mapLimit(sortStrings(await listDirs(y)), 16, async (name) => {
      const d = (await this.folder([BILLS, year, name]))!;
      const entries = await d.list();
      const read = async (f: string) => {
        const e = pick(entries, f, 'file');
        return e ? decodeCipherValue(await d.read(e.name)) : '';
      };
      return { name, serial: await read(SERIAL), billNo: await read(BILLNO) };
    });
  }

  private typeDir(year: string, client: string, folder: string): Promise<FsDir | null> {
    return this.folder([BILLS, year, client, folder]);
  }

  /** File names in a bill-type folder, remembered. */
  private billFiles(year: string, client: string, folder: string): Promise<string[]> {
    const key = `f:${year}/${client}/${folder}`;
    let p = this.files.get(key) as unknown as Promise<string[]> | undefined;
    if (!p) {
      p = this.typeDir(year, client, folder).then((d) => (d ? listFiles(d) : []));
      this.files.set(key, p as unknown as Promise<Map<string, string>>);
    }
    return p;
  }

  async bills(year: string, client: string, folder: string): Promise<string[]> {
    const files = (await this.billFiles(year, client, folder)).filter((f) => /\.txt$/i.test(f) && f.toLowerCase() !== JAVA_TEMP);
    return sortStrings(files).map((f) => f.slice(0, -4));
  }

  /** A bill's lines as stored ("text,amount"), or null. */
  async readBillLines(year: string, client: string, folder: string, bill: string): Promise<string[] | null> {
    const d = await this.typeDir(year, client, folder);
    if (!d) return null;
    const files = await this.billFiles(year, client, folder);
    const want = `${bill}.txt`;
    const name = files.find((f) => f === want) ?? files.find((f) => f.toLowerCase() === want.toLowerCase());
    return name ? decodeCipherLines(await d.read(name)) : null;
  }

  // ---------- keeping bills openable by the Java program (exports only) ----------

  /** Re-checks one bill file against the previous three years; true if it had to be changed. */
  private async protectBill(year: string, client: string, folder: string, bill: string): Promise<boolean> {
    const lines = await this.readBillLines(year, client, folder, bill);
    if (!lines) return false;
    const previous = await Promise.all(previousYears(year, 3).map((y) => this.readBillLines(y, client, folder, bill)));
    const safe = protectForJava(lines, previous);
    if (safe.every((l, i) => l === lines[i])) return false;
    await writeFile((await this.typeDir(year, client, folder))!, `${bill}.txt`, encodeCipherLines(safe));
    return true;
  }

  /**
   * Adds trailing spaces where the Java program could not open a bill (see
   * protectForJava), oldest year first. Returns how many bills were changed.
   */
  async protectAll(types: BillType[]): Promise<number> {
    let fixed = 0;
    for (const year of await this.years()) {
      for (const client of await this.clientNames(year)) {
        for (const t of types) {
          for (const b of await this.bills(year, client, t.folder)) if (await this.protectBill(year, client, t.folder, b)) fixed++;
        }
      }
    }
    return fixed;
  }
}

