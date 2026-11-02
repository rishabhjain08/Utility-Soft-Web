import { Page, expect } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderPicker } from './fs-shim';
import { decodeCipherLines, decodeCipherValue } from '../src/core/codec';

export const FIXTURES = join(import.meta.dirname, '..', 'tests', 'fixtures');

/** A fresh copy of a fixture program folder in a temp dir. */
export function programCopy(fixture = 'java-sample'): string {
  const dir = mkdtempSync(join(tmpdir(), 'usw-e2e-'));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

export const cipherLines = (p: string) => decodeCipherLines(new Uint8Array(readFileSync(p)));
export const cipherValue = (p: string) => decodeCipherValue(new Uint8Array(readFileSync(p)));

export async function start(page: Page): Promise<FolderPicker> {
  const picker = new FolderPicker(page);
  await picker.install();
  // Chrome's print dialog cannot be driven by tests: record what would be printed
  // into #printed instead (and count the calls).
  await page.addInitScript(() => {
    window.print = () => {
      const w = window as unknown as { __prints: number };
      w.__prints = (w.__prints ?? 0) + 1;
      let d = document.getElementById('printed');
      if (!d) {
        d = document.createElement('div');
        d.id = 'printed';
        document.body.appendChild(d);
      }
      d.innerHTML = document.getElementById('print-root')!.innerHTML;
    };
  });
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
  await page.goto('/');
  return picker;
}

/** Opens a program folder and logs in. */
export async function login(page: Page, picker: FolderPicker, dir: string, password = 'puja') {
  picker.next(dir);
  await page.getByRole('button', { name: /Open Utility Soft folder/ }).click();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'OK' }).click();
}

/** Rows of the client list as "serial|name|billno". */
export async function clientRows(page: Page): Promise<string[]> {
  return page.locator('table.clients tbody tr').evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.querySelector('input') as HTMLInputElement | null)?.value ?? td.textContent?.trim()).join('|')),
  );
}

export async function expectClients(page: Page, rows: string[]) {
  await expect.poll(() => clientRows(page)).toEqual(rows);
}

export async function selectClient(page: Page, name: string) {
  await page.locator('table.clients tbody tr', { has: page.locator('td.name', { hasText: new RegExp(`^${name}$`) }) }).click();
}

/** Rows of the bill grid as "desc|amount" (separators as "--sep--"). */
export async function gridRows(page: Page): Promise<string[]> {
  return page.locator('table.grid tbody tr:not(.extra)').evaluateAll((trs) =>
    trs.map((tr) => {
      if (tr.classList.contains('sep')) return '--sep--';
      const d = (tr.querySelector('.desc-input') as HTMLInputElement).value;
      const a = (tr.querySelector('.amt-input') as HTMLInputElement).value;
      return `${d}|${a}`;
    }),
  );
}

export async function waitSaved(page: Page) {
  await expect(page.locator('.save-state')).toHaveText('All changes saved', { timeout: 10_000 });
}

/** What the last window.print() call would have printed. */
export function printed(page: Page) {
  return page.locator('#printed');
}
