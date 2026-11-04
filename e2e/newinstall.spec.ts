import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cipherLines, cipherValue, expectClients, exportTo, gridRows, printed, programCopy, saveRecoveryCode, start, waitSaved } from './helpers';
import { WebBooks } from '../src/core/webstore';
import { NodeDir } from '../tests/nodefs';

function everything(root: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      parts.push(e.name);
      if (e.isDirectory()) walk(join(d, e.name));
      else parts.push(readFileSync(join(d, e.name)).toString('latin1'));
    }
  };
  walk(root);
  return parts.join('\n');
}

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

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

  // The recovery code first: there is no going on without saving it.
  await saveRecoveryCode(page);

  // Letterhead (the Java "registration" steps).
  await expect(page.getByRole('heading', { name: 'Your letterhead' })).toBeVisible();
  // Until filled in, the preview shows sample lines in grey.
  await expect(page.locator('.lp.ph-address.ph-firm .bc-address')).toContainText('12, Station Road');
  await page.getByLabel(/Address and other lines/).fill('MG Road, Jaipur');
  await page.getByLabel(/Firm name and signature/).fill('For R. K. & Co.\n\nPartner');
  await expect(page.locator('.lp:not(.ph-address):not(.ph-firm) .bc-firm')).toContainText('For R. K. & Co.');
  await page.getByRole('button', { name: 'Save' }).click();

  // No years yet.
  await page.getByRole('button', { name: 'Add the first year…' }).click();
  await page.getByLabel('Year (like 26-27)').fill('26-27');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('No clients in 26-27 yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Add new client' }).click();
  await page.getByLabel('Name').fill('sharma traders');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expectClients(page, ['1|SHARMA TRADERS|1']);

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
  await page.getByRole('button', { name: 'Print…' }).click();
  await expect(printed(page).locator('.bill-copy').first().locator('.bc-words')).toHaveText('(Rs. Twenty Six Thousand Five Hundred only.)');
  await expect(printed(page).locator('.bill-copy').first().locator('.bc-firm')).toContainText('For R. K. & Co.');

  // Kept in the web format, encrypted: nothing on disk can be read without the password.
  expect(readdirSync(dir).sort()).toEqual(['backups', 'history', 'open', 'settings.dat', 'utility-soft.json', 'years']);
  const ws = (await WebBooks.unlock(new NodeDir(dir), 'abc'))!;
  expect(await ws.letterhead()).toEqual({ firmName: ['For R. K. & Co.', '', 'Partner'], firmAddress: ['MG Road, Jaipur'], indexTitles: ['', '', ''] });
  const [rec] = await ws.records('26-27');
  expect(rec).toMatchObject({
    name: 'SHARMA TRADERS',
    serial: '1',
    billNo: '1',
    bills: [{ type: 'Audit', name: 'RAMESH SHARMA', groups: [{ rows: [{ text: 'Fee for Tax Audit for the Assessment Year ##', amount: 25000 }, { text: 'Expenses', amount: 1500 }] }] }],
  });
  expect(await ws.openClients()).toEqual([['26-27', 'SHARMA TRADERS']]);
  const disk = everything(dir);
  for (const secret of ['SHARMA', 'RAMESH', 'Jaipur', 'Expenses', 'abc"']) expect(disk).not.toContain(secret);

  // Exported for the desktop version: files exactly as the Java program lays them out.
  await page.getByRole('button', { name: '← Done' }).click();
  const out = mkdtempSync(join(tmpdir(), 'usw-export-'));
  await exportTo(page, picker, out);
  expect(readdirSync(out).sort()).toEqual(['backupto.txt', 'data', 'ddown.txt', 'impinfo.txt', 'loaddatafrom.txt', 'pass.txt']);
  expect(cipherValue(join(out, 'pass.txt'))).toBe('abc');
  expect(cipherLines(join(out, 'impinfo.txt'))).toEqual([
    '(Audit^Audit)(Vat^Vat)(Tax^Tax)(Others^Others)',
    '~For R. K. & Co.%~%~Partner%',
    '~MG Road, Jaipur%',
    '%$%$%$%$',
  ]);
  expect(readdirSync(join(out, 'data/bills/26-27/SHARMA TRADERS')).sort()).toEqual(['Audit', 'Others', 'Tax', 'Vat', 'billfromto.txt', 'serialno.txt']);
  expect(cipherLines(join(out, 'data/bills/26-27/SHARMA TRADERS/Audit/RAMESH SHARMA.txt'))).toEqual([
    'Fee for Tax Audit for the Assessment Year ##,25000',
    'Expenses,1500',
  ]);
  expect(readFileSync(join(out, 'data/activelocation.txt'), 'latin1')).toBe('');
  expect(readdirSync(join(dir, 'open'))).toEqual([]);
});

test('starting a new Utility Soft creates its own folder inside a busy one', async ({ page }) => {
  const picker = await start(page);
  const place = mkdtempSync(join(tmpdir(), 'usw-place-'));
  mkdirSync(join(place, 'Utility Soft Files'));
  writeFileSync(join(place, 'notes.txt'), 'x');

  picker.next(place);
  await page.getByRole('button', { name: 'Start a new Utility Soft…' }).click();
  const name = page.getByLabel('Name of the new folder');
  await expect(name).toHaveValue('Utility Soft Files 2');
  await name.fill('notes.TXT');
  await expect(page.getByText('already exists')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();
  await name.fill('Billing');
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('heading', { name: 'New Utility Soft' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('abc');
  await page.getByLabel('Password again').fill('abc');
  await page.getByRole('button', { name: 'Continue' }).click();
  await saveRecoveryCode(page);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Add the first year…' })).toBeVisible();

  expect(readdirSync(place).sort()).toEqual(['Billing', 'Utility Soft Files', 'notes.txt']);
  expect(json(join(place, 'Billing', 'utility-soft.json'))).toMatchObject({ format: 'utility-soft', recoverySaved: true });
});

test('starting a new Utility Soft in an existing one offers to open it', async ({ page }) => {
  const picker = await start(page);
  picker.next(programCopy());
  await page.getByRole('button', { name: 'Start a new Utility Soft…' }).click();
  await page.getByRole('button', { name: 'Open it' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
});

test('starting a new Utility Soft in an empty folder uses it directly', async ({ page }) => {
  const picker = await start(page);
  const dir = mkdtempSync(join(tmpdir(), 'usw-empty-'));
  picker.next(dir);
  await page.getByRole('button', { name: 'Start a new Utility Soft…' }).click();
  await expect(page.getByRole('heading', { name: 'New Utility Soft' })).toBeVisible();
});
