import { test, expect } from '@playwright/test';
import { expectClients, gridRows, login, programCopy, start } from './helpers';

test('opens the Java sample folder and shows its bills', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  await login(page, picker, dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await page.getByText('RISHABH').dblclick();
  await expect(page.locator('.client-title b')).toHaveText('RISHABH');
  await expect.poll(() => gridRows(page)).toEqual(['pooja|20']);
  await page.screenshot({ path: 'test-results/smoke-editor.png' });
});
