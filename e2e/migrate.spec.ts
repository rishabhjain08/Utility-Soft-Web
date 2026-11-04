// Moving a desktop (Java) folder to the web format, comparing, exporting.
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { cipherLines, expectClients, login, migrateTo, programCopy, saveRecoveryCode, start } from './helpers';
import { WebBooks } from '../src/core/webstore';
import { NodeDir } from '../tests/nodefs';
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
  await login(page, picker, dir);
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
  await expect(report.locator('.report-notes')).toContainText('1 other file from the desktop data folder (not bills) is kept exactly as it was.');
  await expect(report).toContainText('is not encrypted: anyone using this computer can read it');
  await report.getByRole('button', { name: 'Open the copy' }).click();
  // The recovery code must be saved before going on.
  await saveRecoveryCode(page);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await expect(page.locator('.statusbar')).toContainText('Data: Utility Soft Data');

  expect(snapshot(dir)).toEqual(before);
  const copy = join(place, 'Utility Soft Data');
  expect(readdirSync(copy).sort()).toEqual(['backups', 'extras', 'history', 'settings.dat', 'utility-soft.json', 'years']);
  const ws = (await WebBooks.unlock(new NodeDir(copy), 'puja'))!;
  const [kept] = (await ws.settings()).desktop.files;
  expect(kept.path).toBe('bills/06-07/PREM/notes.txt');
  expect(new TextDecoder().decode((await ws.readExtra(kept))!)).toBe('kept as it is');

  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  const util = page.getByRole('dialog', { name: 'Utility' });
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

test('a desktop folder whose data is kept elsewhere', async ({ page }) => {
  const dir = programCopy();
  const elsewhere = mkdtempSync(join(tmpdir(), 'usw-data-'));
  // The data folder is somewhere else (Utility ▸ Data location in the Java version).
  const { cpSync, rmSync } = await import('node:fs');
  cpSync(join(dir, 'data'), elsewhere, { recursive: true });
  rmSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'loaddatafrom.txt'), encodePlain('D:\\Office\\Data\r\n1'));
  const picker = await start(page);
  await login(page, picker, dir);
  const dest = mkdtempSync(join(tmpdir(), 'usw-copy-'));
  picker.next(elsewhere);
  picker.next(dest);
  await page.getByRole('button', { name: 'Make a copy in the new format…' }).click();
  await expect(page.getByRole('dialog', { name: 'Where is the data?' })).toContainText('D:\\Office\\Data');
  await page.getByRole('button', { name: 'Select folder…' }).click();
  const report = page.getByRole('dialog', { name: 'Copy made and checked' });
  await expect(report.locator('.report-ok')).toBeVisible();
  await report.getByRole('button', { name: 'Open the copy' }).click();
  await saveRecoveryCode(page);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  const ws = (await WebBooks.unlock(new NodeDir(dest), 'puja'))!;
  expect((await ws.settings()).migratedFrom?.data).toBe('D:\\Office\\Data');
  expect(cipherLines(join(elsewhere, 'bills/06-07/RISHABH/Audit/PREM CHAND.txt'))).toEqual(['pooja,20']);
});

test('a desktop folder without a password: one is chosen for the copy, the folder stays as it is', async ({ page }) => {
  const dir = programCopy();
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'pass.txt'));
  const before = snapshot(dir);
  const picker = await start(page);
  picker.next(dir);
  await page.getByRole('button', { name: /Open Utility Soft folder/ }).click();
  await expect(page.getByRole('heading', { name: 'Choose a password' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('newpw');
  await page.getByLabel('Password again').fill('newpw');
  await page.getByRole('button', { name: 'Continue' }).click();
  const dest = mkdtempSync(join(tmpdir(), 'usw-copy-'));
  await migrateTo(page, picker, dest);
  expect(snapshot(dir)).toEqual(before);
  expect(await WebBooks.unlock(new NodeDir(dest), 'newpw')).not.toBe(null);
});
