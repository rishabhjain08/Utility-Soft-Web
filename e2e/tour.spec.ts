// Screenshots of every screen, for visual review (not assertions).
import { test } from '@playwright/test';
import { programCopy, selectClient, start } from './helpers';

test('tour', async ({ page }) => {
  const shot = (n: string) => page.screenshot({ path: `test-results/tour-${n}.png` });
  const picker = await start(page);
  await shot('01-welcome');
  const dir = programCopy();
  picker.next(dir);
  await page.getByRole('button', { name: /Open Utility Soft folder/ }).click();
  await shot('02-login');
  await page.getByLabel('Password').fill('puja');
  await page.getByRole('button', { name: 'OK' }).click();
  await page.getByRole('heading', { name: 'Move to the new format' }).waitFor();
  await shot('02b-move');
  await page.getByRole('button', { name: 'Keep using the desktop files' }).click();
  await page.locator('table.clients').waitFor();
  await selectClient(page, 'PREM');
  await shot('03-main');
  await page.getByRole('button', { name: 'Add new' }).click();
  await page.getByLabel('Name').fill('mohan lal');
  await shot('04-add');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Utility…' }).click();
  await shot('05-utility');
  await page.keyboard.press('Escape');
  await page.getByText('RISHABH').dblclick();
  await page.locator('.desc-input').nth(1).click();
  await shot('06-editor-suggest');
});
