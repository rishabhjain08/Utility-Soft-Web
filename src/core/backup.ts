// Backups of the web data: a folder with copies of the (encrypted) data files,
// utility-soft.json, and backup.json, which lists a SHA-256 of every file so a
// damaged backup is noticed before it is used. A backup folder can also be
// opened like the original, with the password or recovery code of that time.
//
// Automatic backups are made once a day inside the data folder (backups/),
// keeping 7 daily, 4 weekly and 12 monthly ones.

import { DamagedError, sha256 } from './crypto';
import { FsDir, readOnly, tryDir, tryRead, writeFile } from './fs';
import { UserError } from './names';
import { BACKUPS, MANIFEST, WebBooks } from './webstore';
import { Vault } from './vault';

export const BACKUP_INFO = 'backup.json';

interface BackupFile {
  format: 'utility-soft-backup';
  at: number;
  years: string[];
  files: Record<string, string>;
}

export interface BackupEntry {
  dir: FsDir;
  at: number;
  files: number;
}

const enc = new TextEncoder();

async function folder(root: FsDir, parts: string[], create: boolean): Promise<FsDir | null> {
  let d: FsDir | null = root;
  for (const p of parts) d = d ? (create ? await d.dir(p, true) : await tryDir(d, p)) : null;
  return d;
}

/** Copies the data into `dest` (an empty folder) and checks the copy. */
export async function makeBackup(web: WebBooks, dest: FsDir, opts: { now?: number; onFile?: () => void } = {}): Promise<void> {
  if ((await dest.list()).length > 0) throw new UserError(`The folder ${dest.name} is not empty.`);
  const files: Record<string, string> = {};
  const copy = async (parts: string[], bytes: Uint8Array) => {
    const d = (await folder(dest, parts.slice(0, -1), true))!;
    await d.write(parts[parts.length - 1], bytes);
    files[parts.join('/')] = await sha256(bytes);
    opts.onFile?.();
  };
  const manifest = await tryRead(web.root, MANIFEST);
  if (!manifest) throw new UserError('This is not a Utility Soft data folder.');
  await copy([MANIFEST], manifest);
  for (const p of await web.dataPaths()) {
    const raw = await web.vault.readRaw(p);
    if (raw) await copy(p, raw);
  }
  const years = await web.years();
  for (const y of years) await folder(dest, ['years', y], true);
  // Read back what was written before calling it a backup.
  const broken = await brokenFiles(dest, files);
  if (broken.length) throw new UserError(`The backup could not be written correctly (${broken[0]}). Try another folder.`);
  const info: BackupFile = { format: 'utility-soft-backup', at: opts.now ?? Date.now(), years, files };
  await writeFile(dest, BACKUP_INFO, enc.encode(JSON.stringify(info, null, 1)));
}

async function brokenFiles(dir: FsDir, files: Record<string, string>): Promise<string[]> {
  const broken: string[] = [];
  for (const [path, hash] of Object.entries(files)) {
    const parts = path.split('/');
    const d = await folder(dir, parts.slice(0, -1), false);
    const b = d ? await tryRead(d, parts[parts.length - 1]) : null;
    if (!b || (await sha256(b)) !== hash) broken.push(path);
  }
  return broken;
}

async function readInfo(dir: FsDir): Promise<BackupFile | null> {
  const b = await tryRead(dir, BACKUP_INFO);
  if (!b) return null;
  try {
    const info = JSON.parse(new TextDecoder().decode(b)) as BackupFile;
    return info.format === 'utility-soft-backup' ? info : null;
  } catch {
    return null;
  }
}

export async function isBackup(dir: FsDir): Promise<boolean> {
  return (await readInfo(dir)) !== null;
}

/** Files of a backup that are missing or changed since it was made. */
export async function checkBackup(dir: FsDir): Promise<string[]> {
  const info = await readInfo(dir);
  if (!info) throw new UserError(`${dir.name} is not a Utility Soft backup.`);
  return brokenFiles(dir, info.files);
}

