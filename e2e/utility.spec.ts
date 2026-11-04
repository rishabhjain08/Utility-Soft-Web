import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataCopy, expectClients, login, printed, selectClient, start } from './helpers';
import { encodeCipherLines } from '../src/core/codec';
import { WebBooks } from '../src/core/webstore';
import { NodeDir } from '../tests/nodefs';

test('years: add next year, copy clients forward (fresh and overwrite), print index', async ({ page }) => {
  const picker = await start(page);
  const data = await dataCopy((dir) => {
    mkdirSync(join(dir, 'data/bills/06-07/PREM/Vat'));
    writeFileSync(join(dir, 'data/bills/06-07/PREM/Vat/GOPAL.txt'), encodeCipherLines(['VAT return for ##,700', 'Expenses,50']));
  });
  await login(page, picker, data.dir);

  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Add next year/ }).click();
  await page.getByRole('button', { name: 'Add 07-08' }).click();
  await expect(page.getByText(/Added year 07-08/)).toBeVisible();
  expect(await data.hasYear('07-08')).toBe(true);
  // The new year is empty; the list still shows 06-07.
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('06-07');

  // Copy only PREM first.
  await page.keyboard.press('Alt+u');
  await page.getByRole('button', { name: /Copy clients to another year/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Copy clients to another year' });
  await expect(dlg.getByLabel('To')).toHaveValue('07-08');
  await dlg.getByRole('row', { name: /RISHABH/ }).getByRole('checkbox').uncheck();
  await dlg.getByRole('button', { name: 'Copy 1' }).click();
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('07-08');
  await expectClients(page, ['1|PREM|']);
  expect(await data.bill('07-08', 'PREM', 'Vat', 'GOPAL')).toEqual(['VAT return for ##,0', 'Expenses,0']);
  expect(await data.serial('07-08', 'PREM')).toBe('1');

  // Edit PREM's 07-08 bill, then copy again: RISHABH is new, PREM collides and is kept unless ticked.
  await data.writeBill('07-08', 'PREM', 'Vat', 'GOPAL', ['VAT return for ##,800']);
  await page.getByRole('combobox', { name: 'Year' }).selectOption('06-07');
  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Copy clients to another year/ }).click();
  await expect(dlg.getByText('Already in 07-08')).toBeVisible();
  await expect(dlg.getByRole('row', { name: /PREM/ }).getByRole('checkbox')).not.toBeChecked();
  await dlg.getByRole('button', { name: 'Copy 1' }).click();
  await expect(page.getByText('Copied 1 client to 07-08.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('07-08');
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  expect(await data.bill('07-08', 'PREM', 'Vat', 'GOPAL')).toEqual(['VAT return for ##,800']);

  // Overwrite PREM.
  await page.getByRole('combobox', { name: 'Year' }).selectOption('06-07');
  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Copy clients to another year/ }).click();
  await dlg.getByRole('row', { name: /PREM/ }).getByRole('checkbox').check();
  await dlg.getByRole('button', { name: 'Copy 1' }).click();
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('07-08');
  expect(await data.bill('07-08', 'PREM', 'Vat', 'GOPAL')).toEqual(['VAT return for ##,0', 'Expenses,0']);

  // Index sheet.
  await page.getByRole('button', { name: 'Print index' }).click();
  await expect(printed(page).locator('.ix-table tbody tr')).toHaveCount(2);
  await expect(printed(page).locator('.ix-table tbody tr').first()).toContainText('PREM');
});

