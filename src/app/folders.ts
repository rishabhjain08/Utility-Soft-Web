// Choosing folders and remembering them. Browsers never reveal a folder's full
// path, so for paths the Java program needs (loaddatafrom.txt, backupto.txt)
// we either use a path relative to the program folder (Java resolves those
// against its working folder) or ask the user to type the full path.

import { FsaDir } from '../core/fsa';
import { FsDir } from '../core/fs';
import { kvGet, kvSet } from './kv';

export const supportsFolders = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

type Picker = (opts?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: FileSystemHandle | string }) => Promise<FileSystemDirectoryHandle>;

export async function pickFolder(id: string, startIn?: FsDir): Promise<FsaDir | null> {
  const picker = (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
  try {
    const opts: Parameters<Picker>[0] = { id, mode: 'readwrite' };
    if (startIn instanceof FsaDir) opts.startIn = startIn.handle;
    const h = await picker(opts);
    if (!(await ensurePermission(h, true))) return null;
    return new FsaDir(h);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return null;
    throw e;
  }
}

interface PermissionHandle {
  queryPermission(d: { mode: string }): Promise<PermissionState>;
  requestPermission(d: { mode: string }): Promise<PermissionState>;
}

/** Checks (and with `ask`, requests — needs a user click) read/write access. */
export async function ensurePermission(h: FileSystemHandle, ask: boolean): Promise<boolean> {
  const p = h as unknown as PermissionHandle;
  if (!p.queryPermission) return true;
  if ((await p.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  if (!ask) return false;
  return (await p.requestPermission({ mode: 'readwrite' })) === 'granted';
}

// Remembered handles: the program folder, and folders chosen for a given path text.
const PROGRAM_KEY = 'programFolder';
const pathKey = (kind: string, path: string) => `${kind}:${path.toLowerCase()}`;

export async function rememberProgram(dir: FsaDir): Promise<void> {
  await kvSet(PROGRAM_KEY, dir.handle);
}

export async function rememberedProgram(): Promise<FileSystemDirectoryHandle | undefined> {
  return kvGet<FileSystemDirectoryHandle>(PROGRAM_KEY);
}

export async function rememberPath(kind: 'data' | 'backup', path: string, dir: FsaDir): Promise<void> {
  await kvSet(pathKey(kind, path), dir.handle);
}

/** A remembered folder for this path, if we still have permission (no prompt). */
export async function rememberedPath(kind: 'data' | 'backup', path: string, ask = false): Promise<FsaDir | null> {
  if (!path) return null;
  const h = await kvGet<FileSystemDirectoryHandle>(pathKey(kind, path));
  if (!h) return null;
  return (await ensurePermission(h, ask)) ? new FsaDir(h) : null;
}

export async function hasRememberedPath(kind: 'data' | 'backup', path: string): Promise<boolean> {
  return !!path && !!(await kvGet(pathKey(kind, path)));
}

/** Path of `dir` relative to the program folder (Java style, backslashes), or null. */
export async function relativeTo(program: FsDir, dir: FsDir): Promise<string | null> {
  const parts = program.resolve ? await program.resolve(dir) : null;
  if (!parts) return null;
  return parts.join('\\');
}

/** Web-only preferences. */
export interface Prefs {
  askBackupOnExit: boolean;
}

export async function loadPrefs(): Promise<Prefs> {
  return { askBackupOnExit: true, ...((await kvGet<Partial<Prefs>>('prefs')) ?? {}) };
}

export async function savePrefs(p: Prefs): Promise<void> {
  await kvSet('prefs', p);
}

// Desktop folders already copied to the web format (so opening one again can say so).
interface Migration {
  from: FileSystemDirectoryHandle;
  to: FileSystemDirectoryHandle;
  at: string;
}

export async function rememberMigration(from: FsDir, to: FsDir): Promise<void> {
  if (!(from instanceof FsaDir) || !(to instanceof FsaDir)) return;
  const list = (await kvGet<Migration[]>('migrations')) ?? [];
  await kvSet('migrations', [...list, { from: from.handle, to: to.handle, at: new Date().toISOString() }]);
}

/** The most recent web copy made of this desktop folder, if any. */
export async function migrationOf(dir: FsDir): Promise<{ to: FsaDir; at: Date } | null> {
  if (!(dir instanceof FsaDir)) return null;
  const list = (await kvGet<Migration[]>('migrations')) ?? [];
  for (const m of [...list].reverse()) {
    try {
      if (await m.from.isSameEntry(dir.handle)) return { to: new FsaDir(m.to), at: new Date(m.at) };
    } catch {
      // A folder that no longer exists.
    }
  }
  return null;
}
