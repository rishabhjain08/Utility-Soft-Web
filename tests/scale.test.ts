// Timings with a large office: 2,000 clients over 10 years. Run with SCALE=1 (it takes a few minutes).
import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDir } from './nodefs';
import { FAST, copyOf, desktopOf, empty, javaClient } from './testdata';
import { exportToDesktop, migrateDesktop } from '../src/core/migrate';
import { WebBooks } from '../src/core/webstore';

const CLIENTS = Number(process.env.CLIENTS ?? 2000);
const YEARS = Number(process.env.YEARS ?? 10);

describe.runIf(process.env.SCALE)('a large office', () => {
  it('moves, lists, saves and exports in reasonable time', async () => {
    const root = copyOf('java-sample');
    const years = Array.from({ length: YEARS }, (_, i) => `${String(10 + i).padStart(2, '0')}-${String(11 + i).padStart(2, '0')}`);
    for (const y of years) {
      mkdirSync(join(root, 'data/bills', y), { recursive: true });
      for (let c = 0; c < CLIENTS; c++) {
        javaClient(root, y, `CLIENT ${String(c).padStart(4, '0')}`, String(c + 1), String(c), {
          'Audit/TAX AUDIT': ['Fee for Tax Audit for the Assessment Year ##,25000', 'Expenses,500', 'New Name,New', 'Fee for IT Return,3500'],
          'Tax/ITR': ['Fee for IT Return for the Assessment Year ##,3500'],
        });
      }
    }
    const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
      const t = performance.now();
      const r = await fn();
      console.log(`${label}: ${((performance.now() - t) / 1000).toFixed(1)} s`);
      return r;
    };
    const dest = empty();
    const m = await time(`move ${CLIENTS * YEARS} client-years and check them`, () => migrateDesktop(desktopOf(root), new NodeDir(dest), FAST));
    expect(m.report.ok).toBe(true);
    expect(m.report.counts.bills).toBe(CLIENTS * YEARS * 2 + 1); // and the sample's own bill
    const web = (await time('open (password)', () => WebBooks.unlock(new NodeDir(dest), 'puja')))!;
    const first = await time(`list ${CLIENTS} clients, first time`, () => web.clients(years[YEARS - 1]));
    expect(first).toHaveLength(CLIENTS);
    await time(`list ${CLIENTS} clients again (nothing changed)`, () => web.clients(years[YEARS - 1]));
    await time('save a bill', () => web.writeBill(years[YEARS - 1], `CLIENT ${String(CLIENTS / 2).padStart(4, '0')}`, 'Audit', 'TAX AUDIT', [{ desc: 'Fee', amount: '1' }]));
    await time(`add a client (renumbers ${CLIENTS / 2})`, () => web.addClient(years[YEARS - 1], `CLIENT ${String(CLIENTS / 2 - 1).padStart(4, '0')}A`, false));
    await time('export and check', () => exportToDesktop(web, new NodeDir(empty()), 'puja'));
  }, 3_600_000); // Nothing may take an hour.
});
