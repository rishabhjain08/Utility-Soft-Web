import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cipherLines, cipherValue, expectClients, gridRows, start, waitSaved } from './helpers';

test('a new installation in an empty folder, from first year to printed bill', async ({ page }) => {
  const picker = await start(page);
  const dir = mkdtempSync(join(tmpdir(), 'usw-new-'));

  picker.next(dir);
  await page.getByRole('button', { name: /Open Utility Soft folder/ }).click();
  await page.getByRole('button', { name: 'Set up here' }).click();
  await page.getByLabel('Password', { exact: true }).fill('abc');
  await page.getByLabel('Password again').fill('abd');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('do not match')).toBeVisible();
  await page.getByLabel('Password again').fill('abc');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Letterhead (the Java "registration" steps).
  await expect(page.getByRole('heading', { name: 'Your letterhead' })).toBeVisible();
  await page.getByLabel(/Address and other lines/).fill('MG Road, Jaipur');
  await page.getByLabel(/Firm name and signature/).fill('For R. K. & Co.\n\nPartner');
  await page.getByRole('button', { name: 'Save' }).click();

  // No years yet.
  await page.getByRole('button', { name: 'Add the first year…' }).click();
  await page.getByLabel('Year (like 26-27)').fill('26-27');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('No clients in 26-27 yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Add new client' }).click();
  await page.getByLabel('Name').fill('sharma traders');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expectClients(page, ['1|SHARMA TRADERS|']);

  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'New bill…' }).click();
  await page.getByLabel('Bill name').fill('Ramesh Sharma');
  await page.getByRole('button', { name: 'OK' }).click();
  const d0 = page.locator('.grid [data-row="0"][data-col="desc"]');
  await d0.click();
  await expect(page.locator('ul.suggest li').first()).toHaveText('Fee for Tax Audit for the Assessment Year 26-27');
  await page.keyboard.press('Enter');
  await page.keyboard.type('25000');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Expenses');
  await page.keyboard.press('Tab');
  await page.keyboard.type('1500');
  await waitSaved(page);
  await expect.poll(() => gridRows(page)).toEqual(['Fee for Tax Audit for the Assessment Year 26-27|25000', 'Expenses|1500']);

  await page.keyboard.press('Control+p');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('.bill-copy').first().locator('.bc-words')).toHaveText('(Rs. Twenty Six Thousand Five Hundred only.)');
  await expect(page.locator('.bill-copy').first().locator('.bc-firm')).toContainText('For R. K. & Co.');

  // Files exactly as the Java program lays them out.
  expect(readdirSync(dir).sort()).toEqual(['backupto.txt', 'data', 'ddown.txt', 'impinfo.txt', 'loaddatafrom.txt', 'pass.txt']);
  expect(cipherValue(join(dir, 'pass.txt'))).toBe('abc');
  expect(cipherLines(join(dir, 'impinfo.txt'))).toEqual([
    '(Audit^Audit)(Vat^Vat)(Tax^Tax)(Others^Others)',
    '~For R. K. & Co.%~%~Partner%',
    '~MG Road, Jaipur%',
    '%$%$%$%$',
  ]);
  expect(readdirSync(join(dir, 'data/bills/26-27/SHARMA TRADERS')).sort()).toEqual(['Audit', 'Others', 'Tax', 'Vat', 'billfromto.txt', 'serialno.txt']);
  expect(cipherLines(join(dir, 'data/bills/26-27/SHARMA TRADERS/Audit/RAMESH SHARMA.txt'))).toEqual([
    'Fee for Tax Audit for the Assessment Year ##,25000',
    'Expenses,1500',
  ]);
  expect(readFileSync(join(dir, 'data/activelocation.txt'), 'latin1')).toBe('26-27,SHARMA TRADERS\r\n');
});
