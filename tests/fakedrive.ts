// A stand-in for the Google Drive API (the calls core/drive.ts makes), for tests.
export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  data: Uint8Array;
  trashed?: boolean;
}

export class FakeDrive {
  files = new Map<string, FakeFile>();
  pending = new Map<string, Omit<FakeFile, 'data'>>();
  calls: string[] = [];
  private seq = 0;
  token = 'good';

  private json(v: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
  }

  /** Handles a request like Google would; `auth` is the Authorization header. */
  async handle(method: string, url: string, auth: string | null, body: Uint8Array | string | null): Promise<Response> {
    const u = new URL(url);
    this.calls.push(`${method} ${u.pathname}`);
    if (auth !== `Bearer ${this.token}`) return this.json({ error: { message: 'Invalid Credentials' } }, { status: 401 });
    const id = /\/files\/([^/?]+)/.exec(u.pathname)?.[1];
    if (method === 'GET' && u.pathname === '/drive/v3/files') {
      const q = u.searchParams.get('q') ?? '';
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const store = /key='store' and value='([^']+)'/.exec(q)?.[1];
      const files = [...this.files.values()].filter(
        (f) => !f.trashed && (!parent || f.parents.includes(parent)) && (!name || f.name === name) && (!store || f.appProperties.store === store) && f.appProperties.app === 'utility-soft',
      );
      return this.json({ files: files.map((f) => ({ id: f.id, name: f.name, size: String(f.data.length), appProperties: f.appProperties })) });
    }
    if (method === 'POST' && u.pathname === '/drive/v3/files') {
      const meta = JSON.parse(body as string);
      const f: FakeFile = { id: `f${++this.seq}`, name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? [], appProperties: meta.appProperties ?? {}, data: new Uint8Array() };
      this.files.set(f.id, f);
      return this.json({ id: f.id });
    }
    if (method === 'POST' && u.pathname === '/upload/drive/v3/files') {
      const meta = JSON.parse(body as string);
      const up = `u${++this.seq}`;
      this.pending.set(up, { id: `f${++this.seq}`, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, appProperties: meta.appProperties });
      return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${up}` } });
    }
    if (method === 'PUT' && u.pathname === '/upload/drive/v3/files') {
      const p = this.pending.get(u.searchParams.get('upload_id') ?? '');
      if (!p) return this.json({ error: { message: 'no such upload' } }, { status: 404 });
      this.files.set(p.id, { ...p, data: body as Uint8Array });
      return this.json({ id: p.id });
    }
    if (method === 'GET' && id && u.searchParams.get('alt') === 'media') {
      const f = this.files.get(id);
      return f ? new Response(f.data as BodyInit) : this.json({ error: { message: 'not found' } }, { status: 404 });
    }
    if (method === 'DELETE' && id) {
      this.files.delete(id);
      return new Response(null, { status: 204 });
    }
    return this.json({ error: { message: `unexpected ${method} ${u.pathname}` } }, { status: 400 });
  }

  fetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = init?.body;
    const b = body instanceof Uint8Array ? body : typeof body === 'string' ? body : body ? new Uint8Array(await new Response(body as BodyInit).arrayBuffer()) : null;
    return this.handle(init?.method ?? 'GET', String(input), headers.get('Authorization'), b);
  };
}
