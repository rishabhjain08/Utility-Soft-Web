// Files that live in the program folder (next to billing.jar).
import {
  decodeCipherLines, decodeCipherValue, decodePlainLines, encodeCipherLines, encodeCipherValue,
  encodePlain, encodePlainLines, sanitize,
} from './codec';
import { FsDir, tryRead, writeFile } from './fs';
import { sameName } from './sort';

export const FILES = {
  pass: 'pass.txt',
  impinfo: 'impinfo.txt',
  ddown: 'ddown.txt',
  backupto: 'backupto.txt',
  loaddatafrom: 'loaddatafrom.txt',
} as const;

export interface BillType {
  /** Folder name inside each client folder. */
  folder: string;
  /** Tab title shown to the user (also the key in ddown.txt). */
  tab: string;
}

export interface Letterhead {
  /** Right-hand block on bills (e.g. "For ABC & Co.", "Chartered Accountants"). */
  firmName: string[];
  /** Left-hand block on bills (address lines); "Date : ..." follows it. */
  firmAddress: string[];
  /** Up to three title lines for the index sheet; "##" is replaced by the year. */
  indexTitles: [string, string, string];
}

export const DEFAULT_BILL_TYPES: BillType[] = [
  { folder: 'Audit', tab: 'Audit' },
  { folder: 'Vat', tab: 'Vat' },
  { folder: 'Tax', tab: 'Tax' },
  { folder: 'Others', tab: 'Others' },
];

// ---------- password ----------

export async function readPassword(program: FsDir): Promise<string | null> {
  const b = await tryRead(program, FILES.pass);
  return b === null ? null : decodeCipherValue(b);
}

export async function writePassword(program: FsDir, password: string): Promise<void> {
  await writeFile(program, FILES.pass, encodeCipherValue(password));
}

// ---------- impinfo.txt ----------
// line 0: (folder^tab)(folder^tab)...
// line 1: ~firm name line%~line%...
// line 2: ~address line%~line%...
// line 3: %$title1%$title2%$title3%$

export async function readImpinfo(program: FsDir): Promise<string[] | null> {
  const b = await tryRead(program, FILES.impinfo);
  return b === null ? null : decodeCipherLines(b);
}

async function writeImpinfo(program: FsDir, lines: string[]): Promise<void> {
  await writeFile(program, FILES.impinfo, encodeCipherLines(lines));
}

export function parseBillTypes(line: string | undefined): BillType[] {
  const out: BillType[] = [];
  if (!line) return out;
  const re = /\(([^^()]*)\^([^()]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ folder: m[1], tab: m[2] });
  return out;
}

export function formatBillTypes(types: BillType[]): string {
  return types.map((t) => `(${t.folder}^${t.tab})`).join('');
}

function parseBlock(line: string | undefined): string[] {
  if (!line) return [];
  const parts = line.split('%');
  parts.pop(); // text after the last '%'
  return parts.map((p) => (p.startsWith('~') ? p.slice(1) : p));
}

function formatBlock(lines: string[]): string {
  const clean = lines.map((l) => sanitize(l).replace(/%/g, ''));
  if (clean.length === 0) clean.push('');
  return clean.map((l) => `~${l}%`).join('');
}

function parseTitles(line: string | undefined): [string, string, string] {
  const out: [string, string, string] = ['', '', ''];
  if (!line) return out;
  const parts = line.split('%$');
  // "%$a%$b%$c%$" -> ['', 'a', 'b', 'c', '']
  for (let i = 0; i < 3; i++) out[i] = parts[i + 1] ?? '';
  return out;
}

function formatTitles(t: string[]): string {
  const clean = [0, 1, 2].map((i) => sanitize(t[i] ?? '').replace(/%\$/g, '% $'));
  return `%$${clean[0]}%$${clean[1]}%$${clean[2]}%$`;
}

