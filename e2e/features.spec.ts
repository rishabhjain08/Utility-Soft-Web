// Payments, PDF, searching, client details, tabs, amounts with commas, shortcuts.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { dataCopy, expectClients, gridRows, login, start, waitSaved } from './helpers';
import { encodeCipherLines } from '../src/core/codec';

const withBill = (dir: string) =>
  writeFileSync(join(dir, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt'), encodeCipherLines(['Fee for Tax Audit for the Assessment Year ##,25000', 'Expenses,1500']));

test('payments: received, an agreed lower amount, and the payments page', async ({ page }) => {
  const data = await dataCopy(withBill);
  const picker = await start(page);
  await login(page, picker, data.dir);
  // The list shows what is billed and due.
  await expect(page.locator('table.clients tbody tr').nth(1).locator('td.money')).toHaveText(['26,500', '26,500']);
  await expect(page.locator('table.clients tfoot td.money')).toHaveText(['26,500', '26,500']);

  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  const strip = page.locator('.pay-strip');
  await expect(strip).toContainText('Billed 26,500/-');
  await expect(strip).toContainText('Not paid');
  await strip.getByRole('button', { name: 'Money received…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Money received — PREM CHAND' });
  await expect(dlg.getByLabel('Amount received')).toHaveValue('26500');
  await dlg.getByLabel('Amount received').fill('20000');
  await dlg.getByLabel('Note (optional)').fill('cheque 123456');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(strip).toContainText('Received 20,000/-');
  await expect(strip).toContainText('Due 6,500/-');
  await expect(strip).toContainText('Part paid');

  // The client agrees 25,000 for the whole bill.
  await strip.getByRole('button', { name: 'Agreed a lower amount…' }).click();
  const red = page.getByRole('dialog', { name: 'Agreed a lower amount — PREM CHAND' });
  await red.getByLabel('Amount agreed for the whole bill').fill('25000');
  await expect(red).toContainText('Takes 1,500/- off the bill.');
  await red.getByRole('button', { name: 'Save' }).click();
  await expect(strip).toContainText('Reduced 1,500/-');
  await expect(strip).toContainText('Due 5,000/-');
  await strip.getByRole('button', { name: 'Show 2 entries' }).click();
  await expect(strip.locator('.pay-list li')).toHaveCount(2);
  await page.getByRole('button', { name: '← Done' }).click();

  // The payments page: summary, filters, links to the bill.
  await page.getByRole('button', { name: 'Payments' }).click();
  const tiles = page.locator('.tiles .tile b');
  await expect(tiles).toHaveText(['26,500/-', '20,000/-', '1,500/-', '5,000/-']);
  await expect(page.locator('table.ledger tbody tr')).toHaveCount(1);
  await expect(page.locator('table.ledger tbody tr')).toContainText('Part paid');
  await page.getByRole('tab', { name: 'Paid' }).click();
  await expect(page.getByText('No bills here.')).toBeVisible();
  await page.getByRole('tab', { name: 'Due' }).click();
  await page.getByRole('button', { name: 'Received…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Nothing is due.')).toBeVisible();
  await page.getByRole('tab', { name: 'All' }).click();
  await page.getByRole('button', { name: 'Audit › PREM CHAND' }).click();
  await expect(page.locator('.client-title b')).toHaveText('RISHABH');
  await expect(page.locator('.pay-strip')).toContainText('Paid');
  // Done goes back to the payments page.
  await page.getByRole('button', { name: '← Done' }).click();
  await expect(page.locator('.brand')).toHaveText('Payments');
  await page.keyboard.press('Escape');
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
});

test('a bill as a PDF, in one click', async ({ page }) => {
  const data = await dataCopy(withBill);
  const picker = await start(page);
  await login(page, picker, data.dir);
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect.poll(() => gridRows(page)).toEqual(['Fee for Tax Audit for the Assessment Year 06-07|25000', 'Expenses|1500']);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('RISHABH - PREM CHAND.pdf');
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(1);
  expect(doc.getTitle()).toBe('PREM CHAND — Bill');
  await download.saveAs('test-results/bill.pdf');
  await expect(page.getByText(/Saved RISHABH - PREM CHAND.pdf/)).toBeVisible();
});

test('search all years, client details, Bill No. clashes', async ({ page }) => {
  const data = await dataCopy(withBill);
  const picker = await start(page);
  await login(page, picker, data.dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('dialog', { name: 'Search all years' });
  await search.getByRole('searchbox').fill('tax audit');
  await expect(search.locator('.search-hits li')).toHaveCount(1);
  await expect(search.locator('.search-hits li')).toContainText('RISHABH › Audit › PREM CHAND');
  await page.keyboard.press('Enter');
  await expect(page.locator('.client-title b')).toHaveText('RISHABH');
  await expect(page.getByRole('tab', { name: 'PREM CHAND' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '← Done' }).click();

  // Client details, optional, in Modify.
  await page.getByRole('cell', { name: 'PREM', exact: true }).click();
  await page.keyboard.press('F2');
  await page.getByRole('button', { name: /\+ Client details/ }).click();
  await page.getByLabel('PAN').fill('abcde1234');
  await expect(page.getByText('A PAN usually looks like ABCDE1234F.')).toBeVisible();
  await page.getByLabel('PAN').fill('abcde1234f');
  await page.getByLabel('Phone').fill('98290 12345');
  await page.getByLabel('Bill No.').fill('7');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectClients(page, ['1|PREM|7', '2|RISHABH|']);
  await page.getByRole('cell', { name: 'RISHABH' }).click();
  await page.keyboard.press('F2');
  await page.getByLabel('Bill No.').fill('6-8');
  await expect(page.getByText('Also used by PREM.')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('td.billno.clash')).toHaveCount(2);
  await page.getByRole('cell', { name: 'PREM', exact: true }).dblclick();
  await expect(page.locator('.client-title')).toContainText('PAN ABCDE1234F');
});

test('tabs: rename, reorder, hide; commas in amounts; drop-down entry from a row; shortcuts', async ({ page }) => {
  const data = await dataCopy(withBill);
  const picker = await start(page);
  await login(page, picker, data.dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('Search all years');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Tabs…/ }).click();
  const tabs = page.getByRole('dialog', { name: 'Tabs' });
  await tabs.locator('li', { hasText: 'Vat' }).getByRole('button', { name: 'Rename…' }).click();
  await page.getByLabel('New name').fill('VAT Audit');
  await page.getByRole('button', { name: 'OK' }).click();
  await tabs.getByRole('button', { name: 'Move Others up' }).click();
  await tabs.locator('li', { hasText: 'Tax' }).getByRole('button', { name: 'Hide' }).click();
  await expect(tabs.locator('li b')).toHaveText(['Audit', 'VAT Audit', 'Others', 'Tax']);
  await tabs.locator('.modal-foot button').click();
  await expect(tabs).toHaveCount(0);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);

  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect(page.getByRole('tablist', { name: 'Bill types' }).getByRole('tab')).toHaveText(['Audit', 'VAT Audit', 'Others']);

  // Amounts show Indian commas while typing; they are saved as plain numbers.
  const amt = page.locator('.grid [data-row="0"][data-col="amount"]');
  await expect(amt).toHaveValue('25,000');
  await amt.fill('');
  await amt.pressSequentially('125000');
  await expect(amt).toHaveValue('1,25,000');
  await waitSaved(page);
  expect(await data.bill('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['Fee for Tax Audit for the Assessment Year ##,125000', 'Expenses,1500']);

  // A row's text into the drop-down list (the year is kept as "the year of the bill").
  await page.locator('.grid [data-row="2"][data-col="desc"]').fill('Fee for certification for 06-07');
  await page.getByRole('button', { name: 'Row 3 actions' }).click();
  await page.getByRole('menuitem', { name: 'Add this text to the drop-down list' }).click();
  await expect(page.getByText('Added to the Audit drop-down list.')).toBeVisible();
  expect((await data.dropdowns())[0]).toContain('^Fee for certification for ##');
});
