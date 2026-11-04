// Backups kept in Google Drive: each one a single packed file (core/pack.ts) in a
// "Utility Soft backups" folder. The app can only see the files it made there
// (the drive.file permission), and the files are encrypted: Google cannot read them.

import { UserError } from './names';

const API = 'https://www.googleapis.com';
export const DRIVE_FOLDER = 'Utility Soft backups';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';

export interface DriveBackup {
  id: string;
  name: string;
  size: number;
  /** When the backup was made (ms). */
  at: number;
  /** Which data it is of (see storeId), and its folder name, for showing. */
  store: string;
  label: string;
}

/** Calls the Drive API with an access token (asked for again once if it has expired). */
export class Drive {
  private folderId: string | null = null;

  constructor(
    private token: (fresh: boolean) => Promise<string>,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async call(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const t = await this.token(!retry);
    const res = await this.fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t}` } });
    if (res.status === 401 && retry) return this.call(url, init, false);
    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        // No details.
      }
      if (res.status === 403 && /quota|storage/i.test(detail)) throw new UserError('Google Drive is full. Free some space in Drive and try again.');
      throw new UserError(`Google Drive did not accept this (${res.status}${detail ? `: ${detail}` : ''}).`);
    }
    return res;
  }

  /** The app's folder in Drive, made the first time. */
  async folder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const q = encodeURIComponent(`name = '${DRIVE_FOLDER}' and mimeType = '${FOLDER_TYPE}' and trashed = false and appProperties has { key='app' and value='utility-soft' }`);
    const found = (await (await this.call(`${API}/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`)).json()) as { files: { id: string }[] };
    if (found.files.length) return (this.folderId = found.files[0].id);
    const made = (await (
      await this.call(`${API}/drive/v3/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: FOLDER_TYPE, appProperties: { app: 'utility-soft' } }),
      })
    ).json()) as { id: string };
    return (this.folderId = made.id);
  }

  /** The backups in Drive (of one data folder, or of all), newest first. */
  async list(store?: string): Promise<DriveBackup[]> {
    const folder = await this.folder();
    let q = `'${folder}' in parents and trashed = false and appProperties has { key='app' and value='utility-soft' }`;
    if (store) q += ` and appProperties has { key='store' and value='${store}' }`;
    const out: DriveBackup[] = [];
    let page = '';
    do {
      const res = (await (
        await this.call(`${API}/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,size,appProperties)&pageSize=200${page ? `&pageToken=${page}` : ''}`)
      ).json()) as { nextPageToken?: string; files: { id: string; name: string; size?: string; appProperties?: Record<string, string> }[] };
      for (const f of res.files) {
        out.push({ id: f.id, name: f.name, size: Number(f.size ?? 0), at: Number(f.appProperties?.at ?? 0), store: f.appProperties?.store ?? '', label: f.appProperties?.label ?? '' });
      }
      page = res.nextPageToken ?? '';
    } while (page);
    return out.sort((a, b) => b.at - a.at);
  }

  /** Uploads a packed backup (resumable, so large ones work too). */
  async upload(name: string, data: Uint8Array, meta: { at: number; store: string; label: string }): Promise<string> {
    const folder = await this.folder();
    const start = await this.call(`${API}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(data.length) },
      body: JSON.stringify({
        name,
        parents: [folder],
        mimeType: 'application/octet-stream',
        appProperties: { app: 'utility-soft', at: String(meta.at), store: meta.store, label: meta.label.slice(0, 100) },
      }),
    });
    const location = start.headers.get('Location');
    if (!location) throw new UserError('Google Drive did not start the upload. Try again.');
    const done = (await (await this.call(location, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data as BodyInit })).json()) as { id: string };
    return done.id;
  }

  async download(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.call(`${API}/drive/v3/files/${id}?alt=media`)).arrayBuffer());
  }

  async remove(id: string): Promise<void> {
    await this.call(`${API}/drive/v3/files/${id}`, { method: 'DELETE' });
  }
}
