// Backups in Google Drive, with stand-ins for Google's sign-in and Drive (tests/fakedrive.ts).
import { test, expect, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataCopy, earlier, expectClients, login, start } from './helpers';
import { FakeDrive } from '../tests/fakedrive';

/** Google's sign-in script and Drive answer from the stand-ins; the app gets a client id. */
async function withGoogle(page: Page, drive: FakeDrive) {
  await page.route('https://accounts.google.com/gsi/client', (r) =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `window.google = { accounts: { oauth2: { initTokenClient: (c) => ({ requestAccessToken: () => { window.__googleAsked = (window.__googleAsked || 0) + 1; setTimeout(() => c.callback({ access_token: 'good', expires_in: 3600 }), 10); } }) } } };`,
    }),
  );
  await page.route('https://www.googleapis.com/**', async (r) => {
    const req = r.request();
    const body = req.method() === 'PUT' ? new Uint8Array(req.postDataBuffer() ?? Buffer.alloc(0)) : req.postData();
    const res = await drive.handle(req.method(), req.url(), req.headers()['authorization'] ?? null, body);
    const headers: Record<string, string> = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Location' };
    res.headers.forEach((v, k) => (headers[k] = v));
    await r.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  });
}

async function setClientId(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const req = indexedDB.open('utility-soft', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => {
          const t = req.result.transaction('kv', 'readwrite');
          t.objectStore('kv').put('test-client.apps.googleusercontent.com', 'googleClientId');
          t.oncomplete = () => resolve();
        };
      }),
  );
  await page.reload();
}

test('back up to Google Drive, every day, and restore from it', async ({ page }) => {
  const fake = new FakeDrive();
  const data = await dataCopy();
  const picker = await start(page);
  await withGoogle(page, fake);
  await setClientId(page);
  await login(page, picker, data.dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);

  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Backups…/ }).click();
  const drive = page.locator('section.drive');
  await expect(drive).toContainText('folder “Utility Soft backups”');
  await drive.getByLabel(/Every day/).check();
  await drive.getByRole('button', { name: 'Back up to Google Drive now' }).click();
  await expect(page.getByText('Backed up to Google Drive.')).toBeVisible();
  expect([...fake.files.values()].filter((f) => f.name.endsWith('.usbackup'))).toHaveLength(1);
  expect([...fake.files.values()].find((f) => f.mimeType === 'application/vnd.google-apps.folder')?.name).toBe('Utility Soft backups');
  await drive.getByRole('button', { name: 'Show the backups in Google Drive' }).click();
  await expect(drive.locator('.backup-list li')).toHaveCount(1);

  // A change, then the Drive backup brings it back.
  await data.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', ['pooja,99']);
  await drive.getByRole('button', { name: 'Compare or restore…' }).click();
  const cmp = page.getByRole('dialog', { name: /^Backup of/ });
  await expect(cmp.locator('tbody tr')).toHaveText(['06-07 › RISHABH › Audit › PREM CHAND, row 1“pooja”, amount “20”“pooja”, amount “99”']);
  await cmp.getByRole('button', { name: 'Restore this backup…' }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText(/Restored the backup of/)).toBeVisible();
  expect(await data.bill('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['pooja,20']);
});

test('the daily Drive backup is offered, and Drive restores onto a new computer', async ({ page, browser }) => {
  const fake = new FakeDrive();
  const data = await dataCopy();
  // Switched on, last made yesterday.
  await earlier(data, 24 * 60).setDriveDaily(true);
  await earlier(data, 24 * 60).noteDriveBackup(Date.now() - 24 * 3600_000);
  const picker = await start(page);
  await withGoogle(page, fake);
  await setClientId(page);
  await login(page, picker, data.dir);
  await expect(page.locator('.drive-due')).toContainText("Today's backup to Google Drive is due.");
  await page.locator('.drive-due').getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText('Backed up to Google Drive.')).toBeVisible();
  await expect(page.locator('.drive-due')).toHaveCount(0);

  // Another computer, nothing on it: the start screen restores from Drive.
  const other = await (await browser.newContext()).newPage();
  const picker2 = await start(other);
  await withGoogle(other, fake);
  await setClientId(other);
  await other.getByRole('button', { name: 'Restore from Google Drive…' }).click();
  await other.getByRole('dialog', { name: 'Restore from Google Drive' }).getByRole('button', { name: 'Restore this…' }).click();
  const place = mkdtempSync(join(tmpdir(), 'usw-restore-'));
  picker2.next(place);
  await expect(other.getByText(/Restored into/)).toBeVisible();
  await other.getByLabel('Password').fill('puja');
  await other.getByRole('button', { name: 'OK' }).click();
  await expectClients(other, ['1|PREM|', '2|RISHABH|']);
});

