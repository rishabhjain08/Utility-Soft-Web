import { test, expect, Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cipherLines, expectClients, gridRows, login, programCopy, start, waitSaved } from './helpers';
import { encodeCipherLines, encodeCipherValue } from '../src/core/codec';

/** Adds year 05-06 with RISHABH's bill so that history and new-bill merging can be checked. */
function seedHistory(dir: string) {
  const c = join(dir, 'data/bills/05-06/RISHABH');
  for (const t of ['Audit', 'Vat', 'Tax', 'Others']) mkdirSync(join(c, t), { recursive: true });
  writeFileSync(join(c, 'serialno.txt'), encodeCipherValue('1'));
  writeFileSync(join(c, 'billfromto.txt'), encodeCipherValue('40'));
  writeFileSync(join(c, 'Audit/PREM CHAND.txt'), encodeCipherLines(['pooja,15', 'Fee for Tax Audit for the Assessment Year ##,9000']));
  writeFileSync(join(c, 'Tax/KAMLA.txt'), encodeCipherLines(['Fee for IT Return for the Assessment Year ##,1100', 'Expenses,150']));
  // ddown entries for the Tax tab.
  const dd = readFileSync(join(dir, 'ddown.txt'), 'latin1').replace(/^Tax\^.*$/m, 'Tax^Fee for IT Return for the Assessment Year ##^Fee for filing of Form No. 15G & 15H^Expenses');
  writeFileSync(join(dir, 'ddown.txt'), dd, 'latin1');
}

async function typeCell(page: Page, row: number, col: 'desc' | 'amount', text: string) {
  const el = page.locator(`.grid [data-row="${row}"][data-col="${col}"]`);
  await el.click();
  await el.fill(text);
}