/** The backups in a folder (each in its own subfolder), newest first. */
export async function listBackups(parent: FsDir): Promise<BackupEntry[]> {
  const out: BackupEntry[] = [];
  for (const e of await parent.list()) {
    if (e.kind !== 'directory') continue;
    const dir = await parent.dir(e.name);
    const info = await readInfo(dir);
    if (info) out.push({ dir, at: info.at, files: Object.keys(info.files).length });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Which backups to keep: the newest, and the newest of each of the last 7 days, 4 weeks and 12 months. */
export function backupsToKeep(ats: number[]): Set<number> {
  const sorted = [...ats].sort((a, b) => b - a);
  const keep = new Set<number>(sorted.slice(0, 1));
  const by = (key: (d: Date) => string, n: number) => {
    const seen = new Set<string>();
    for (const t of sorted) {
      const k = key(new Date(t));
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > n) break;
      keep.add(t);
    }
  };
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const week = (d: Date) => {
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    return day(monday);
  };
  by(day, 7);
  by(week, 4);
  by((d) => `${d.getFullYear()}-${d.getMonth()}`, 12);
  return keep;
}

/** Removes backups in `parent` that are no longer needed (only ones made by the app). */
export async function pruneBackups(parent: FsDir): Promise<number> {
  const list = await listBackups(parent);
  const keep = backupsToKeep(list.map((b) => b.at));
  let removed = 0;
  for (const b of list) {
    if (!keep.has(b.at)) {
      await parent.remove(b.dir.name);
      removed++;
    }
  }
  return removed;
}

const stampName = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};

/** The automatic backups inside the data folder. */
export async function insideBackups(web: WebBooks): Promise<FsDir> {
  return (await web.vault.dir([BACKUPS], true))!;
}

/** Makes today's automatic backup inside the data folder, if there is none yet. True when one was made. */
export async function dailyBackup(web: WebBooks, now = Date.now()): Promise<boolean> {
  const parent = await insideBackups(web);
  const [last] = await listBackups(parent);
  if (last && new Date(last.at).toDateString() === new Date(now).toDateString()) return false;
  await backupInside(web, now);
  return true;
}

/** A backup inside the data folder now (for example before restoring another one). */
export async function backupInside(web: WebBooks, now = Date.now()): Promise<FsDir> {
  const parent = await insideBackups(web);
  let name = stampName(now);
  for (let i = 2; await tryDir(parent, name); i++) name = `${stampName(now)} (${i})`;
  const dir = await parent.dir(name, true);
  await makeBackup(web, dir, { now });
  await pruneBackups(parent);
  return dir;
}

/** A backup as data that can be read (with the current key) but not changed. */
export function openBackup(web: WebBooks, dir: FsDir): WebBooks {
  return new WebBooks(new Vault(readOnly(dir), web.vault.key), { computer: web.computer });
}

/**
 * Replaces the current data with a backup's, after checking it. The current
 * data is backed up first, so a restore can itself be undone.
 * The password, and the auto-backup folder of this computer, stay as they are.
 */
export async function restoreBackup(web: WebBooks, dir: FsDir, now = Date.now()): Promise<void> {
  const broken = await checkBackup(dir);
  if (broken.length) throw new UserError(`This backup is damaged (${broken.length} file${broken.length === 1 ? '' : 's'}, for example ${broken[0]}). Choose another one.`);
  const backup = openBackup(web, dir);
  const files = new Map<string, Uint8Array>();
  try {
    for (const p of await backup.dataPaths()) {
      const b = await backup.vault.read(p);
      if (b) files.set(p.join('/'), b);
    }
  } catch (e) {
    if (e instanceof DamagedError) throw new UserError('This backup is of other Utility Soft data (made with another key), so it cannot be restored here. Open it on its own instead.');
    throw e;
  }
  if (!files.has('settings.dat')) throw new UserError('This backup has no settings; it cannot be restored.');
  const years = await backup.years();
  // (Everything is read before this: keeping only one backup a day may remove the one being restored.)
  await backupInside(web, now);
  await web.replaceData(files, years, (restored, current) => ({ ...restored, autoBackup: current.autoBackup }));
}
