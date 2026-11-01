// FsDir over a real folder, for tests and the Java compatibility checks.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { Entry, FsDir, NotFoundError } from '../src/core/fs';

export class NodeDir implements FsDir {
  constructor(readonly path: string) {}

  get name() {
    return this.path.split(sep).pop() ?? '';
  }

  async list(): Promise<Entry[]> {
    const ents = await readdir(this.path, { withFileTypes: true });
    return ents.map((e) => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' }));
  }

  async dir(name: string, create = false): Promise<FsDir> {
    const p = join(this.path, name);
    if (create) await mkdir(p, { recursive: true });
    const ents = await readdir(this.path, { withFileTypes: true });
    if (!ents.some((e) => e.name === name && e.isDirectory())) throw new NotFoundError(name);
    return new NodeDir(p);
  }

  async read(name: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(join(this.path, name)));
    } catch {
      throw new NotFoundError(name);
    }
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    await writeFile(join(this.path, name), data);
  }

  async remove(name: string): Promise<void> {
    await rm(join(this.path, name), { recursive: true, force: true });
  }

  async resolve(other: FsDir): Promise<string[] | null> {
    if (!(other instanceof NodeDir)) return null;
    const r = relative(this.path, other.path);
    if (r.startsWith('..')) return null;
    return r === '' ? [] : r.split(sep);
  }
}
