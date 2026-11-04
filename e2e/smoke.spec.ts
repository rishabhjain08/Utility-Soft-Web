import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectClients, gridRows, login, migrateTo, programCopy, start } from './helpers';

test('moves the Java sample folder to the web format and shows its bills', async ({ page }) => {
  const picker = await start(page);
  const dir = programCopy();
  await login(page, picker, dir);
  await migrateTo(page, picker, mkdtempSync(join(tmpdir(), 'usw-smoke-')));
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await page.getByText('RISHABH').dblclick();
  await expect(page.locator('.client-title b')).toHaveText('RISHABH');
  await expect.poll(() => gridRows(page)).toEqual(['pooja|20']);
  await page.screenshot({ path: 'test-results/smoke-editor.png' });
});
