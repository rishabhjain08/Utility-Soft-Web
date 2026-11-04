// Minimal directory abstraction. The browser implementation wraps the File
// System Access API; tests use a Node implementation over a real folder.

export type EntryKind = 'file' | 'directory';

export interface Entry {
  name: string;
  kind: EntryKind;
}

export interface FsDir {
  readonly name: string;
  list(): Promise<Entry[]>;
  /** Opens a child directory. Throws NotFoundError unless create is set. */
  dir(name: string, create?: boolean): Promise<FsDir>;
  /** Reads a child file. Throws NotFoundError when missing. */
  read(name: string): Promise<Uint8Array>;
  /** Creates or replaces a child file. */
  write(name: string, data: Uint8Array): Promise<void>;
  /** Removes a child file or directory (recursively). Missing entries are ignored. */
  remove(name: string): Promise<void>;
  /** Path components from this directory to a descendant handle, or null if not inside. */
  resolve?(other: FsDir): Promise<string[] | null>;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`Not found: ${what}`);
    this.name = 'NotFoundError';
  }
}

export function isNotFound(e: unknown): boolean {
  return e instanceof Error && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');
}

/** Finds a child entry by exact name, falling back to a case-insensitive match (Windows semantics). */
export async function findEntry(dir: FsDir, name: string, kind?: EntryKind): Promise<Entry | null> {
  const entries = await dir.list();
  const ok = (e: Entry) => !kind || e.kind === kind;
  return (
    entries.find((e) => e.name === name && ok(e)) ??
    entries.find((e) => e.name.toLowerCase() === name.toLowerCase() && ok(e)) ??
    null
  );
}

export async function exists(dir: FsDir, name: string, kind?: EntryKind): Promise<boolean> {
  return (await findEntry(dir, name, kind)) !== null;
}

export async function tryDir(dir: FsDir, name: string): Promise<FsDir | null> {
  const e = await findEntry(dir, name, 'directory');
  return e ? dir.dir(e.name) : null;
}

export async function tryRead(dir: FsDir, name: string): Promise<Uint8Array | null> {
  const e = await findEntry(dir, name, 'file');
  return e ? dir.read(e.name) : null;
}

/** Opens (or creates) a directory, reusing an existing entry that differs only in case. */
export async function ensureDir(dir: FsDir, name: string): Promise<FsDir> {
  const e = await findEntry(dir, name, 'directory');
  return dir.dir(e ? e.name : name, true);
}

/** Opens a nested path of directories; returns null if any part is missing. */
export async function walk(dir: FsDir, parts: string[]): Promise<FsDir | null> {
  let cur: FsDir | null = dir;
  for (const p of parts) {
    if (!cur) return null;
    cur = await tryDir(cur, p);
  }
  return cur;
}

/** Writes a file, replacing an existing entry that differs only in case. */
export async function writeFile(dir: FsDir, name: string, data: Uint8Array): Promise<void> {
  const e = await findEntry(dir, name, 'file');
  await dir.write(e ? e.name : name, data);
}

export async function removeEntry(dir: FsDir, name: string): Promise<void> {
  const e = await findEntry(dir, name);
  if (e) await dir.remove(e.name);
}

/** Copies every file and folder in `from` into `to`, byte for byte. */
export async function copyTree(from: FsDir, to: FsDir, onFile?: () => void): Promise<void> {
  for (const e of await from.list()) {
    if (e.kind === 'directory') {
      await copyTree(await from.dir(e.name), await ensureDir(to, e.name), onFile);
    } else {
      await writeFile(to, e.name, await from.read(e.name));
      onFile?.();
    }
  }
}

export async function listDirs(dir: FsDir): Promise<string[]> {
  return (await dir.list()).filter((e) => e.kind === 'directory').map((e) => e.name);
}

export async function listFiles(dir: FsDir): Promise<string[]> {
  return (await dir.list()).filter((e) => e.kind === 'file').map((e) => e.name);
}

export class ReadOnlyError extends Error {
  constructor(what: string) {
    super(`Not changed (read only): ${what}`);
    this.name = 'ReadOnlyError';
  }
}

/**
 * The same folder, but every attempt to write, create or remove anything in it
 * (or below it) throws. Used for the desktop folder while it is migrated or
 * compared, so it cannot be changed even by mistake.
 */
export function readOnly(dir: FsDir): FsDir {
  const ro: FsDir = {
    get name() {
      return dir.name;
    },
    list: () => dir.list(),
    async dir(name: string, create = false) {
      try {
        return readOnly(await dir.dir(name, false));
      } catch (e) {
        if (create && isNotFound(e)) throw new ReadOnlyError(name);
        throw e;
      }
    },
    read: (name: string) => dir.read(name),
    async write(name: string) {
      throw new ReadOnlyError(name);
    },
    async remove(name: string) {
      throw new ReadOnlyError(name);
    },
  };
  if (dir.resolve) ro.resolve = (other: FsDir) => dir.resolve!(other);
  return ro;
}
