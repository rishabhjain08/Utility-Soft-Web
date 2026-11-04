// Signing in to Google Drive, with Google's own sign-in (Google Identity Services).
// Only the "drive.file" permission is asked for: the app sees just the files it made.
// Google only allows this from the app's web address (not from a file on disk).

import { Drive } from '../core/drive';
import { UserError } from '../core/names';
import { kvGet } from './kv';

/** The app's Google OAuth client id (public; made in Google Cloud, see docs/google-drive-setup.md). */
export const GOOGLE_CLIENT_ID = '';
/** Where the app is published (Google accepts sign-in from here). */
export const APP_URL = 'https://rishabhjain08.github.io/Utility-Soft-Web/';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: string }): void;
}
interface Gis {
  accounts: { oauth2: { initTokenClient(c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }): TokenClient } };
}

export type DriveState = { ok: true } | { ok: false; reason: 'file' | 'setup' | 'offline' };

async function clientId(): Promise<string> {
  return (await kvGet<string>('googleClientId')) || GOOGLE_CLIENT_ID;
}

/** Whether Drive can be used here (and why not). */
export async function driveState(): Promise<DriveState> {
  if (location.protocol === 'file:') return { ok: false, reason: 'file' };
  if (!(await clientId())) return { ok: false, reason: 'setup' };
  if (!navigator.onLine) return { ok: false, reason: 'offline' };
  return { ok: true };
}

export function driveProblem(s: DriveState): string {
  if (s.ok) return '';
  if (s.reason === 'file') return `Google Drive works when Utility Soft is opened from its web address, ${APP_URL} (it still works offline and uses the same folder).`;
  if (s.reason === 'setup') return 'Google Drive is not set up for this copy of Utility Soft yet.';
  return 'There is no internet connection.';
}

let gis: Promise<Gis> | null = null;

function loadGis(): Promise<Gis> {
  const w = window as unknown as { google?: Gis };
  if (w.google?.accounts?.oauth2) return Promise.resolve(w.google);
  gis ??= new Promise<Gis>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (w.google ? resolve(w.google) : reject(new UserError('Google sign-in did not load.')));
    s.onerror = () => {
      gis = null;
      reject(new UserError('Google sign-in could not be loaded. Check the internet connection.'));
    };
    document.head.appendChild(s);
  });
  return gis;
}

let token: { value: string; until: number } | null = null;

/** An access token, asking Google (a small window; the first time, to allow Utility Soft) when there is none. */
async function getToken(fresh: boolean): Promise<string> {
  if (!fresh && token && Date.now() < token.until - 60_000) return token.value;
  const g = await loadGis();
  const id = await clientId();
  return new Promise<string>((resolve, reject) => {
    const client = g.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (r) => {
        if (r.access_token) {
          token = { value: r.access_token, until: Date.now() + (r.expires_in ?? 3600) * 1000 };
          resolve(r.access_token);
        } else reject(new UserError(r.error === 'access_denied' ? 'Google Drive was not allowed.' : 'Google sign-in did not work. Try again.'));
      },
      error_callback: (e) => reject(new UserError(e.type === 'popup_closed' ? 'The Google window was closed.' : 'The Google window could not open. Allow pop-ups for Utility Soft and try again.')),
    });
    client.requestAccessToken({ prompt: token ? '' : undefined });
  });
}

/** The Drive of the signed-in Google account (signing in when first used). */
export function googleDrive(): Drive {
  return new Drive(getToken);
}

/** Forgets the access token (Utility ▸ Backups ▸ "Use another Google account"). */
export function forgetGoogle(): void {
  token = null;
}
