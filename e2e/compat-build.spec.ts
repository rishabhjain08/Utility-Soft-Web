// Builds a data set through the web UI for the Java compatibility check
// (scripts/java-compat.py opens it with the original Java program).
import { test, expect, Page } from '@playwright/test';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, expectClients, gridRows, login, start, waitSaved } from './helpers';

export const COMPAT_WEB = join(import.meta.dirname, '..', '.tmp', 'compat-web');

async function cell(page: Page, row: number, col: 'desc' | 'amount', text: string) {
  const el = page.locator(`.grid [data-row="${row}"][data-col="${col}"]`);
  await el.click();
  await el.fill(text);
  await page.keyboard.press('Escape');
}

test('build data with the web app', async ({ page }) => {
  rmSync(COMPAT_WEB, { recursive: true, force: true });
  mkdirSync(COMPAT_WEB, { recursive: true });
  cpSync(join(FIXTURES, 'java-sample'), COMPAT_WEB, { recursive: true });
  const picker = await start(page);
  await login(page, picker, COMPAT_WEB);

  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Letterhead/ }).click();
  await page.getByLabel(/Address and other lines/).fill('12, Gandhi Road\nNew Delhi - 110001');
  await page.getByLabel(/Firm name and signature/).fill('For JAIN & ASSOCIATES\nChartered Accountants\n\n(Proprietor)');
  await page.getByPlaceholder('Line 1').fill('INDEX OF BILLS FOR THE YEAR ##');
  await page.getByRole('button', { name: 'Save' }).click();

  const add = async (name: string, late = false) => {
    await page.getByRole('button', { name: 'Add new' }).click();
    await page.getByLabel('Name').fill(name);
    if (late) await page.getByLabel(/Late entry/).check();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  await add('Amit Kumar');
  await add('Priya', true);
  await add('Zed');
  await expectClients(page, ['1|AMIT KUMAR|', '2|PREM|', '2A|PRIYA|', '3|RISHABH|', '4|ZED|']);
  await page.locator('tr', { hasText: 'AMIT KUMAR' }).locator('td.billno').dblclick();
  await page.getByLabel('Bill No.').fill('101-102');
  await page.keyboard.press('Enter');

  // RISHABH / Audit / PREM CHAND with a second person.
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|20']);
  await cell(page, 1, 'desc', 'Fee for Tax Audit for the Assessment Year 06-07');
  await cell(page, 1, 'amount', '15000');
  await page.locator('.grid [data-row="2"][data-col="desc"]').click();
  await page.keyboard.press('Control+b');
  await cell(page, 3, 'desc', 'Expenses');
  await cell(page, 3, 'amount', '500');
  await waitSaved(page);
  await expect.poll(() => gridRows(page)).toEqual([
    'pooja|20', 'Fee for Tax Audit for the Assessment Year 06-07|15000', '--sep--', 'Expenses|500',
  ]);
  await page.getByRole('button', { name: '← Done' }).click();

  // AMIT KUMAR / Tax / AMIT
  await page.getByRole('cell', { name: 'AMIT KUMAR' }).dblclick();
  await page.getByRole('tab', { name: 'Tax' }).click();
  await page.keyboard.press('Alt+n');
  await page.getByLabel('Bill name').fill('Amit');
  await page.getByRole('button', { name: 'OK' }).click();
  await cell(page, 0, 'desc', 'Fee for IT Return for the Assessment Year 06-07, with schedules');
  await cell(page, 0, 'amount', '2500');
  await waitSaved(page);
  await page.getByRole('button', { name: '← Done' }).click();

  // Delete ZED (renumbers nobody after it).
  await page.getByRole('cell', { name: 'ZED' }).click();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Delete 1' }).click();
  await expectClients(page, ['1|AMIT KUMAR|101-102', '2|PREM|', '2A|PRIYA|', '3|RISHABH|']);

  // Next year and copy everyone forward.
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Add next year/ }).click();
  await page.getByRole('button', { name: 'Add 07-08' }).click();
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Copy clients to another year/ }).click();
  await page.getByRole('button', { name: 'Copy 4' }).click();
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('07-08');
  await expectClients(page, ['1|AMIT KUMAR|101-102', '2|PREM|', '2A|PRIYA|', '3|RISHABH|']);

  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect.poll(() => gridRows(page)).toEqual([
    'pooja|0', 'Fee for Tax Audit for the Assessment Year 07-08|0', '--sep--', 'Expenses|0',
  ]);
  await cell(page, 0, 'amount', '25');
  await cell(page, 1, 'amount', '16000');
  // A heading row without an amount, only in this year. (The Java program cannot
  // open a bill whose previous-year copy has an amount-less row with the same
  // text — a bug in the Java program itself — so the heading is new this year.)
  await page.locator('.grid [data-row="3"][data-col="desc"]').click();
  await page.keyboard.press('Control+i');
  await cell(page, 3, 'desc', 'SMT. KAMLA');
  await cell(page, 4, 'amount', '600');
  await waitSaved(page);
  await page.getByRole('button', { name: '← Done' }).click();

  // A new tab and its drop-down list.
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Add new tab/ }).click();
  await page.getByLabel('Tab name').fill('GST');
  await page.getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Edit drop-down lists/ }).click();
  const dd = page.getByRole('dialog', { name: 'Edit drop-down lists' });
  await dd.getByRole('tab', { name: 'GST' }).click();
  await dd.getByRole('button', { name: '+ Add entry' }).click();
  await dd.getByLabel('Entry 1').fill('GST return for ##');
  await dd.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Drop-down lists saved.')).toBeVisible();
});
