// Moving a desktop (Java) folder to the web format, comparing, exporting.
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { cipherLines, expectClients, login, programCopy, start } from './helpers';
import { encodeCipherLines, encodeCipherValue, encodePlain, encodePlainLines } from '../src/core/codec';

/** Every file and folder with its bytes and modified time. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      out[relative(root, p)] = st.isDirectory() ? `dir ${st.mtimeMs}` : `${st.mtimeMs} ${readFileSync(p).toString('base64')}`;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

test('move to the new format: refuses a place inside, warns about open clients, leaves the folder as it was', async ({ page }) => {
  const dir = programCopy();
  writeFileSync(join(dir, 'data/activelocation.txt'), encodePlainLines(['06-07,PREM']));
  writeFileSync(join(dir, 'data/bills/06-07/PREM/notes.txt'), 'kept as it is');
  const before = snapshot(dir);
  const picker = await start(page);
  await login(page, picker, dir, 'puja', false);
  await expect(page.getByText('is in the desktop (Java) version\'s format')).toBeVisible();

  // Inside the desktop folder: refused before anything is created.
  picker.next(dir);
  await page.getByRole('button', { name: 'Make a copy in the new format…' }).click();
  await expect(page.getByRole('dialog', { name: 'Clients open in the desktop version' })).toContainText('06-07 PREM');
  await page.getByRole('button', { name: 'Make the copy anyway' }).click();
  await expect(page.getByRole('dialog', { name: 'Where should the copy go?' })).toContainText('Choose a place outside');
  await page.getByRole('button', { name: 'OK' }).click();
  expect(snapshot(dir)).toEqual(before);

  // A folder with other things in it: the copy gets its own folder.
  const place = mkdtempSync(join(tmpdir(), 'usw-place-'));
  writeFileSync(join(place, 'other.txt'), 'x');
  picker.next(place);
  await page.getByRole('button', { name: 'Make a copy in the new format…' }).click();
  await page.getByRole('button', { name: 'Make the copy anyway' }).click();
  await expect(page.getByLabel('Name of the new folder')).toHaveValue('Utility Soft Data');
  await page.getByRole('button', { name: 'Create' }).click();
  const report = page.getByRole('dialog', { name: 'Copy made and checked' });
  await expect(report.locator('.report-ok')).toHaveText(/Everything matches: 1 year, 2 clients and 1 bill \(1 row\)/);
  await expect(report.locator('.report-notes')).toContainText('1 other file in the data folder (not bills) is kept exactly as it was.');
  await report.getByRole('button', { name: 'Open the copy' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await expect(page.locator('.statusbar')).toContainText('Data: Utility Soft Data');

  expect(snapshot(dir)).toEqual(before);
  expect(readdirSync(join(place, 'Utility Soft Data')).sort()).toEqual(['desktop-extras', 'utility-soft.json', 'years']);
  expect(readFileSync(join(place, 'Utility Soft Data/desktop-extras/bills/06-07/PREM/notes.txt'), 'utf8')).toBe('kept as it is');

  // Utility in the web format: no desktop-only items; export and compare instead.
  await page.getByRole('button', { name: 'Utility…' }).click();
  const util = page.getByRole('dialog', { name: 'Utility' });
  await expect(util.getByRole('button', { name: /Data location/ })).toHaveCount(0);
  await expect(util.getByRole('button', { name: /Check bills for the desktop version/ })).toHaveCount(0);
  await expect(util.getByRole('button', { name: /Export for the desktop version/ })).toBeVisible();
  await expect(util.getByRole('button', { name: /Compare with a desktop folder/ })).toBeVisible();

  // Bills entered in the desktop version afterwards show up as differences.
  writeFileSync(join(dir, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt'), encodeCipherLines(['pooja,25', 'Fee,100']));
  writeFileSync(join(dir, 'data/bills/06-07/PREM/serialno.txt'), encodeCipherValue('1A'));
  picker.next(dir);
  await util.getByRole('button', { name: /Compare with a desktop folder/ }).click();
  const cmp = page.getByRole('dialog', { name: 'Differences from the desktop folder' });
  await expect(cmp.locator('.report-bad')).toContainText('2 differences found');
  await expect(cmp.locator('tbody tr')).toHaveText([
    '06-07 › PREM › S.No.1A1',
    '06-07 › RISHABH › Audit › PREM CHAND, row 1“pooja”, amount “25”“pooja”, amount “20”',
  ]);
  await cmp.locator('.modal-foot button').click();
});

test('a desktop folder whose data is kept elsewhere, moved from the Utility menu', async ({ page }) => {
  const dir = programCopy();
  const elsewhere = mkdtempSync(join(tmpdir(), 'usw-data-'));
  // The data folder is somewhere else (Utility ▸ Data location in the Java version).
  const { cpSync, rmSync } = await import('node:fs');
  cpSync(join(dir, 'data'), elsewhere, { recursive: true });
  rmSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'loaddatafrom.txt'), encodePlain('D:\\Office\\Data\r\n1'));
  const picker = await start(page);
  await login(page, picker, dir);
  picker.next(elsewhere);
  await page.getByRole('button', { name: 'Select folder…' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await expect(page.locator('.format-badge')).toContainText('desktop format');

  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Move to the new format/ }).click();
  // The browser does not remember folders in these tests, so it asks for the data folder again.
  const dest = mkdtempSync(join(tmpdir(), 'usw-copy-'));
  picker.next(elsewhere);
  picker.next(dest);
  await page.getByRole('button', { name: 'Select folder…' }).click();
  const report = page.getByRole('dialog', { name: 'Copy made and checked' });
  await expect(report.locator('.report-ok')).toBeVisible();
  await report.getByRole('button', { name: 'Open the copy' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await expect(page.locator('.format-badge')).toHaveCount(0);
  expect(JSON.parse(readFileSync(join(dest, 'utility-soft.json'), 'utf8')).migratedFrom.data).toBe('D:\\Office\\Data');
  expect(cipherLines(join(elsewhere, 'bills/06-07/RISHABH/Audit/PREM CHAND.txt'))).toEqual(['pooja,20']);
});
