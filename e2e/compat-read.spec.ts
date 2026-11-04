// Opens data written by the original Java program (compat/build_java_data.py).
import { test, expect, Page } from '@playwright/test';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectClients, gridRows, login, migrateTo, printed, start } from './helpers';

const JAVA_DATA = join(import.meta.dirname, '..', '.tmp', 'compat-java');

test('reads data written by the Java program', async ({ page }) => {
  test.skip(!existsSync(JAVA_DATA), 'run compat/build_java_data.py first');
  const dir = mkdtempSync(join(tmpdir(), 'usw-java-'));
  cpSync(JAVA_DATA, dir, { recursive: true });
  const picker = await start(page);
  await login(page, picker, dir);
  await checks(page);
});

/** Every file under `root` with its bytes. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(root.length)] = readFileSync(p).toString('base64');
    }
  };
  walk(root);
  return out;
}

test('moves data written by the Java program to the web format without changing it', async ({ page }) => {
  test.skip(!existsSync(JAVA_DATA), 'run compat/build_java_data.py first');
  const dir = mkdtempSync(join(tmpdir(), 'usw-java-'));
  cpSync(JAVA_DATA, dir, { recursive: true });
  const before = tree(dir);
  const picker = await start(page);
  await login(page, picker, dir, 'puja', false);
  await migrateTo(page, picker, mkdtempSync(join(tmpdir(), 'usw-java-web-')));
  await checks(page);
  expect(tree(dir)).toEqual(before);
});

async function checks(page: Page) {
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('07-08');
  await expectClients(page, ['1|MOHAN|', '1A|PRAKASH|', '2|PREM|', '3|RISHABH|55']);
  await page.getByRole('combobox', { name: 'Year' }).selectOption('06-07');
  await expectClients(page, ['1|MOHAN|', '1A|PRAKASH|', '2|PREM|', '3|RISHABH|55']);

  await page.getByRole('cell', { name: 'MOHAN' }).dblclick();
  await expect.poll(() => gridRows(page)).toEqual([
    'Fee for VAT Audit for the Assessment Year 06-07|700',
    'Expenses|50',
    '--sep--',
    'Fee for IT Return for the Assessment Year 06-07|1200',
  ]);
  await expect(page.locator('tfoot td.amt').first()).toHaveText('1,950/-');

  // Its printout groups the two people.
  await page.keyboard.press('Control+p');
  await page.getByRole('button', { name: 'Print…' }).click();
  const copy = printed(page).locator('.bill-copy').first();
  await expect(copy.locator('.bc-sub')).toHaveText(['', '750/-', '1,200/-']);
  await expect(copy.locator('.bc-words')).toHaveText('(Rs. One Thousand Nine Hundred and Fifty only.)');

  // 07-08 copy made by Java: zero amounts ("New Name,0" is still a separator) and 06-07 alongside.
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('07-08');
  await expect.poll(() => gridRows(page)).toEqual([
    'Fee for VAT Audit for the Assessment Year 07-08|0',
    'Expenses|0',
    '--sep--',
    'Fee for IT Return for the Assessment Year 07-08|0',
  ]);
  await expect(page.locator('tbody tr[data-index]').nth(0).locator('td.hist').first()).toHaveText('700');
  await expect(page.locator('tbody tr[data-index]').nth(3).locator('td.hist').first()).toHaveText('1200');
  await expect(page.locator('tfoot td.hist').first()).toHaveText('1,950/-');
}
