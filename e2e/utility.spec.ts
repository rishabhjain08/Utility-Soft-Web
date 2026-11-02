import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cipherLines, cipherValue, clientRows, expectClients, login, printed, programCopy, start } from './helpers';
import { encodeCipherLines } from '../src/core/codec';

test('years: add next year, copy clients forward (fresh and overwrite), print index', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  mkdirSync(join(dir, 'data/bills/06-07/PREM/Vat'));
  writeFileSync(join(dir, 'data/bills/06-07/PREM/Vat/GOPAL.txt'), encodeCipherLines(['VAT return for ##,700', 'Expenses,50']));
  await login(page, picker, dir);

  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Add next year/ }).click();
  await page.getByRole('button', { name: 'Add 07-08' }).click();
  await expect(page.getByText(/Added year 07-08/)).toBeVisible();
  expect(existsSync(join(dir, 'data/bills/07-08'))).toBe(true);
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
  expect(cipherLines(join(dir, 'data/bills/07-08/PREM/Vat/GOPAL.txt'))).toEqual(['VAT return for ##,0', 'Expenses,0']);
  expect(cipherValue(join(dir, 'data/bills/07-08/PREM/serialno.txt'))).toBe('1');

  // Edit PREM's 07-08 bill, then copy again: RISHABH is new, PREM collides and is kept unless ticked.
  writeFileSync(join(dir, 'data/bills/07-08/PREM/Vat/GOPAL.txt'), encodeCipherLines(['VAT return for ##,800']));
  await page.getByRole('combobox', { name: 'Year' }).selectOption('06-07');
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Copy clients to another year/ }).click();
  await expect(dlg.getByText('Already in 07-08')).toBeVisible();
  await expect(dlg.getByRole('row', { name: /PREM/ }).getByRole('checkbox')).not.toBeChecked();
  await dlg.getByRole('button', { name: 'Copy 1' }).click();
  await expect(page.getByText('Copied 1 client to 07-08.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('07-08');
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  expect(cipherLines(join(dir, 'data/bills/07-08/PREM/Vat/GOPAL.txt'))).toEqual(['VAT return for ##,800']);

  // Overwrite PREM.
  await page.getByRole('combobox', { name: 'Year' }).selectOption('06-07');
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Copy clients to another year/ }).click();
  await dlg.getByRole('row', { name: /PREM/ }).getByRole('checkbox').check();
  await dlg.getByRole('button', { name: 'Copy 1' }).click();
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('07-08');
  expect(cipherLines(join(dir, 'data/bills/07-08/PREM/Vat/GOPAL.txt'))).toEqual(['VAT return for ##,0', 'Expenses,0']);

  // Index sheet.
  await page.getByRole('button', { name: 'Print index' }).click();
  await expect(printed(page).locator('.ix-table tbody tr')).toHaveCount(2);
  await expect(printed(page).locator('.ix-table tbody tr').first()).toContainText('PREM');
});

test('setup: add a tab, edit drop-down lists, letterhead', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  await login(page, picker, dir);

  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Add new tab/ }).click();
  await page.getByLabel('Tab name').fill('GST');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('Added the tab GST.')).toBeVisible();
  expect(cipherLines(join(dir, 'impinfo.txt'))[0]).toBe('(Audit^Audit)(Vat^Vat)(Tax^Tax)(Others^Others)(GST^GST)');
  expect(existsSync(join(dir, 'data/bills/06-07/PREM/GST'))).toBe(true);

  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Edit drop-down lists/ }).click();
  const dd = page.getByRole('dialog', { name: 'Edit drop-down lists' });
  await dd.getByRole('tab', { name: 'GST' }).click();
  await dd.getByRole('button', { name: '+ Add entry' }).click();
  await dd.getByLabel('Entry 1').fill('GST return for the year ##');
  await dd.getByRole('button', { name: '+ Add entry' }).click();
  await dd.getByLabel('Entry 2').fill('Expenses');
  await dd.getByRole('tab', { name: 'Vat' }).click();
  await dd.getByLabel('Entry 3').fill('');
  await dd.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Drop-down lists saved.')).toBeVisible();
  const lines = readFileSync(join(dir, 'ddown.txt'), 'latin1').split('\r\n');
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

  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Letterhead/ }).click();
  await page.getByLabel(/Address and other lines/).fill('12, Gandhi Road\nNew Delhi');
  await page.getByLabel(/Firm name and signature/).fill('For JAIN & CO.\nChartered Accountants');
  await page.getByPlaceholder('Line 1').fill('INDEX OF BILLS ##');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Letterhead saved.')).toBeVisible();
  const info = cipherLines(join(dir, 'impinfo.txt'));
  expect(info.slice(1, 4)).toEqual(['~For JAIN & CO.%~Chartered Accountants%', '~12, Gandhi Road%~New Delhi%', '%$INDEX OF BILLS ##%$%$%$']);
  await page.getByRole('button', { name: 'Print index' }).click();
  await expect(printed(page).locator('.ix-title')).toHaveText(['INDEX OF BILLS 06-07']);
});

