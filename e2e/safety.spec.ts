// Undo, earlier versions, changes from another computer, damaged files, locking, the recovery code.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataCopy, earlier, expectClients, gridRows, login, saveRecoveryCode, start, waitSaved } from './helpers';
import { WebBooks } from '../src/core/webstore';
import { rowsFromLines } from '../src/core/bill';
import { encodeCipherLines } from '../src/core/codec';
import { NodeDir } from '../tests/nodefs';

test('undo and redo in a bill; earlier versions of it', async ({ page }) => {
  const data = await dataCopy();
  // Two earlier saves, more than 10 minutes apart, keep versions.
  await earlier(data, 40).writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', rowsFromLines(['pooja,30'], '06-07'));
  await earlier(data, 25).writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', rowsFromLines(['pooja,40', 'Fee,5'], '06-07'));
  const picker = await start(page);
  await login(page, picker, data.dir);
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|40', 'Fee|5']);

  const amt = page.locator('.grid [data-row="0"][data-col="amount"]');
  await amt.fill('41');
  await page.locator('.grid [data-row="1"][data-col="desc"]').fill('Fees');
  await waitSaved(page);
  await page.keyboard.press('Control+z');
  await expect.poll(() => gridRows(page)).toEqual(['pooja|41', 'Fee|5']);
  await page.keyboard.press('Control+z');
  await expect.poll(() => gridRows(page)).toEqual(['pooja|40', 'Fee|5']);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|41', 'Fee|5']);
  await waitSaved(page);
  expect(await data.bill('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['pooja,41', 'Fee,5']);

  await page.getByRole('button', { name: 'Bill utility…' }).click();
  await page.getByRole('button', { name: /Earlier versions of the bill/ }).click();
  const v = page.getByRole('dialog', { name: 'Earlier versions — PREM CHAND' });
  await expect(v.locator('li')).toHaveCount(3);
  await expect(v.locator('li').last()).toContainText('total 20/-');
  await v.locator('li').last().getByRole('button', { name: 'Use this version' }).click();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|20']);
  await page.keyboard.press('Control+z');
  await expect.poll(() => gridRows(page)).toEqual(['pooja|41', 'Fee|5']);
});

test('a bill changed on another computer while open here', async ({ page }) => {
  const data = await dataCopy();
  const picker = await start(page);
  await login(page, picker, data.dir);
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|20']);
  await data.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', ['pooja,77']);
  await page.locator('.grid [data-row="0"][data-col="amount"]').fill('25');
  const dlg = page.getByRole('dialog', { name: 'Changed on another computer' });
  await expect(dlg).toContainText('The bill PREM CHAND was changed on another computer');
  await dlg.getByRole('button', { name: 'Show the other version' }).click();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|77']);
  // Typing again saves normally on top of it.
  await page.locator('.grid [data-row="0"][data-col="amount"]').fill('78');
  await waitSaved(page);
  expect(await data.bill('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['pooja,78']);
  // Keeping mine, the next time.
  await data.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', ['pooja,1']);
  await page.locator('.grid [data-row="0"][data-col="amount"]').fill('79');
  await dlg.getByRole('button', { name: 'Keep mine' }).click();
  await waitSaved(page);
  expect(await data.bill('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['pooja,79']);
});

test('a damaged client file is set aside and its last good version put back', async ({ page }) => {
  const data = await dataCopy();
  await earlier(data, 30).setBillNo('06-07', 'PREM', '11');
  await earlier(data, 15).setBillNo('06-07', 'PREM', '12');
  const ws = (await WebBooks.unlock(new NodeDir(data.dir), 'puja'))!;
  const id = (await ws.records('06-07')).find((r) => r.name === 'PREM')!.id;
  const file = join(data.dir, 'years/06-07', `${id}.dat`);
  writeFileSync(file, readFileSync(file).subarray(0, 40));
  const picker = await start(page);
  await login(page, picker, data.dir);
  await expectClients(page, ['2|RISHABH|']);
  const banner = page.locator('.problems');
  await expect(banner).toContainText('The file of PREM (06-07) cannot be read');
  await banner.getByRole('button', { name: 'Put back its last good version' }).click();
  await expectClients(page, ['1|PREM|11', '2|RISHABH|']);
  await expect(banner).toHaveCount(0);
});

test('amounts the desktop version stored that are not numbers are flagged', async ({ page }) => {
  const data = await dataCopy((dir) => writeFileSync(join(dir, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt'), encodeCipherLines(['pooja,20', 'odd,12a'])));
  const picker = await start(page);
  await login(page, picker, data.dir);
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  const odd = page.locator('.grid [data-row="1"][data-col="amount"]');
  await expect(odd).toHaveValue('12a');
  await expect(odd).toHaveClass(/invalid/);
  await expect(odd).toHaveAttribute('title', /not counted in the total/);
  await expect(page.locator('tfoot td.amt').first()).toHaveText('20/-');
});

test('locks after 15 minutes without use', async ({ page }) => {
  await page.clock.install();
  const data = await dataCopy();
  const picker = await start(page);
  await login(page, picker, data.dir);
  await page.getByRole('cell', { name: 'RISHABH' }).dblclick();
  await expect.poll(() => gridRows(page)).toEqual(['pooja|20']);
  await page.clock.fastForward('16:00');
  await expect(page.getByText('Locked after 15 minutes without use.')).toBeVisible();
  await expect.poll(() => data.locks()).toEqual([]);
  await page.getByLabel('Password').fill('puja');
  await page.getByRole('button', { name: 'OK' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
});

test('a new recovery code needs the password, and replaces the old one only once saved', async ({ page }) => {
  const data = await dataCopy();
  const picker = await start(page);
  await login(page, picker, data.dir);
  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /New recovery code/ }).click();
  await page.getByLabel('Your password').fill('wrong');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Wrong password.')).toBeVisible();
  await page.getByRole('button', { name: /New recovery code/ }).click();
  await page.getByLabel('Your password').fill('puja');
  await page.getByRole('button', { name: 'Continue' }).click();
  // Cancelling keeps the old code.
  await page.getByRole('button', { name: 'Cancel (keep the old code)' }).click();
  expect(await WebBooks.unlockWithRecovery(new NodeDir(data.dir), data.recoveryCode)).not.toBe(null);
  await page.getByRole('button', { name: /New recovery code/ }).click();
  await page.getByLabel('Your password').fill('puja');
  await page.getByRole('button', { name: 'Continue' }).click();
  const code = await saveRecoveryCode(page);
  await expect(page.getByText('Recovery code saved.')).toBeVisible();
  expect(await WebBooks.unlockWithRecovery(new NodeDir(data.dir), data.recoveryCode)).toBe(null);
  expect(await WebBooks.unlockWithRecovery(new NodeDir(data.dir), code)).not.toBe(null);
  expect(readdirSync(data.dir)).toContain('utility-soft.json');
});
