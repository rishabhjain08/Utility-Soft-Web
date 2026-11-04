// Renders what "Print…" sends to the printer into PDFs (Chrome's print engine),
// so the A4 layout can be checked: test-results/print-*.pdf
import { test, expect, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataCopy, expectClients, login, printed, start } from './helpers';
import { encodeCipherLines } from '../src/core/codec';

/** Puts the last printout back into the print root and renders it with Chrome's print engine. */
async function printToPdf(page: Page, file: string): Promise<number> {
  await page.evaluate(() => {
    document.getElementById('print-root')!.innerHTML = document.getElementById('printed')!.innerHTML;
    document.body.classList.add('printing');
  });
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  writeFileSync(file, pdf);
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => {
    document.body.classList.remove('printing');
    document.getElementById('print-root')!.innerHTML = '';
  });
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

test('bills and index print on A4 pages', async ({ page }) => {
  const picker = await start(page);
  const data = await dataCopy((dir) => {
    mkdirSync(join(dir, 'data/bills/06-07/PREM/Tax'), { recursive: true });
    writeFileSync(join(dir, 'impinfo.txt'), encodeCipherLines([
      '(Audit^Audit)(Vat^Vat)(Tax^Tax)(Others^Others)',
      '~For JAIN & ASSOCIATES%~Chartered Accountants%~%~(Proprietor)%',
      '~12, Gandhi Road%~New Delhi - 110001%~Ph: 2345678%',
      '%$INDEX OF BILLS FOR THE YEAR ##%$JAIN & ASSOCIATES%$%$',
    ]));
    writeFileSync(join(dir, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt'), encodeCipherLines([
      'SHRI PREM CHAND,', 'Fee for Tax Audit for the Assessment Year ##,15000', 'Expenses,1250', 'New Name,New', 'SMT. POOJA,',
      'Fee for IT Return for the Assessment Year ## including computation of income from house property and capital gains,3500', 'Expenses,-200',
    ]));
    // A long bill that needs its own page per copy.
    writeFileSync(join(dir, 'data/bills/06-07/PREM/Tax/LONG.txt'), encodeCipherLines(
      Array.from({ length: 30 }, (_, i) => `Item number ${i + 1} for the Assessment Year ##,${(i + 1) * 100}`),
    ));
  });
  await login(page, picker, data.dir);
  await expectClients(page, ['1|PREM|', '2|RISHABH|']);
  await page.locator('.table-wrap').focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+p');
  await page.getByLabel('Date to be printed').fill('01.11.2026');
  await page.getByRole('button', { name: 'Print…' }).click();
  await expect(printed(page).locator('.bill-copy')).toHaveCount(4);
  const bills = await printToPdf(page, 'test-results/print-bills.pdf');
  // Short bill: both copies on one page. Long bill: one page per copy.
  expect(bills).toBe(3);

  await page.getByRole('button', { name: 'Print index' }).click();
  await expect(printed(page).locator('.ix-table')).toBeVisible();
  expect(await printToPdf(page, 'test-results/print-index.pdf')).toBe(1);
});
