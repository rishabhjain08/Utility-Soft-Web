import {
  BillType, FILES, Letterhead, isRelativePath, pathParts, readDataPath, readPassword, writePassword,
} from '../core/config';
import { FsDir, ensureDir, exists, findEntry, walk, writeFile } from '../core/fs';
import { BILLS, LOCKS, Workspace } from '../core/workspace';
import { WebBooks, isWebStore } from '../core/webstore';
import { rememberedPath } from './folders';

/** The bills: in the desktop (Java) layout or in the web format. */
export type Books = Workspace | WebBooks;

export interface Session {
  /** The folder opened: the desktop program folder, or the web data folder. */
  program: FsDir;
  ws: Books;
  /** Where the data is, for display (Java's "Data Loaded From"). */
  dataLabel: string;
  types: BillType[];
  letterhead: Letterhead | null;
  /** The password typed to open it (needed to export for the desktop version, which stores it). */
  password: string;
}

/** Anything with a password: a desktop program folder or a web data folder. */
export interface PasswordStore {
  checkPassword(password: string): Promise<boolean>;
  setPassword(password: string): Promise<void>;
}

/** A folder that was opened, before the password is entered. */
export type Place = { kind: 'desktop'; dir: FsDir } | { kind: 'web'; dir: FsDir };

export function passwordStore(place: Place): PasswordStore {
  if (place.kind === 'web') return new WebBooks(place.dir);
  return { checkPassword: (p) => checkPassword(place.dir, p), setPassword: (p) => writePassword(place.dir, p) };
}

export type FolderKind = 'program' | 'web' | 'new' | 'not-program';

/** Is this a web data folder, the Java program folder, an empty folder or something else? */
export async function inspectProgram(dir: FsDir): Promise<{ kind: FolderKind; hasPassword: boolean }> {
  if (await isWebStore(dir)) return { kind: 'web', hasPassword: true };
  const hasPassword = await exists(dir, FILES.pass, 'file');
  const hasImpinfo = await exists(dir, FILES.impinfo, 'file');
  if (hasPassword || hasImpinfo) return { kind: 'program', hasPassword };
  const entries = await dir.list();
  if (entries.length === 0) return { kind: 'new', hasPassword: false };
  return { kind: 'not-program', hasPassword: false };
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

export async function openSession(program: FsDir, data: FsDir, label: string, password: string): Promise<Session> {
  const ws = new Workspace(program, data);
  await ws.repairBillTypes();
  return refreshSession({ program, ws, dataLabel: label, types: [], letterhead: null, password });
}

export async function openWebSession(dir: FsDir, password: string): Promise<Session> {
  return refreshSession({ program: dir, ws: new WebBooks(dir), dataLabel: dir.name, types: [], letterhead: null, password });
}

export async function refreshSession(s: Session): Promise<Session> {
  return { ...s, types: await s.ws.billTypes(), letterhead: await s.ws.letterhead() };
}

/**
 * The data folder of a desktop installation, found without changing anything
 * (for copying it). `data` is null when there is none yet; `path` alone means the
 * folder (outside the program folder) must be selected first.
 */
export async function findDesktopData(program: FsDir): Promise<{ data: FsDir | null; label: string } | { path: string }> {
  const path = await readDataPath(program);
  if (path === '') return { data: await walk(program, ['data']), label: `${program.name}\\data` };
  if (isRelativePath(path)) return { data: await walk(program, pathParts(path)), label: `${program.name}\\${pathParts(path).join('\\')}` };
  const remembered = await rememberedPath('data', path, true);
  return remembered ? { data: remembered, label: path } : { path };
}