test('setting up Google Drive step by step, changing the project, stopping', async ({ page }) => {
  const fake = new FakeDrive();
  const data = await dataCopy();
  const picker = await start(page);
  await withGoogle(page, fake);
  await login(page, picker, data.dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Backups…/ }).click();
  const drive = page.locator('section.drive');
  await expect(drive).toContainText('Google Drive is not set up on this computer yet.');
  await drive.getByRole('button', { name: 'Set up Google Drive…' }).click();

  const wiz = page.getByRole('dialog', { name: 'Set up Google Drive backups' });
  // Each step opens the right Google page, and gives what to type.
  const links: string[] = [];
  for (let i = 0; i < 6; i++) {
    for (const a of await wiz.locator('.step-body a.go').all()) links.push((await a.getAttribute('href'))!);
    await wiz.getByRole('button', { name: 'Done, next step' }).click();
  }
  expect(links).toEqual([
    'https://console.cloud.google.com/projectcreate',
    'https://console.cloud.google.com/apis/library/drive.googleapis.com',
    'https://console.cloud.google.com/auth/branding',
    'https://console.cloud.google.com/auth/audience',
    'https://console.cloud.google.com/auth/scopes',
    'https://console.cloud.google.com/auth/clients/create',
  ]);
  await wiz.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(wiz.locator('.step-body')).toContainText('http://127.0.0.1:4173');
  await wiz.getByRole('button', { name: 'Done, next step' }).click();
  await wiz.getByLabel('Client ID').fill('not an id');
  await wiz.getByRole('button', { name: 'Save and check' }).click();
  await expect(wiz.getByText(/That is not a Client ID/)).toBeVisible();
  await wiz.getByLabel('Client ID').fill('123456789012-abcdef123.apps.googleusercontent.com');
  await wiz.getByRole('button', { name: 'Save and check' }).click();
  await expect(page.getByText('Google Drive is set up on this computer.')).toBeVisible();
  // Checking it made the backups folder in Drive.
  expect([...fake.files.values()].map((f) => f.name)).toEqual(['Utility Soft backups']);
  await expect(drive.getByRole('button', { name: 'Back up to Google Drive now' })).toBeVisible();
  // Not in the data folder (it is not data, and the folder may be copied).
  expect(data.everything()).not.toContain('abcdef123');
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();

  // Utility ▸ Google Drive: the project in use, change it, or stop.
  await page.getByRole('button', { name: /Google Drive…/ }).click();
  const gd = page.getByRole('dialog', { name: 'Google Drive' });
  await expect(gd).toContainText('123456789012…');
  await gd.getByRole('button', { name: 'Change the Google Cloud project…' }).click();
  await expect(page.getByRole('dialog', { name: 'Change the Google Cloud project' })).toContainText('Restore from a backup file');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await gd.getByRole('button', { name: 'Stop using Google Drive here…' }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(gd).toContainText('Google Drive is not set up on this computer.');
});

test('restoring from a downloaded backup file, on a new computer', async ({ page, browser }) => {
  const fake = new FakeDrive();
  const data = await dataCopy();
  const picker = await start(page);
  await withGoogle(page, fake);
  await setClientId(page);
  await login(page, picker, data.dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Backups…/ }).click();
  await page.locator('section.drive').getByRole('button', { name: 'Back up to Google Drive now' }).click();
  await expect(page.getByText('Backed up to Google Drive.')).toBeVisible();
  const file = [...fake.files.values()].find((f) => f.name.endsWith('.usbackup'))!;
  const path = join(mkdtempSync(join(tmpdir(), 'usw-file-')), file.name);
  writeFileSync(path, file.data);

  // A computer without Google set up: the start screen opens the file.
  const other = await (await browser.newContext()).newPage();
  const picker2 = await start(other);
  const place = mkdtempSync(join(tmpdir(), 'usw-restore-'));
  picker2.next(place);
  await other.locator('label.file-button input').setInputFiles(path);
  await expect(other.getByText(/Restored into/)).toBeVisible();
  await other.getByLabel('Password').fill('puja');
  await other.getByRole('button', { name: 'OK' }).click();
  await expectClients(other, ['1|PREM|', '2|RISHABH|']);
});
