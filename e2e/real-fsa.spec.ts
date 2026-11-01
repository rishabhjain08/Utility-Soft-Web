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

async function readOpfs(page: Page, path: string): Promise<Uint8Array> {
  const b64 = await page.evaluate(async (path) => {
    let d = await (await navigator.storage.getDirectory()).getDirectoryHandle('prog');
    const parts = path.split('/');
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    const f = await (await d.getFileHandle(parts[parts.length - 1])).getFile();
    const u8 = new Uint8Array(await f.arrayBuffer());
    let s = '';
    for (const b of u8) s += String.fromCharCode(b);
    return btoa(s);
  }, path);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

test('works with real browser folder handles and remembers the folder', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('prog', { create: true });
  });
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  await page.goto('/');
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('prog', { recursive: true }).catch(() => undefined);
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
  }, treeOf(join(FIXTURES, 'java-sample')));

  await page.getByRole('button', { name: /Open Utility Soft folder/ }).click();
  await page.getByLabel('Password').fill('puja');
  await page.getByRole('button', { name: 'OK' }).click();
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
  await expectClients(page, ['1|MOHAN|', '2|PREM|', '3|RISHABH|']);
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|35']);
});
