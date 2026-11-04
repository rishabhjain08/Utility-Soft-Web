import { BillType, FILES, Letterhead, isRelativePath, pathParts, readDataPath, readPassword } from '../core/config';
import { FsDir, exists, walk } from '../core/fs';
import { Computer, WebBooks, isWebStore } from '../core/webstore';
import { dailyBackup } from '../core/backup';
import { kvGet, kvSet } from './kv';
import { rememberedPath } from './folders';

export interface Session {
  /** The data folder. */
  root: FsDir;
  ws: WebBooks;
  /** The folder's name, for display. */
  dataLabel: string;
  types: BillType[];
  letterhead: Letterhead | null;
  /** The password typed to open it (an export for the desktop version stores it in pass.txt). */
  password: string;
}

export type FolderKind = 'program' | 'web' | 'new' | 'not-program';

/** Is this a web data folder, a desktop (Java) program folder, an empty folder or something else? */
export async function inspectProgram(dir: FsDir): Promise<{ kind: FolderKind; hasPassword: boolean }> {
  if (await isWebStore(dir)) return { kind: 'web', hasPassword: true };
  const hasPassword = await exists(dir, FILES.pass, 'file');
  const hasImpinfo = await exists(dir, FILES.impinfo, 'file');
  if (hasPassword || hasImpinfo) return { kind: 'program', hasPassword };
  const entries = await dir.list();
  if (entries.length === 0) return { kind: 'new', hasPassword: false };
  return { kind: 'not-program', hasPassword: false };
}

/** The desktop version's own password check (before its folder is copied). */
export async function checkDesktopPassword(program: FsDir, password: string): Promise<boolean> {
  return (await readPassword(program)) === password;
}

// ---------- this computer ----------

/** This browser's identity, shown to other computers when it has a client open. */
export async function thisComputer(): Promise<Computer> {
  const c = await kvGet<Computer>('computer');
  if (c?.id) return c;
  const fresh: Computer = { id: Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join(''), name: '' };
  await kvSet('computer', fresh);
  return fresh;
}

export async function nameThisComputer(name: string): Promise<Computer> {
  const c = { ...(await thisComputer()), name: name.trim() };
  await kvSet('computer', c);
  return c;
}

// ---------- opening ----------

/**
 * A session on unlocked data: finishes changes a computer was making when it
 * stopped, and makes today's automatic backup in the background.
 */
export async function openWebSession(ws: WebBooks, password: string): Promise<Session> {
  const r = await ws.open();
  if (r.skipped) await ws.log(`${r.skipped} interrupted changes were not finished: the files had changed since.`);
  dailyBackup(ws).catch((e) => ws.log(`Automatic backup failed: ${e instanceof Error ? e.message : e}`));
  return refreshSession({ root: ws.root, ws, dataLabel: ws.root.name, types: [], letterhead: null, password });
}

export async function unlock(dir: FsDir, password: string): Promise<WebBooks | null> {
  return WebBooks.unlock(dir, password, { computer: await thisComputer() });
}

export async function unlockWithRecovery(dir: FsDir, code: string): Promise<WebBooks | null> {
  return WebBooks.unlockWithRecovery(dir, code, { computer: await thisComputer() });
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
