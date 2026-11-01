import { encodeCipherLines, encodePlainLines } from '../core/codec';
import {
  BillType, DEFAULT_BILL_TYPES, FILES, Letterhead, formatBillTypes, isRelativePath, letterheadFromImpinfo, pathParts,
  readDataPath, readImpinfo, readPassword, writePassword,
} from '../core/config';
import { FsDir, ensureDir, exists, findEntry, walk, writeFile } from '../core/fs';
import { BILLS, LOCKS, Workspace } from '../core/workspace';
import { rememberedPath } from './folders';

export interface Session {
  program: FsDir;
  data: FsDir;
  ws: Workspace;
  /** Where the data is, for display (Java's "Data Loaded From"). */
  dataLabel: string;
  types: BillType[];
  letterhead: Letterhead | null;
}

export type FolderKind = 'program' | 'new' | 'not-program';

/** Is this the Java program folder? */
export async function inspectProgram(dir: FsDir): Promise<{ kind: FolderKind; hasPassword: boolean }> {
  const hasPassword = await exists(dir, FILES.pass, 'file');
  const hasImpinfo = await exists(dir, FILES.impinfo, 'file');
  if (hasPassword || hasImpinfo) return { kind: 'program', hasPassword };
  const entries = await dir.list();
  if (entries.length === 0) return { kind: 'new', hasPassword: false };
  return { kind: 'not-program', hasPassword: false };
}

const DEFAULT_DROPDOWNS = [
  'Audit^Fee for Tax Audit for the Assessment Year ##^Expenses',
  'Vat^Fee for VAT Audit for the Assessment Year ##^Expenses',
  'Tax^Fee for IT Return for the Assessment Year ##^Fee for filing of Form No. 15G & 15H^Fee for Service Tax Return for the Period ^Expenses',
  'Others^Fee for Partnership Deed dated ^Fee for Retirement Deed dated ^Fee for Dissolution Deed dated ^Fee for Gift Deed dated ^Expenses',
];

/** Creates the files of a new Utility Soft installation in an empty folder. */
export async function createProgram(dir: FsDir, password: string): Promise<void> {
  await writePassword(dir, password);
  if (!(await exists(dir, FILES.impinfo, 'file'))) await writeFile(dir, FILES.impinfo, encodeCipherLines([formatBillTypes(DEFAULT_BILL_TYPES)]));
  if (!(await exists(dir, FILES.ddown, 'file'))) await writeFile(dir, FILES.ddown, encodePlainLines(DEFAULT_DROPDOWNS));
  if (!(await exists(dir, FILES.loaddatafrom, 'file'))) await writeFile(dir, FILES.loaddatafrom, new Uint8Array());
  if (!(await exists(dir, FILES.backupto, 'file'))) await writeFile(dir, FILES.backupto, new Uint8Array());
  await prepareDataFolder(await ensureDir(dir, 'data'));
}

/** Makes sure a data folder has bills/ and activelocation.txt. */
export async function prepareDataFolder(dir: FsDir): Promise<void> {
  await ensureDir(dir, BILLS);
  if (!(await findEntry(dir, LOCKS, 'file'))) await writeFile(dir, LOCKS, new Uint8Array());
}

export async function checkPassword(program: FsDir, password: string): Promise<boolean> {
  return (await readPassword(program)) === password;
}

export type DataResolution =
  | { ok: true; data: FsDir; label: string }
  | { ok: false; path: string; reason: 'missing-relative' | 'needs-folder' };

/** Finds the data folder named by loaddatafrom.txt. */
export async function resolveData(program: FsDir): Promise<DataResolution> {
  const path = await readDataPath(program);
  if (path === '') {
    const data = await ensureDir(program, 'data');
    await prepareDataFolder(data);
    return { ok: true, data, label: `${program.name}\\data` };
  }
  if (isRelativePath(path)) {
    const data = await walk(program, pathParts(path));
    if (!data) return { ok: false, path, reason: 'missing-relative' };
    await prepareDataFolder(data);
    return { ok: true, data, label: `${program.name}\\${pathParts(path).join('\\')}` };
  }
  const remembered = await rememberedPath('data', path);
  if (remembered) {
    await prepareDataFolder(remembered);
    return { ok: true, data: remembered, label: path };
  }
  return { ok: false, path, reason: 'needs-folder' };
}

/** A folder looks like a data folder if it has bills/ (or is empty). */
export async function looksLikeData(dir: FsDir): Promise<boolean> {
  if (await exists(dir, BILLS, 'directory')) return true;
  return (await dir.list()).length === 0;
}

export async function openSession(program: FsDir, data: FsDir, label: string): Promise<Session> {
  const ws = new Workspace(program, data);
  await ws.repairBillTypes();
  return refreshSession({ program, data, ws, dataLabel: label, types: [], letterhead: null });
}

export async function refreshSession(s: Session): Promise<Session> {
  const lines = await readImpinfo(s.program);
  return { ...s, types: await s.ws.billTypes(), letterhead: letterheadFromImpinfo(lines) };
}
