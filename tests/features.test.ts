// Payments, client details, tabs, Bill numbers and searching.
import { beforeEach, describe, expect, it } from 'vitest';
import { NodeDir } from './nodefs';
import { FAST, copyOf, desktopOf, empty, everything } from './testdata';
import { WebBooks } from '../src/core/webstore';
import { migrateDesktop, exportToDesktop } from '../src/core/migrate';
import { billNoClashes, billNoFor, billNumbers, nextBillNo } from '../src/core/billno';
import { searchAll } from '../src/core/search';
import { compare, webSide } from '../src/core/verify';
import { makeBackup, openBackup } from '../src/core/backup';

let web: WebBooks;
let dir: string;
beforeEach(async () => {
  dir = empty();
  web = (await migrateDesktop(desktopOf(copyOf('java-sample')), new NodeDir(dir), FAST)).books;
  await web.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [
    { desc: 'Fee for Tax Audit for the Assessment Year 06-07', amount: '25000' },
    { desc: 'Expenses', amount: '1500' },
  ]);
});

describe('payments', () => {
  it('records money received and agreed reductions, and what is due', async () => {
    await web.addPayment('06-07', 'RISHABH', 'Audit', 'PREM CHAND', { date: '2007-05-10', amount: 20000, kind: 'received', note: 'cheque 1234' });
    await web.addPayment('06-07', 'RISHABH', 'Audit', 'PREM CHAND', { date: '2007-04-02', amount: 1500, kind: 'reduced', note: 'agreed 25,000' });
    const p = (await web.payments('06-07', 'RISHABH', 'Audit', 'PREM CHAND'))!;
    expect(p.sums).toEqual({ billed: 26500, received: 20000, reduced: 1500, due: 5000 });
    expect(p.payments.map((x) => x.date)).toEqual(['2007-04-02', '2007-05-10']);
    expect((await web.clients('06-07')).find((c) => c.name === 'RISHABH')).toMatchObject({ billed: 26500, due: 5000 });
    // Editing the bill keeps them; the next year's copy starts afresh.
    await web.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'Fee', amount: '26500' }]);
    expect((await web.payments('06-07', 'RISHABH', 'Audit', 'PREM CHAND'))!.payments).toHaveLength(2);
    await web.addNextYear();
    await web.copyClients('06-07', '07-08', ['RISHABH']);
    expect((await web.payments('07-08', 'RISHABH', 'Audit', 'PREM CHAND'))!.payments).toEqual([]);
    await web.removePayment('06-07', 'RISHABH', 'Audit', 'PREM CHAND', p.payments[0].id);
    expect((await web.payments('06-07', 'RISHABH', 'Audit', 'PREM CHAND'))!.sums.due).toBe(6500);
    await expect(web.addPayment('06-07', 'RISHABH', 'Audit', 'PREM CHAND', { date: '2007-05-10', amount: 0, kind: 'received' })).rejects.toThrow('more than 0');
    expect(everything(dir)).not.toContain('cheque');
  });

  it('lists every bill of a year with its state', async () => {
    await web.addPayment('06-07', 'RISHABH', 'Audit', 'PREM CHAND', { date: '2007-05-10', amount: 26500, kind: 'received' });
    await web.createBill('06-07', 'PREM', 'Tax', 'ITR');
    await web.writeBill('06-07', 'PREM', 'Tax', 'ITR', [{ desc: 'Return', amount: '3500' }]);
    await web.markPrinted('06-07', [{ client: 'PREM', folder: 'Tax', bill: 'ITR' }], '04.11.2026');
    const rows = await web.ledger('06-07');
    expect(rows.map((r) => [r.client, r.tab, r.bill, r.billed, r.due, r.lastPaid ?? '', r.printed ?? ''])).toEqual([
      ['PREM', 'Tax', 'ITR', 3500, 3500, '', '04.11.2026'],
      ['RISHABH', 'Audit', 'PREM CHAND', 26500, 0, '2007-05-10', ''],
    ]);
  });
});

describe('client details', () => {
  it('are optional, the same in every year, and follow a renamed client', async () => {
    expect(await web.clientDetails('06-07', 'PREM')).toEqual({});
    await web.saveClientDetails('06-07', 'PREM', { pan: 'abcde1234f', gstin: '', address: '12, Road\nJaipur', phone: ' 98290 ' });
    expect(await web.clientDetails('06-07', 'PREM')).toEqual({ pan: 'ABCDE1234F', address: '12, Road Jaipur', phone: '98290' });
    await web.addNextYear();
    await web.copyClients('06-07', '07-08', ['PREM']);
    await web.modifyClient('07-08', 'PREM', 'Prem Chand', '', false);
    expect((await web.clientDetails('07-08', 'PREM CHAND')).pan).toBe('ABCDE1234F');
    expect(everything(dir)).not.toContain('ABCDE1234F');
  });
});

