// Encrypted files inside the web data folder, addressed by path (a list of
// folder names and the file name). Every file is encrypted with the data key,
// with its path authenticated (see core/crypto.ts).

import { DataKey } from './crypto';
import { Entry, FileStat, FsDir, NotFoundError, isNotFound } from './fs';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Vault {
  constructor(
    readonly root: FsDir,
    readonly key: DataKey,
  ) {}

  /**
   * The folder at `parts`, or null when it does not exist (and `create` is not set).
   * The app makes all the names itself, so they are opened directly (without
   * listing the folder, which can hold thousands of client files).
   */
  async dir(parts: string[], create = false): Promise<FsDir | null> {
    let d: FsDir = this.root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('/');
      const known = this.dirs.get(key);
      if (known) {
        d = known;
        continue;
      }
      try {
        d = await d.dir(parts[i], create);
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
      this.dirs.set(key, d);
    }
    return d;
  }

  /** Folders already opened, by path (forgotten when removed). */
  private dirs = new Map<string, FsDir>();

  async list(parts: string[]): Promise<Entry[]> {
    const d = await this.dir(parts);
    return d ? d.list() : [];
  }

  /** The stored (encrypted) bytes, or null. */
  async readRaw(path: string[]): Promise<Uint8Array | null> {
    const d = await this.dir(path.slice(0, -1));
    if (!d) return null;
    try {
      return await d.read(path[path.length - 1]);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async writeRaw(path: string[], data: Uint8Array): Promise<void> {
    const d = (await this.dir(path.slice(0, -1), true))!;
    try {
      await d.write(path[path.length - 1], data);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      // The folder was removed (by another computer) after it was opened here: open it again.
      this.forget(path.slice(0, -1));
      await (await this.dir(path.slice(0, -1), true))!.write(path[path.length - 1], data);
    }
  }

  private forget(parts: string[]): void {
    const key = parts.join('/');
    for (const k of this.dirs.keys()) if (k === key || k.startsWith(`${key}/`) || key.startsWith(`${k}/`)) this.dirs.delete(k);
  }

  /** Decrypted contents, or null when the file does not exist. Throws DamagedError. */
  async read(path: string[]): Promise<Uint8Array | null> {
    const raw = await this.readRaw(path);
    return raw === null ? null : this.key.decrypt(path.join('/'), raw);
  }

  async write(path: string[], plain: Uint8Array): Promise<void> {
    await this.writeRaw(path, await this.key.encrypt(path.join('/'), plain));
  }

  async readText(path: string[]): Promise<string | null> {
    const b = await this.read(path);
    return b === null ? null : dec.decode(b);
  }

  async writeText(path: string[], text: string): Promise<void> {
    await this.write(path, enc.encode(text));
  }

  async readJson<T>(path: string[]): Promise<T | null> {
    const t = await this.readText(path);
    return t === null ? null : (JSON.parse(t) as T);
  }

  async writeJson(path: string[], value: unknown): Promise<void> {
    await this.writeText(path, JSON.stringify(value));
  }

  async remove(path: string[]): Promise<void> {
    const d = await this.dir(path.slice(0, -1));
    if (d) await d.remove(path[path.length - 1]);
    this.forget(path);
  }

  async stat(path: string[]): Promise<FileStat | null> {
    const d = await this.dir(path.slice(0, -1));
    if (!d?.stat) return null;
    try {
      return await d.stat(path[path.length - 1]);
    } catch (e) {
      if (isNotFound(e) || e instanceof NotFoundError) return null;
      throw e;
    }
  }
}
