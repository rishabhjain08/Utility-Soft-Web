// Test-only stand-in for the browser folder picker. showDirectoryPicker()
// returns handles backed by real folders on disk (through an exposed Node
// function), so the end-to-end tests exercise the app against real files that
// the Java program can then open.
import { Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export class FolderPicker {
  private queue: string[] = [];
  constructor(private page: Page) {}

  /** The folder returned by the next showDirectoryPicker() call. */
  next(path: string) {
    this.queue.push(path);
  }

  async install() {
    await this.page.exposeFunction('__fsrpc', (op: string, a: string, b?: string, data?: string) => this.rpc(op, a, b, data));
    await this.page.addInitScript(shimSource);
  }

  private rpc(op: string, a: string, b?: string, data?: string): unknown {
    switch (op) {
      case 'pick': {
        const p = this.queue.shift();
        if (!p) return { error: 'AbortError' };
        return { path: p };
      }
      case 'list':
        return readdirSync(a, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? 'directory' : 'file']);
      case 'dir': {
        const p = join(a, b!);
        if (data === 'create') mkdirSync(p, { recursive: true });
        try {
          if (statSync(p).isDirectory()) return { path: p };
          return { error: 'TypeMismatchError' };
        } catch {
          return { error: 'NotFoundError' };
        }
      }
      case 'file': {
        const p = join(a, b!);
        try {
          if (!statSync(p).isFile()) return { error: 'TypeMismatchError' };
          return { path: p };
        } catch {
          if (data === 'create') {
            writeFileSync(p, Buffer.alloc(0));
            return { path: p };
          }
          return { error: 'NotFoundError' };
        }
      }
      case 'read':
        return [readFileSync(a).toString('base64'), statSync(a).mtimeMs];
      case 'write':
        writeFileSync(a, Buffer.from(data ?? '', 'base64'));
        return true;
      case 'remove': {
        const p = join(a, b!);
        try {
          statSync(p);
        } catch {
          return { error: 'NotFoundError' };
        }
        rmSync(p, { recursive: true, force: true });
        return true;
      }
      case 'resolve': {
        const r = relative(a, b!);
        if (r.startsWith('..') || r.startsWith(sep)) return null;
        return r === '' ? [] : r.split(sep);
      }
    }
    return { error: 'unknown op' };
  }
}

const shimSource = `(() => {
  const rpc = (...args) => window.__fsrpc(...args);
  const fail = (r) => { if (r && r.error) { const e = new Error(r.error); e.name = r.error; throw e; } return r; };
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
  const base = (p) => p.split('/').filter(Boolean).pop() || p;
  class FileH {
    constructor(path) { this.path = path; this.name = base(path); this.kind = 'file'; }
    async getFile() { const [b, mtime] = await rpc('read', this.path); return new File([unb64(b)], this.name, { lastModified: Math.floor(mtime) }); }
    async createWritable() {
      const path = this.path; const parts = [];
      return {
        async write(d) { parts.push(d instanceof Uint8Array ? d : new Uint8Array(d.buffer ? d.buffer : d)); },
        async close() { const n = parts.reduce((a, p) => a + p.length, 0); const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; } await rpc('write', path, '', b64(all)); },
      };
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
  }
  class DirH {
    // The function-valued property makes the handle non-cloneable, so it is not remembered in IndexedDB.
    constructor(path) { this.path = path; this.name = base(path); this.kind = 'directory'; this.noClone = () => 0; }
    async *entries() { for (const [n, k] of await rpc('list', this.path)) yield [n, k === 'directory' ? new DirH(this.path + '/' + n) : new FileH(this.path + '/' + n)]; }
    async getDirectoryHandle(n, o) { return new DirH(fail(await rpc('dir', this.path, n, o && o.create ? 'create' : '')).path); }
    async getFileHandle(n, o) { return new FileH(fail(await rpc('file', this.path, n, o && o.create ? 'create' : '')).path); }
    async removeEntry(n) { fail(await rpc('remove', this.path, n)); }
    async resolve(other) { return rpc('resolve', this.path, other.path); }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
  }
  window.showDirectoryPicker = async () => new DirH(fail(await rpc('pick', '')).path);
})();`;