export function letterheadFromImpinfo(lines: string[] | null): Letterhead | null {
  if (!lines || lines.length < 2) return null;
  return {
    firmName: parseBlock(lines[1]),
    firmAddress: parseBlock(lines[2]),
    indexTitles: parseTitles(lines[3]),
  };
}

export function billTypesFromImpinfo(lines: string[] | null): BillType[] {
  return parseBillTypes(lines?.[0]);
}

/** Java asks for the letterhead (registration) when impinfo.txt has no second line. */
export function needsLetterhead(lines: string[] | null): boolean {
  return !lines || lines.length < 2;
}

export async function writeLetterhead(program: FsDir, lh: Letterhead): Promise<void> {
  const lines = (await readImpinfo(program)) ?? [];
  const typesLine = lines[0] ?? formatBillTypes(DEFAULT_BILL_TYPES);
  const rest = lines.slice(4);
  await writeImpinfo(program, [typesLine, formatBlock(lh.firmName), formatBlock(lh.firmAddress), formatTitles(lh.indexTitles), ...rest]);
}

export async function writeBillTypes(program: FsDir, types: BillType[]): Promise<void> {
  const lines = (await readImpinfo(program)) ?? [];
  lines[0] = formatBillTypes(types);
  await writeImpinfo(program, lines);
}

// ---------- ddown.txt (plain text) ----------
// One line per tab: "TabTitle^item^item..."; "##" stands for the year.

export async function readDropdownLines(program: FsDir): Promise<string[]> {
  const b = await tryRead(program, FILES.ddown);
  return b === null ? [] : decodePlainLines(b);
}

export function dropdownItems(lines: string[], tab: string): string[] {
  for (const line of lines) {
    const i = line.indexOf('^');
    if (i !== -1 && sameName(line.slice(0, i), tab)) return line.slice(i + 1).split('^').filter((s) => s !== '');
  }
  return [];
}

/** Replaces the lists for the given tabs, keeping lines for other tabs untouched. */
export async function writeDropdowns(program: FsDir, types: BillType[], lists: Map<string, string[]>): Promise<void> {
  const old = await readDropdownLines(program);
  const out: string[] = [];
  for (const t of types) {
    const items = (lists.get(t.tab) ?? dropdownItems(old, t.tab))
      .map((s) => sanitize(s).replace(/\^/g, ' ').trim())
      .filter((s) => s !== '');
    out.push([t.tab, ...items].join('^'));
  }
  for (const line of old) {
    const key = line.includes('^') ? line.slice(0, line.indexOf('^')) : line;
    if (!types.some((t) => sameName(t.tab, key)) && line.trim() !== '') out.push(line);
  }
  await writeFile(program, FILES.ddown, encodePlainLines(out));
}

// ---------- backupto.txt (shifted) ----------

export async function readBackupPath(program: FsDir): Promise<string> {
  const b = await tryRead(program, FILES.backupto);
  return b === null ? '' : decodeCipherValue(b);
}

export async function writeBackupPath(program: FsDir, path: string): Promise<void> {
  await writeFile(program, FILES.backupto, encodeCipherValue(path));
}

// ---------- loaddatafrom.txt (plain text) ----------
// Empty: data is in <program>/data. Otherwise line 1 is the data folder path
// (absolute, or relative to the program folder) and line 2 is "1".

export async function readDataPath(program: FsDir): Promise<string> {
  const b = await tryRead(program, FILES.loaddatafrom);
  return b === null ? '' : (decodePlainLines(b)[0] ?? '').trim();
}

export async function writeDataPath(program: FsDir, path: string): Promise<void> {
  await writeFile(program, FILES.loaddatafrom, path === '' ? new Uint8Array() : encodePlain(`${path}\r\n1`));
}

/** True for paths Java resolves against the program folder (no drive, root or UNC prefix). */
export function isRelativePath(p: string): boolean {
  return p !== '' && !/^([a-zA-Z]:|[\\/])/.test(p);
}

export function pathParts(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
}
