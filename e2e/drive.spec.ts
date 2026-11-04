// Backups in Google Drive, with stand-ins for Google's sign-in and Drive (tests/fakedrive.ts).
import { test, expect, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
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

test('from a file on disk, Drive explains where it works', async ({ page }) => {
  const data = await dataCopy();
  const picker = await start(page);
  await login(page, picker, data.dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Backups…/ }).click();
  // Served by the test server without a client id: not set up.
  await expect(page.locator('section.drive')).toContainText('Google Drive is not set up for this copy of Utility Soft yet.');
});