test('data location, backup now, auto-backup on exit', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  await login(page, picker, dir);

  // Move the data to a folder inside the program folder: stored as a relative path.
  mkdirSync(join(dir, 'office data/bills/09-10/NEW CLIENT'), { recursive: true });
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Data location/ }).click();
  picker.next(join(dir, 'office data'));
  await page.getByRole('button', { name: 'Choose data folder…' }).click();
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('09-10');
  await expect.poll(() => clientRows(page)).toEqual(['|NEW CLIENT|']);
  expect(readFileSync(join(dir, 'loaddatafrom.txt'), 'latin1')).toBe('office data\r\n1');
  expect(existsSync(join(dir, 'office data/activelocation.txt'))).toBe(true);

  // A folder outside the program folder needs its full path for the desktop version.
  const outside = mkdtempSync(join(tmpdir(), 'usw-outside-'));
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Data location/ }).click();
  picker.next(outside);
  await page.getByRole('button', { name: 'Choose data folder…' }).click();
  await page.getByRole('textbox', { name: /Full path of/ }).fill('relative\\no');
  await expect(page.getByRole('button', { name: 'OK' })).toBeDisabled();
  await page.getByRole('textbox', { name: /Full path of/ }).fill('D:\\Office\\Bills');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('There are no years yet.')).toBeVisible();
  expect(readFileSync(join(dir, 'loaddatafrom.txt'), 'latin1')).toBe('D:\\Office\\Bills\r\n1');
  expect(readdirSync(outside).sort()).toEqual(['activelocation.txt', 'bills']);

  // Back to the default data folder.
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Data location/ }).click();
  await page.getByRole('button', { name: /Use the “data” folder/ }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  expect(readFileSync(join(dir, 'loaddatafrom.txt')).length).toBe(0);

  // Back up now.
  const bak = mkdtempSync(join(tmpdir(), 'usw-bak-'));
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Backup and auto-backup/ }).click();
  picker.next(bak);
  await page.getByRole('button', { name: 'Back up now…' }).click();
  await expect(page.getByText(/Backed up \d+ files/)).toBeVisible();
  expect(readFileSync(join(bak, 'bills/06-07/RISHABH/Audit/PREM CHAND.txt'))).toEqual(readFileSync(join(dir, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt')));

  // Auto-backup folder inside the program folder (relative path in backupto.txt).
  mkdirSync(join(dir, 'backups'));
  picker.next(join(dir, 'backups'));
  await page.getByRole('button', { name: 'Change folder…' }).click();
  await expect(page.getByText('Auto-backup folder saved.')).toBeVisible();
  expect(cipherValue(join(dir, 'backupto.txt'))).toBe('backups');
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();

  // Exit asks to back up, writes a dated folder, then shows the closed screen.
  await page.getByRole('button', { name: 'Exit Utility Soft' }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByText('Utility Soft is closed')).toBeVisible();
  const made = readdirSync(join(dir, 'backups'));
  expect(made).toHaveLength(1);
  expect(made[0]).toMatch(/^\d\d\.\d\d\.\d{4}\+\d{1,2}\.\d{1,2}\.\d{1,2}(AM|PM)$/);
  expect(readdirSync(join(dir, 'backups', made[0])).sort()).toEqual(['activelocation.txt', 'bills']);
});
