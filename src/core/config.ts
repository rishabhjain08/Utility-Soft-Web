// Files of the desktop (Java) program folder, next to billing.jar (read when moving to
// the web format; an export writes them, see core/migrate.ts). Also the formats of
// what is kept from them in the web format: letterhead, tabs, drop-down lists.
import { decodeCipherLines, decodeCipherValue, decodePlainLines, sanitize } from './codec';
import { FsDir, tryRead } from './fs';
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


// ---------- impinfo.txt ----------
// line 0: (folder^tab)(folder^tab)...
// line 1: ~firm name line%~line%...
// line 2: ~address line%~line%...
// line 3: %$title1%$title2%$title3%$

export async function readImpinfo(program: FsDir): Promise<string[] | null> {
  const b = await tryRead(program, FILES.impinfo);
  return b === null ? null : decodeCipherLines(b);
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

export function formatBlock(lines: string[]): string {
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

export function formatTitles(t: string[]): string {
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

/** Lines 1-3 of impinfo.txt for a letterhead. */
export function letterheadLines(lh: Letterhead): string[] {
  return [formatBlock(lh.firmName), formatBlock(lh.firmAddress), formatTitles(lh.indexTitles)];
}

/** The letterhead as it reads back after being stored (characters impinfo.txt cannot hold are removed). */
export function cleanLetterhead(lh: Letterhead): Letterhead {
  return letterheadFromImpinfo(['', ...letterheadLines(lh)])!;
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

export const DEFAULT_DROPDOWNS = [
  'Audit^Fee for Tax Audit for the Assessment Year ##^Expenses',
  'Vat^Fee for VAT Audit for the Assessment Year ##^Expenses',
  'Tax^Fee for IT Return for the Assessment Year ##^Fee for filing of Form No. 15G & 15H^Fee for Service Tax Return for the Period ^Expenses',
  'Others^Fee for Partnership Deed dated ^Fee for Retirement Deed dated ^Fee for Dissolution Deed dated ^Fee for Gift Deed dated ^Expenses',
];


/** ddown.txt lines with the lists for `types` replaced (other lines are kept). */
export function mergeDropdowns(old: string[], types: BillType[], lists: Map<string, string[]>): string[] {
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
  return out;
}

// ---------- backupto.txt (shifted) ----------

export async function readBackupPath(program: FsDir): Promise<string> {
  const b = await tryRead(program, FILES.backupto);
  return b === null ? '' : decodeCipherValue(b);
}


// ---------- loaddatafrom.txt (plain text) ----------
// Empty: data is in <program>/data. Otherwise line 1 is the data folder path
// (absolute, or relative to the program folder) and line 2 is "1".

export async function readDataPath(program: FsDir): Promise<string> {
  const b = await tryRead(program, FILES.loaddatafrom);
  return b === null ? '' : (decodePlainLines(b)[0] ?? '').trim();
}


/** True for paths Java resolves against the program folder (no drive, root or UNC prefix). */
export function isRelativePath(p: string): boolean {
  return p !== '' && !/^([a-zA-Z]:|[\\/])/.test(p);
}

export function pathParts(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
}
