// Uses Chrome's real FileSystemDirectoryHandle implementation (backed by the
// origin-private file system) instead of the disk-backed test picker, and checks
// that the chosen folder is remembered across reloads.
import { test, expect, Page } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FIXTURES, expectClients, gridRows, waitSaved } from './helpers';
import { decodeCipherLines, decodeCipherValue } from '../src/core/codec';

function treeOf(root: string): { path: string; b64: string }[] {
  const out: { path: string; b64: string }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(root, p), b64: readFileSync(p).toString('base64') });
    }
  };
  walk(root);
  return out;
}

async function readOpfs(page: Page, path: string, folder = 'prog'): Promise<Uint8Array> {
  const b64 = await page.evaluate(async ({ path, folder }) => {
    let d = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
    const parts = path.split('/');
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    const f = await (await d.getFileHandle(parts[parts.length - 1])).getFile();
    const u8 = new Uint8Array(await f.arrayBuffer());
    let s = '';
    for (const b of u8) s += String.fromCharCode(b);
    return btoa(s);
  }, { path, folder });
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Each folder picker call returns the next of `picks` (folders of the origin-private
 * file system); the Java sample is put in "prog".
 */
async function setup(page: Page, picks: string[]) {
  await page.addInitScript((picks) => {
    const w = window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> };
    w.showDirectoryPicker = async () => {
      const n = Number(sessionStorage.getItem('picks') ?? 0);
      const name = picks[Math.min(n, picks.length - 1)];
      sessionStorage.setItem('picks', String(n + 1));
      return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    };
  }, picks);
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  await page.goto('/');
  await page.evaluate(async ({ files, picks }) => {
    const root = await navigator.storage.getDirectory();
    for (const p of [...picks, 'prog']) await root.removeEntry(p, { recursive: true }).catch(() => undefined);
    indexedDB.deleteDatabase('utility-soft');
    const prog = await root.getDirectoryHandle('prog', { create: true });
    for (const f of files) {
      let d = prog;
      const parts = f.path.split('/');
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      const bin = atob(f.b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await w.write(u8);
      await w.close();
    }
  }, { files: treeOf(join(FIXTURES, 'java-sample')), picks });
}

test('works with real browser folder handles and remembers the folder', async ({ page }) => {
  await setup(page, ['prog']);

  await page.getByRole('button', { name: /Open Utility Soft folder/ }).click();
  await page.getByLabel('Password').fill('puja');
  await page.getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: 'Keep using the desktop files' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);

  await page.getByRole('button', { name: 'Add new' }).click();
  await page.getByLabel('Name').fill('mohan');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expectClients(page, ['1|MOHAN|', '2|PREM|', '3|RISHABH|']);

  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  const amt = page.locator('.grid [data-row="0"][data-col="amount"]');
  await amt.fill('35');
  await waitSaved(page);
  await page.getByRole('button', { name: 'Bill utility…' }).click();
  await page.getByRole('button', { name: /Rename the bill/ }).click();
  await page.getByLabel('New name').fill('prem chand ji');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('tab', { name: 'PREM CHAND JI' })).toBeVisible();
  await page.getByRole('button', { name: '← Done' }).click();

  expect(decodeCipherLines(await readOpfs(page, 'data/bills/06-07/RISHABH/Audit/PREM CHAND JI.txt'))).toEqual(['pooja,35']);
  expect(decodeCipherValue(await readOpfs(page, 'data/bills/06-07/RISHABH/serialno.txt'))).toBe('3');

  // After a reload the folder is offered again.
  await page.reload();
  await page.getByRole('button', { name: 'Continue with “prog”' }).click();
  await page.getByLabel('Password').fill('puja');
  await page.getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: 'Keep using the desktop files' }).click();
  await expectClients(page, ['1|MOHAN|', '2|PREM|', '3|RISHABH|']);
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|35']);
});

test('moves to the web format with real folder handles, and remembers the copy', async ({ page }) => {
  await setup(page, ['prog', 'copy']);
  await page.getByRole('button', { name: /Open Utility Soft folder/ }).click();
  await page.getByLabel('Password').fill('puja');
  await page.getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: 'Make a copy in the new format…' }).click();
  const report = page.getByRole('dialog', { name: 'Copy made and checked' });
  await expect(report.locator('.report-ok')).toContainText('Everything matches: 1 year, 2 clients and 1 bill (1 row)');
  await report.getByRole('button', { name: 'Open the copy' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await expect(page.locator('.statusbar')).toContainText('Data: copy');
  await expect(page.locator('.format-badge')).toHaveCount(0);

  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await page.locator('.grid [data-row="0"][data-col="amount"]').fill('35');
  await waitSaved(page);
  await page.getByRole('button', { name: '← Done' }).click();
  const files = await page.evaluate(async () => {
    const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('copy')).getDirectoryHandle('years');
    const y = await d.getDirectoryHandle('06-07');
    const out: string[] = [];
    for await (const [name] of (y as unknown as { entries(): AsyncIterable<[string]> }).entries()) out.push(name);
    return out;
  });
  const recs = await Promise.all(files.map(async (f) => JSON.parse(new TextDecoder().decode(await readOpfs(page, `years/06-07/${f}`, 'copy')))));
  expect(recs.find((r) => r.name === 'RISHABH').bills[0].groups[0].rows).toEqual([{ text: 'pooja', amount: '35' }]);
  // The desktop folder still has the old amount.
  expect(decodeCipherLines(await readOpfs(page, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt'))).toEqual(['pooja,20']);

  // Next time the copy is offered first.
  await page.reload();
  await page.getByRole('button', { name: 'Continue with “copy”' }).click();
  await page.getByLabel('Password').fill('puja');
  await page.getByRole('button', { name: 'OK' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);

  // Opening the desktop folder again says it was copied, and opens the copy.
  await page.reload();
  await page.evaluate(() => sessionStorage.setItem('picks', '0'));
  await page.getByRole('button', { name: 'Open a different folder…' }).click();
  await page.getByLabel('Password').fill('puja');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.notice')).toContainText('This folder was already copied to copy');
  await page.getByRole('button', { name: 'Open “copy”' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await expect(page.locator('.statusbar')).toContainText('Data: copy');
});