describe('tabs', () => {
  it('renamed (with their drop-down list), reordered and hidden', async () => {
    const before = await web.dropdown('Audit', '06-07');
    await web.renameBillType('Audit', 'Tax Audit');
    expect((await web.billTypes()).map((t) => `${t.folder}:${t.tab}`)).toEqual(['Audit:Tax Audit', 'Vat:Vat', 'Tax:Tax', 'Others:Others']);
    expect(await web.dropdown('Tax Audit', '06-07')).toEqual(before);
    await expect(web.renameBillType('Vat', 'tax')).rejects.toThrow('already exists');
    await web.setBillTypeOrder(['Others', 'Audit', 'Tax', 'Vat']);
    await web.setBillTypeHidden('Vat', true);
    expect(await web.billTypes()).toEqual([
      { folder: 'Others', tab: 'Others' }, { folder: 'Audit', tab: 'Tax Audit' }, { folder: 'Tax', tab: 'Tax' }, { folder: 'Vat', tab: 'Vat', hidden: true },
    ]);
    // The desktop version gets the new titles.
    const out = empty();
    const r = await exportToDesktop(web, new NodeDir(out), 'puja');
    expect(r.report.ok).toBe(true);
  });
});

describe('quick changes one after another', () => {
  it('two changes started together both stay', async () => {
    await Promise.all([web.renameBillType('Vat', 'VAT Audit'), web.setBillTypeOrder(['Others', 'Audit', 'Vat', 'Tax']), web.setBillNo('06-07', 'PREM', '1'), web.setBillNo('06-07', 'RISHABH', '2')]);
    expect((await web.billTypes()).map((t) => t.tab)).toEqual(['Others', 'Audit', 'VAT Audit', 'Tax']);
    expect((await web.clients('06-07')).map((c) => c.billNo)).toEqual(['1', '2']);
  });
});

describe('bill numbers', () => {
  it('reads the usual forms and offers the next number', () => {
    expect(billNumbers('145')).toEqual([145]);
    expect(billNumbers('145-147')).toEqual([145, 146, 147]);
    expect(billNumbers('145, 150')).toEqual([145, 150]);
    expect(billNumbers('')).toEqual([]);
    expect(billNumbers('B-7')).toBe(null);
    expect(billNoFor(145, 3)).toBe('145-147');
    expect(nextBillNo(['145-147', '12', 'B-7'], ['900'])).toEqual({ next: 148, from: 'this year' });
    expect(nextBillNo(['', 'B-7'], ['900'])).toEqual({ next: 901, from: 'the year before' });
    expect(nextBillNo([], [])).toEqual({ next: 1, from: 'none' });
    expect(billNoClashes([{ name: 'A', billNo: '10-12' }, { name: 'B', billNo: '12' }, { name: 'C', billNo: '13' }])).toEqual(new Map([['A', ['B']], ['B', ['A']]]));
  });

  it('suggests for a year', async () => {
    await web.setBillNo('06-07', 'PREM', '40-41');
    expect(await web.suggestBillNo('06-07')).toEqual({ next: 42, from: 'this year' });
    await web.addNextYear();
    expect(await web.suggestBillNo('07-08')).toEqual({ next: 42, from: 'the year before' });
  });
});

describe('searching every year', () => {
  it('finds clients, bills and rows', async () => {
    await web.addNextYear();
    await web.copyClients('06-07', '07-08', ['RISHABH']);
    const { hits } = await searchAll(web, 'tax audit');
    expect(hits.map((h) => `${h.year} ${h.client} ${h.what} ${h.text}`)).toEqual([
      '07-08 RISHABH row Fee for Tax Audit for the Assessment Year 07-08 — 0',
      '06-07 RISHABH row Fee for Tax Audit for the Assessment Year 06-07 — 25000',
    ]);
    expect((await searchAll(web, 'prem')).hits.map((h) => `${h.year} ${h.what} ${h.text}`)).toEqual([
      '07-08 bill PREM CHAND', '06-07 client PREM', '06-07 bill PREM CHAND',
    ]);
    expect((await searchAll(web, 'x')).hits).toEqual([]);
  });
});

describe('backups compare what only the web format has', () => {
  it('payments and details', async () => {
    const b = empty();
    await makeBackup(web, new NodeDir(b));
    await web.addPayment('06-07', 'RISHABH', 'Audit', 'PREM CHAND', { date: '2007-05-10', amount: 100, kind: 'received' });
    await web.saveClientDetails('06-07', 'PREM', { phone: '1' });
    const r = await compare(webSide(openBackup(web, new NodeDir(b))), webSide(web), { ignoreAutoBackup: true });
    expect(r.differences.map((d) => d.where)).toEqual(['06-07 › PREM › Client details', '06-07 › RISHABH › Payments']);
  });
});
