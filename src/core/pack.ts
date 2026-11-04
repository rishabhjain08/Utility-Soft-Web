// A backup folder packed into one file (to keep in Google Drive), and an
// in-memory folder to unpack it into.
//
// The file: "USWPACK1" | 4-byte length | JSON header { files: [{ path, size }] } | the files' bytes.
// The files are the backup's own (already encrypted); their paths reveal nothing.

import { Entry, FsDir, NotFoundError } from './fs';

const MAGIC = new TextEncoder().encode('USWPACK1');

/** Every file under `dir`, with its path. */
async function files(dir: FsDir, prefix: string[] = []): Promise<{ path: string; data: Uint8Array }[]> {
  const out: { path: string; data: Uint8Array }[] = [];
  for (const e of await dir.list()) {
    if (e.kind === 'directory') out.push(...(await files(await dir.dir(e.name), [...prefix, e.name])));
    else out.push({ path: [...prefix, e.name].join('/'), data: await dir.read(e.name) });
  }
  return out;
}

export async function pack(dir: FsDir): Promise<Uint8Array> {
  const all = await files(dir);
  // Empty folders (an empty year) are kept too.
  const dirs: string[] = [];
  const walk = async (d: FsDir, prefix: string[]) => {
    for (const e of await d.list()) {
      if (e.kind !== 'directory') continue;
      dirs.push([...prefix, e.name].join('/'));
      await walk(await d.dir(e.name), [...prefix, e.name]);
    }
  };
  await walk(dir, []);
  const header = new TextEncoder().encode(JSON.stringify({ dirs, files: all.map((f) => ({ path: f.path, size: f.data.length })) }));
  const total = MAGIC.length + 4 + header.length + all.reduce((t, f) => t + f.data.length, 0);
  const out = new Uint8Array(total);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, header.length);
  out.set(header, MAGIC.length + 4);
  let at = MAGIC.length + 4 + header.length;
  for (const f of all) {
    out.set(f.data, at);
    at += f.data.length;
  }
  return out;
}

/** The packed folder, as a folder in memory (null when it is not a pack). */
export function unpack(data: Uint8Array): MemDir | null {
  if (data.length < MAGIC.length + 4 || !MAGIC.every((b, i) => data[i] === b)) return null;
  const len = new DataView(data.buffer, data.byteOffset).getUint32(MAGIC.length);
  let header: { dirs?: string[]; files: { path: string; size: number }[] };
  try {
    header = JSON.parse(new TextDecoder().decode(data.subarray(MAGIC.length + 4, MAGIC.length + 4 + len)));
  } catch {
    return null;
  }
  const root = new MemDir('backup');
  for (const d of header.dirs ?? []) root.ensure(d.split('/'));
  let at = MAGIC.length + 4 + len;
  for (const f of header.files) {
    if (at + f.size > data.length) return null;
    const parts = f.path.split('/');
    root.ensure(parts.slice(0, -1)).files.set(parts[parts.length - 1], data.slice(at, at + f.size));
    at += f.size;
  }
  return root;
}

/** A folder held in memory. */
export class MemDir implements FsDir {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Map<string, MemDir>();
  constructor(readonly name: string) {}

  ensure(parts: string[]): MemDir {
    let d: MemDir = this;
    for (const p of parts) {
      let next = d.dirs.get(p);
      if (!next) d.dirs.set(p, (next = new MemDir(p)));
      d = next;
    }
    return d;
  }

  async list(): Promise<Entry[]> {
    return [...[...this.dirs.keys()].map((name) => ({ name, kind: 'directory' as const })), ...[...this.files.keys()].map((name) => ({ name, kind: 'file' as const }))];
  }

  async dir(name: string, create = false): Promise<FsDir> {
    const d = this.dirs.get(name);
    if (d) return d;
    if (!create) throw new NotFoundError(name);
    return this.ensure([name]);
  }

  async read(name: string): Promise<Uint8Array> {
    const f = this.files.get(name);
    if (!f) throw new NotFoundError(name);
    return f;
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    this.files.set(name, data.slice());
  }

  async remove(name: string): Promise<void> {
    this.files.delete(name);
    this.dirs.delete(name);
  }

  async stat(name: string) {
    const f = this.files.get(name);
    if (!f) throw new NotFoundError(name);
    return { size: f.length, modified: 0 };
  }
}

/** Writes a folder held in memory into a real (empty) folder. */
export async function writeOut(from: MemDir, to: FsDir): Promise<void> {
  for (const [name, data] of from.files) await to.write(name, data);
  for (const [name, d] of from.dirs) await writeOut(d, await to.dir(name, true));
}
