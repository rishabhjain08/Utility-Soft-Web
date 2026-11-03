import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cipherValue, clientRows, expectClients, login, programCopy, selectClient, start } from './helpers';
import { encodeCipherValue } from '../src/core/codec';

test('login: wrong password, change password, log in with the new one', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  picker.next(dir);
  await page.getByRole('button', { name: /Open Utility Soft folder/ }).click();
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('Wrong password')).toBeVisible();

  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByLabel('Old password').fill('nope');
  await page.getByLabel('New password', { exact: true }).fill('secret 1');
  await page.getByLabel('New password again').fill('secret 1');
  await page.getByRole('button', { name: 'Change' }).click();
  await expect(page.getByText('The old password is wrong.')).toBeVisible();
  await page.getByLabel('Old password').fill('puja');
  await page.getByRole('button', { name: 'Change' }).click();
  await expect(page.getByText('Password changed.')).toBeVisible();
  expect(cipherValue(join(dir, 'pass.txt'))).toBe('secret 1');
  // No trailing newline, as Java writes it.
  expect(readFileSync(join(dir, 'pass.txt')).toString('latin1')).toBe("i[Yh[j\u0016'");

  await page.getByLabel('Password').fill('secret 1');
  await page.getByRole('button', { name: 'OK' }).click();
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
});

test('clients: add, late entry, modify, bill no., delete, search, keyboard', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  await login(page, picker, dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);

  // Add a normal entry (keyboard: Insert).
  await page.locator('.table-wrap').focus();
  await page.keyboard.press('Insert');
  await page.getByLabel('Name').fill('mohan');
  await page.keyboard.press('Enter');
  await expectClients(page, ['1|MOHAN|', '2|PREM|', '3|RISHABH|']);

  // Duplicate names are refused (case-insensitive).
  await page.getByRole('button', { name: 'Add new' }).click();
  await page.getByLabel('Name').fill('Prem');
  await expect(page.getByText('This name already exists.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  // Late entry gets a letter and leaves the others alone.
  await page.getByLabel('Name').fill('prakash');
  await expect(page.getByLabel(/in alphabetical order/)).toBeChecked();
  await expect(page.locator('.serial-choice')).toContainText('2, in alphabetical order Also changes PREM 2 → 3, RISHABH 3 → 4.');
  await page.getByLabel(/keeping everyone else/).check();
  await expect(page.locator('.serial-choice')).toContainText('1A, keeping everyone else’s S.No.');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expectClients(page, ['1|MOHAN|', '1A|PRAKASH|', '2|PREM|', '3|RISHABH|']);
  expect(existsSync(join(dir, 'data/bills/06-07/PRAKASH/Audit'))).toBe(true);
  expect(cipherValue(join(dir, 'data/bills/06-07/PRAKASH/serialno.txt'))).toBe('1A');

  // Bill No. inline edit (double-click the cell).
  await page.locator('tr', { hasText: 'PREM' }).filter({ hasNot: page.getByText('PRAKASH') }).locator('td.billno').dblclick();
  await page.getByLabel('Bill No.').fill('101-103');
  await page.keyboard.press('Enter');
  await expectClients(page, ['1|MOHAN|', '1A|PRAKASH|', '2|PREM|101-103', '3|RISHABH|']);
  expect(cipherValue(join(dir, 'data/bills/06-07/PREM/billfromto.txt'))).toBe('101-103');

  // Modify: rename RISHABH to AMIT (moves to the top, renumbers) and change bill no.
  await selectClient(page, 'RISHABH');
  await page.keyboard.press('F2');
  await page.getByLabel('Name').fill('Amit');
  // First in the list: always S.No. 1, so there is nothing to choose.
  await expect(page.locator('.serial-single')).toHaveText('S.No. 1 Also changes MOHAN 1 → 2, PRAKASH 1A → 2A, PREM 2 → 3.');
  await page.getByLabel('Bill No.').fill('b-9');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectClients(page, ['1|AMIT|B-9', '2|MOHAN|', '2A|PRAKASH|', '3|PREM|101-103']);
  expect(existsSync(join(dir, 'data/bills/06-07/RISHABH'))).toBe(false);
  expect(existsSync(join(dir, 'data/bills/06-07/AMIT/Audit/PREM CHAND.txt'))).toBe(true);

  // Quick search: typing jumps to the first match; Enter opens it.
  await page.locator('.table-wrap').focus();
  await page.keyboard.type('pre');
  await expect(page.locator('tr.selected td.name')).toHaveText('PREM');
  await page.keyboard.press('Escape');

  // Delete two clients (Ctrl+click to multi-select); one numbered, one lettered.
  await selectClient(page, 'MOHAN');
  await page.locator('tr', { hasText: 'PRAKASH' }).click({ modifiers: ['Control'] });
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog', { name: 'Delete clients?' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete 2' }).click();
  await expectClients(page, ['1|AMIT|B-9', '2|PREM|101-103']);
  expect(existsSync(join(dir, 'data/bills/06-07/MOHAN'))).toBe(false);

  // Keyboard navigation and Enter to open.
  await page.locator('.table-wrap').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.client-title b')).toHaveText('PREM');
});

test('the list picks up changes made by another computer', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  await login(page, picker, dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  const c = join(dir, 'data/bills/06-07/ZEBRA');
  mkdirSync(c);
  writeFileSync(join(c, 'serialno.txt'), encodeCipherValue('3'));
  writeFileSync(join(c, 'billfromto.txt'), encodeCipherValue('77'));
  await expect.poll(() => clientRows(page), { timeout: 12_000 }).toEqual(['1|PREM|', '2|RISHABH|', '3|ZEBRA|77']);
});
