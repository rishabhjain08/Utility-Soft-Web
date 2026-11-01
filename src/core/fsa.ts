// File System Access API implementation of FsDir (Chrome).
import { Entry, FsDir, NotFoundError } from './fs';

export class FsaDir implements FsDir {
  constructor(readonly handle: FileSystemDirectoryHandle) {}

  get name() {
    return this.handle.name;
  }

  async list(): Promise<Entry[]> {
    const out: Entry[] = [];
    const entries = (this.handle as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, h] of entries) {
      out.push({ name, kind: h.kind });
    }
    return out;
  }

  async dir(name: string, create = false): Promise<FsDir> {
    try {
      return new FsaDir(await this.handle.getDirectoryHandle(name, { create }));
    } catch (e) {
      throw wrap(e, name);
    }
  }

  async read(name: string): Promise<Uint8Array> {
    try {
      const file = await (await this.handle.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      throw wrap(e, name);
    }
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    const fh = await this.handle.getFileHandle(name, { create: true });
    // createWritable writes to a temporary file and swaps it in on close,
    // so a crash never leaves a half-written file behind.
    const w = await fh.createWritable();
    await w.write(data as unknown as BufferSource);
    await w.close();
  }

  async remove(name: string): Promise<void> {
    try {
      await this.handle.removeEntry(name, { recursive: true });
    } catch (e) {
      if (e instanceof Error && e.name === 'NotFoundError') return;
      throw e;
    }
  }

  async resolve(other: FsDir): Promise<string[] | null> {
    if (!(other instanceof FsaDir)) return null;
    return this.handle.resolve(other.handle);
  }
}

function wrap(e: unknown, name: string): unknown {
  if (e instanceof Error && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return new NotFoundError(name);
  return e;
}
