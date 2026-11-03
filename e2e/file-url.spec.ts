// The packaged app, opened straight from disk as people will use it.
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FolderPicker } from './fs-shim';
import { expectClients, gridRows, programCopy, waitSaved } from './helpers';

const APP = pathToFileURL(join(import.meta.dirname, '..', 'Utility Soft', 'Utility Soft.html')).href;

test('the packaged file works opened from disk', async ({ page }) => {
  const picker = new FolderPicker(page);
  await picker.install();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  await page.goto(APP);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  // Folder handles are remembered in IndexedDB, which must work for file:// pages.
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const r = indexedDB.open('probe', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('s');
          r.onsuccess = () => {
            const t = r.result.transaction('s', 'readwrite');
            t.objectStore('s').put('ok', 'k');
            t.oncomplete = () => resolve('ok');
            t.onerror = () => resolve('error');
          };
          r.onerror = () => resolve('error');
        }),
    ),
  ).toBe('ok');

  const dir = programCopy();
  picker.next(dir);
  await page.getByRole('button', { name: /Open Utility Soft folder/ }).click();
  await page.getByLabel('Password').fill('puja');
  await page.getByRole('button', { name: 'OK' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|20']);
  await page.locator('.grid [data-row="0"][data-col="amount"]').fill('45');
  await waitSaved(page);
  await expect.poll(() => gridRows(page)).toEqual(['pooja|45']);
});