test('bill editor journey', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  seedHistory(dir);
  await login(page, picker, dir);
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('06-07');
  await page.getByText('RISHABH').dblclick();

  // Existing bill with history from 05-06.
  await expect.poll(() => gridRows(page)).toEqual(['pooja|20']);
  await expect(page.locator('tbody tr').first().locator('td.hist').first()).toHaveText('15');
  // The client is locked while open.
  expect(readFileSync(join(dir, 'data/activelocation.txt'), 'latin1')).toBe('06-07,RISHABH\r\n');

  // New bill in Tax: rows come from KAMLA's 05-06 bill with zero amounts.
  await page.getByRole('tab', { name: 'Tax' }).click();
  await expect(page.getByText('No bills in Tax yet.')).toBeVisible();
  await page.keyboard.press('Alt+n');
  await page.getByLabel('Bill name').fill('kamla');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('tab', { name: 'KAMLA' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => gridRows(page)).toEqual(['Fee for IT Return for the Assessment Year 06-07|0', 'Expenses|0']);
  await expect(page.locator('tfoot td.hist').first()).toHaveText('1,250/-');

  // Edit amounts; letters are refused.
  await typeCell(page, 0, 'amount', '1500');
  await page.locator('.grid [data-row="1"][data-col="amount"]').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('2x0');
  await expect(page.locator('.grid [data-row="1"][data-col="amount"]')).toHaveValue('20');
  await waitSaved(page);
  expect(cipherLines(join(dir, 'data/bills/06-07/RISHABH/Tax/KAMLA.txt'))).toEqual([
    'Fee for IT Return for the Assessment Year ##,1500',
    'Expenses,20',
  ]);

  // Add a row through the blank row, picking from the drop-down list.
  const blank = page.locator('.grid [data-row="2"][data-col="desc"]');
  await blank.click();
  await blank.type('fee for f');
  await expect(page.locator('ul.suggest li')).toHaveText(['Fee for filing of Form No. 15G & 15H']);
  await page.keyboard.press('Enter');
  await page.keyboard.type('300');
  await waitSaved(page);
  await expect.poll(() => gridRows(page)).toEqual([
    'Fee for IT Return for the Assessment Year 06-07|1500',
    'Expenses|20',
    'Fee for filing of Form No. 15G & 15H|300',
  ]);
  await expect(page.locator('tfoot td.amt').first()).toHaveText('1,820/-');

  // Move the last row up twice, then down once.
  await page.locator('.grid [data-row="2"][data-col="desc"]').click();
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => gridRows(page)).toEqual([
    'Fee for IT Return for the Assessment Year 06-07|1500',
    'Fee for filing of Form No. 15G & 15H|300',
    'Expenses|20',
  ]);

  // Separator ("New name") above row 2, then a second person's rows.
  await page.locator('.grid [data-row="2"][data-col="desc"]').click();
  await page.keyboard.press('Control+b');
  await expect.poll(() => gridRows(page)).toEqual([
    'Fee for IT Return for the Assessment Year 06-07|1500',
    'Fee for filing of Form No. 15G & 15H|300',
    '--sep--',
    'Expenses|20',
  ]);
  await expect(page.locator('tbody tr td.sno')).toHaveText(['1', '2', '', '3', '']);
  // Insert a row above "Expenses" and type a name.
  await page.locator('.grid [data-row="3"][data-col="desc"]').click();
  await page.keyboard.press('Control+i');
  await typeCell(page, 3, 'desc', 'SMT. KAMLA DEVI');
  await waitSaved(page);
  expect(cipherLines(join(dir, 'data/bills/06-07/RISHABH/Tax/KAMLA.txt'))).toEqual([
    'Fee for IT Return for the Assessment Year ##,1500',
    'Fee for filing of Form No. 15G & 15H,300',
    'New Name,New',
    'SMT. KAMLA DEVI,',
    'Expenses,20',
  ]);

  // Delete a row with the row checkbox + Delete row.
  await page.getByLabel('Select row 2').check();
  await page.getByRole('button', { name: 'Delete row' }).click();
  await waitSaved(page);
  await expect.poll(() => gridRows(page)).toEqual([
    'Fee for IT Return for the Assessment Year 06-07|1500',
    '--sep--',
    'SMT. KAMLA DEVI|',
    'Expenses|20',
  ]);

  // Print this bill: preview shows both copies with totals and words.
  await page.keyboard.press('Control+p');
  await expect(page.getByLabel('Date to be printed')).toHaveValue(/^\d\d\.\d\d\.\d{4}$/);
  await page.getByLabel('Date to be printed').fill('01.11.2026');
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('dialog', { name: /Print preview/ });
  await expect(preview.locator('.bill-copy')).toHaveCount(2);
  const copy = preview.locator('.bill-copy').first();
  await expect(copy.locator('.bc-title')).toHaveText('KAMLA');
  await expect(copy.locator('.bc-meta')).toContainText('S.No.: 2');
  await expect(copy.locator('.bc-words')).toHaveText('(Rs. One Thousand Five Hundred and Twenty only.)');
  await expect(copy.locator('.bc-sum')).toHaveText('1,520/-');
  await expect(copy.locator('.bc-sub')).toHaveText(['1,500/-', '', '20/-']);
  await expect(copy).toContainText('Date : 01.11.2026');
  await page.screenshot({ path: 'test-results/editor-print-preview.png' });
  await preview.getByRole('button', { name: 'Close', exact: true }).last().click();

  // Rename and delete through Bill utility.
  await page.getByRole('button', { name: 'Bill utility…' }).click();
  await page.getByRole('button', { name: /Rename the bill/ }).click();
  await page.getByLabel('New name').fill('kamla devi');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('tab', { name: 'KAMLA DEVI' })).toBeVisible();
  expect(existsSync(join(dir, 'data/bills/06-07/RISHABH/Tax/KAMLA DEVI.txt'))).toBe(true);
  expect(existsSync(join(dir, 'data/bills/06-07/RISHABH/Tax/KAMLA.txt'))).toBe(false);

  await page.getByRole('tab', { name: 'Audit' }).click();
  await page.keyboard.press('Alt+u');
  await page.getByRole('button', { name: /Delete the bill/ }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No bills in Audit yet.')).toBeVisible();
  expect(existsSync(join(dir, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt'))).toBe(false);

  // Switch to 05-06 in the editor (moves the lock), then back.
  await page.getByRole('combobox', { name: 'Year' }).selectOption('05-06');
  await expect(page.getByRole('tab', { name: 'PREM CHAND' })).toBeVisible();
  expect(readFileSync(join(dir, 'data/activelocation.txt'), 'latin1')).toBe('05-06,RISHABH\r\n');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('06-07');

  // Done: the lock is released.
  await page.getByRole('button', { name: '← Done' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  expect(readFileSync(join(dir, 'data/activelocation.txt'), 'latin1')).toBe('');
});

test('done offers to copy the client to the next year', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  mkdirSync(join(dir, 'data/bills/07-08'));
  await login(page, picker, dir);
  await page.getByRole('combobox', { name: 'Year' }).selectOption('06-07');
  await page.getByText('RISHABH').dblclick();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|20']);
  await page.keyboard.press('Escape');
  await expect(page.getByText('Update bill for RISHABH to next year 07-08?')).toBeVisible();
  await page.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByText('RISHABH copied to 07-08.')).toBeVisible();
  expect(cipherLines(join(dir, 'data/bills/07-08/RISHABH/Audit/PREM CHAND.txt'))).toEqual(['pooja,0']);
  // Not asked again once it exists.
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await page.keyboard.press('Escape');
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await expect(page.getByText(/Update bill for/)).toHaveCount(0);
});

test('opening a client that is open elsewhere warns first', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  writeFileSync(join(dir, 'data/activelocation.txt'), '06-07,PREM\r\n');
  await login(page, picker, dir);
  await page.getByText('PREM').dblclick();
  await expect(page.getByText('is open on another computer')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('table.clients')).toBeVisible();
  await page.getByText('PREM').dblclick();
  await page.getByRole('button', { name: 'Open anyway' }).click();
  await expect(page.locator('.client-title b')).toHaveText('PREM');
  await page.getByRole('button', { name: '← Done' }).click();
  await expect(page.locator('table.clients')).toBeVisible();
  expect(readFileSync(join(dir, 'data/activelocation.txt'), 'latin1')).toBe('');
});
