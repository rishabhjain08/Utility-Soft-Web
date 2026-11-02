// Java-written data the Java program itself cannot open (tests/fixtures/java-crash):
// opening it in the web app fixes it; compat/check_web_to_java.py then opens it with Java.
import { test, expect } from '@playwright/test';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, cipherLines, expectClients, login, start } from './helpers';

export const COMPAT_REPAIR = join(import.meta.dirname, '..', '.tmp', 'compat-repair');

test('opening Java data fixes bills the Java program could not open', async ({ page }) => {
  rmSync(COMPAT_REPAIR, { recursive: true, force: true });
  mkdirSync(COMPAT_REPAIR, { recursive: true });
  cpSync(join(FIXTURES, 'java-crash'), COMPAT_REPAIR, { recursive: true });
  const picker = await start(page);
  await login(page, picker, COMPAT_REPAIR);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await expect(page.getByText('Prepared 1 bill so the desktop version can open it.')).toBeVisible();
  expect(cipherLines(join(COMPAT_REPAIR, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt'))).toEqual(['SHRI PREM CHAND ,', 'Fee,200']);

  // The web app shows it without the padding, with last year's amounts.
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect(page.locator('.grid [data-row="0"][data-col="desc"]')).toHaveValue('SHRI PREM CHAND');
  await expect(page.locator('tbody tr').nth(1).locator('td.hist').first()).toHaveText('100');
  await page.getByRole('button', { name: '← Done' }).click();

  // The Utility action finds nothing more to do.
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Check bills for the desktop version/ }).click();
  await expect(page.getByText('Checked 2 bills; the desktop version can open all of them.')).toBeVisible();
});