test('setup: add a tab, edit drop-down lists, letterhead', async ({ page }) => {
  const picker = await start(page);
  const data = await dataCopy();
  await login(page, picker, data.dir);

  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Add new tab/ }).click();
  await page.getByLabel('Tab name').fill('GST');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('Added the tab GST.')).toBeVisible();
  expect(await data.tabs()).toEqual(['Audit', 'Vat', 'Tax', 'Others', 'GST']);

  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Edit drop-down lists/ }).click();
  const dd = page.getByRole('dialog', { name: 'Edit drop-down lists' });
  await dd.getByRole('tab', { name: 'GST' }).click();
  await dd.getByRole('button', { name: '+ Add entry' }).click();
  // Years are written as they are; stored so that each year shows its own.
  await expect(dd.getByText('Write years as they are for 06-07')).toBeVisible();
  await dd.getByLabel('Entry 1').fill('GST return for the year 06-07');
  await dd.getByRole('button', { name: '+ Add entry' }).click();
  await dd.getByLabel('Entry 2').fill('Expenses');
  await dd.getByRole('tab', { name: 'Vat' }).click();
  await dd.getByLabel('Entry 3').fill('');
  await dd.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Drop-down lists saved.')).toBeVisible();
  const lines = await data.dropdowns();
  expect(lines[0]).toBe('Audit^Income tax for the Assessment Year ##');
  expect(lines[1]).toBe('Vat^income tc for the assessment year ##^glfdkgd;lgsdf^fgfdjkgf');
  expect(lines[4]).toBe('GST^GST return for the year ##^Expenses');

  // The new tab and list show up in the bill editor.
  await page.getByText('PREM').dblclick();
  await page.getByRole('tab', { name: 'GST' }).click();
  await page.keyboard.press('Alt+n');
  await page.getByLabel('Bill name').fill('ram');
  await page.getByRole('button', { name: 'OK' }).click();
  await page.locator('.grid [data-row="0"][data-col="desc"]').click();
  await expect(page.locator('ul.suggest li')).toHaveText(['GST return for the year 06-07', 'Expenses']);
  await page.keyboard.press('Escape'); // closes the list
  await page.keyboard.press('Escape'); // leaves the cell
  await page.keyboard.press('Escape'); // back to the list

  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Letterhead/ }).click();
  await page.getByLabel(/Address and other lines/).fill('12, Gandhi Road\nNew Delhi');
  await page.getByLabel(/Firm name and signature/).fill('For JAIN & CO.\nChartered Accountants');
  // The live preview follows the typing, and switches to the index sheet for its title.
  await expect(page.locator('.lp .bc-address')).toContainText('12, Gandhi Road');
  await expect(page.locator('.lp .bc-firm')).toContainText('Chartered Accountants');
  await page.getByLabel('Index sheet title line 1').fill('INDEX OF BILLS 06-07');
  await expect(page.getByRole('tab', { name: 'Index sheet' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.lp .ix-title')).toHaveText('INDEX OF BILLS 06-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Letterhead saved.')).toBeVisible();
  expect(await data.letterhead()).toEqual({ firmName: ['For JAIN & CO.', 'Chartered Accountants'], firmAddress: ['12, Gandhi Road', 'New Delhi'], indexTitles: ['INDEX OF BILLS ##', '', ''] });
  await page.getByRole('button', { name: 'Print index' }).click();
  await expect(printed(page).locator('.ix-title')).toHaveText(['INDEX OF BILLS 06-07']);
});

test('backups: back up now, on exit, daily; compare and restore', async ({ page }) => {
  const picker = await start(page);
  const data = await dataCopy();
  await login(page, picker, data.dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  // Opening made today's automatic backup inside the data folder.
  await expect.poll(() => readdirSync(join(data.dir, 'backups')).length).toBe(1);
  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Backups…/ }).click();

  // A backup is a complete, checked copy that opens like the original, still encrypted.
  const bak = mkdtempSync(join(tmpdir(), 'usw-bak-'));
  picker.next(bak);
  await page.getByRole('button', { name: 'Back up now…' }).click();
  await expect(page.getByText(/Backed up and checked \d+ files/)).toBeVisible();
  expect(readdirSync(bak).sort()).toEqual(['backup.json', 'settings.dat', 'utility-soft.json', 'years']);
  expect(await (await WebBooks.unlock(new NodeDir(bak), 'puja'))!.readBillLines('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['pooja,20']);

  // Backup when exiting: the folder is remembered by its name.
  const auto = mkdtempSync(join(tmpdir(), 'usw-auto-'));
  picker.next(auto);
  await page.getByRole('button', { name: /(Change|Choose) folder…/ }).click();
  await expect(page.getByText('Auto-backup folder saved.')).toBeVisible();
  await expect(page.locator('.modal b.path')).toHaveText(auto.split('/').pop()!);
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();

  // A change, then restoring the daily backup puts it back.
  await data.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', ['pooja,99']);
  await page.getByRole('button', { name: /Backups…/ }).click();
  await page.getByRole('button', { name: 'Compare or restore…' }).click();
  const cmp = page.getByRole('dialog', { name: /^Backup of/ });
  await expect(cmp.locator('tbody tr')).toHaveText(['06-07 › RISHABH › Audit › PREM CHAND, row 1“pooja”, amount “20”“pooja”, amount “99”']);
  await cmp.getByRole('button', { name: 'Restore this backup…' }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText(/Restored the backup of/)).toBeVisible();
  expect(await data.bill('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['pooja,20']);
  // The data as it was before restoring is a backup too (today's one: one is kept per day).
  expect(readdirSync(join(data.dir, 'backups')).length).toBe(1);

  // Exit asks to back up into the chosen folder (selected again: these tests do not keep folders).
  picker.next(auto);
  await page.getByRole('button', { name: 'Exit' }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await page.getByRole('button', { name: 'Select folder…' }).click();
  await expect(page.getByText('Utility Soft is closed')).toBeVisible();
  const made = readdirSync(auto);
  expect(made).toHaveLength(1);
  expect(made[0]).toMatch(/^\d\d\.\d\d\.\d{4}\+\d{1,2}\.\d{1,2}\.\d{1,2}(AM|PM)$/);
  expect(readdirSync(join(auto, made[0])).sort()).toEqual(['backup.json', 'settings.dat', 'utility-soft.json', 'years']);
  expect(data.everything()).not.toContain('RISHABH');
});

test('deleted clients and bills come back from the bin', async ({ page }) => {
  const picker = await start(page);
  const data = await dataCopy();
  await login(page, picker, data.dir);
  await selectClient(page, 'PREM');
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Delete 1' }).click();
  await expectClients(page, ['1|RISHABH|']);
  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Deleted clients and bills/ }).click();
  const bin = page.getByRole('dialog', { name: 'Deleted clients and bills' });
  await expect(bin.locator('li')).toHaveCount(1);
  await expect(bin.locator('li')).toContainText('Client PREM (06-07)');
  await bin.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('PREM (06-07) is back, S.No. 1.')).toBeVisible();
  await expect(bin.getByText('Nothing was deleted in the last 30 days.')).toBeVisible();
  await bin.locator('.modal-foot button').click();
  await page.keyboard.press('Escape');
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
});
