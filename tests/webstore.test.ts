// The web format does everything the desktop layout does (tests/workspace.test.ts), through the same calls.
import { beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeDir } from './nodefs';
import { WebBooks, createStore, isWebStore } from '../src/core/webstore';
import { migrateDesktop } from '../src/core/migrate';

const SAMPLE = join(import.meta.dirname, 'fixtures', 'java-sample');

async function sampleStore(): Promise<{ dir: string; web: WebBooks }> {
  const src = mkdtempSync(join(tmpdir(), 'usw-src-'));
  cpSync(SAMPLE, src, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'usw-web-'));
  await migrateDesktop({ program: new NodeDir(src), data: new NodeDir(join(src, 'data')) }, new NodeDir(dir));
  return { dir, web: new WebBooks(new NodeDir(dir)) };
}

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('web format', () => {
  let dir: string;
  let web: WebBooks;
  beforeEach(async () => {
    ({ dir, web } = await sampleStore());
  });

  it('reads what was migrated', async () => {
    expect(await isWebStore(new NodeDir(dir))).toBe(true);
    expect(await web.checkPassword('puja')).toBe(true);
    expect(await web.checkPassword('Puja')).toBe(false);
    expect(await web.years()).toEqual(['06-07']);
    expect(await web.clients('06-07')).toEqual([
      { name: 'PREM', serial: '1', billNo: '' },
      { name: 'RISHABH', serial: '2', billNo: '' },
    ]);
    expect((await web.billTypes()).map((t) => t.tab)).toEqual(['Audit', 'Vat', 'Tax', 'Others']);
    expect(await web.bills('06-07', 'RISHABH', 'Audit')).toEqual(['PREM CHAND']);
    expect(await web.readBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual([{ desc: 'pooja', amount: '20' }]);
    // Plain, readable JSON; the password only as a hash.
    const settings = json(join(dir, 'utility-soft.json'));
    expect(settings.format).toBe('utility-soft');
    expect(JSON.stringify(settings)).not.toContain('puja');
  });

  it('adds clients with correct serial numbers', async () => {
    await web.addClient('06-07', 'mohan', false);
    await web.addClient('06-07', 'Aaron', false);
    await web.addClient('06-07', 'PRAKASH', true);
    expect((await web.clients('06-07')).map((c) => `${c.serial} ${c.name}`)).toEqual(['1 AARON', '2 MOHAN', '2A PRAKASH', '3 PREM', '4 RISHABH']);
    await expect(web.addClient('06-07', 'Mohan', false)).rejects.toThrow('already exists');
    await expect(web.addClient('06-07', 'a/b', false)).rejects.toThrow('cannot contain');
  });

  it('deletes several clients and renumbers correctly', async () => {
    for (const n of ['A', 'B', 'C', 'D']) await web.addClient('06-07', n, false);
    await web.deleteClients('06-07', ['B', 'D']);
    expect((await web.clients('06-07')).map((c) => `${c.name}=${c.serial}`)).toEqual(['A=1', 'C=2', 'PREM=3', 'RISHABH=4']);
  });

  it('renames, merges and sets the bill no.', async () => {
    await web.setBillNo('06-07', 'PREM', '12-14');
    await web.modifyClient('06-07', 'RISHABH', 'amit', 'B-7', false);
    expect((await web.clients('06-07')).map((c) => `${c.name}=${c.serial}=${c.billNo}`)).toEqual(['AMIT=1=B-7', 'PREM=2=12-14']);
    expect(await web.readBill('06-07', 'AMIT', 'Audit', 'PREM CHAND')).toEqual([{ desc: 'pooja', amount: '20' }]);
    await web.modifyClient('06-07', 'AMIT', 'PREM', 'X', false);
    expect((await web.clients('06-07')).map((c) => `${c.name}=${c.serial}=${c.billNo}`)).toEqual(['PREM=1=X']);
    expect(await web.bills('06-07', 'PREM', 'Audit')).toEqual(['PREM CHAND']);
    // Case-only rename.
    await web.modifyClient('06-07', 'PREM', 'Prem', 'X', false);
    expect(await web.clientNames('06-07')).toEqual(['PREM']);
    expect(readdirSync(join(dir, 'years/06-07'))).toHaveLength(1);
  });

  it('creates, edits, renames and deletes bills', async () => {
    const name = await web.createBill('06-07', 'PREM', 'Tax', 'shyam');
    expect(name).toBe('SHYAM');
    await web.writeBill('06-07', 'PREM', 'Tax', 'SHYAM', [
      { desc: 'Fee for IT Return for the Assessment Year 06-07', amount: '1500' },
      { desc: 'New Name', amount: '' },
      { desc: 'Expenses', amount: '200' },
    ]);
    expect(await web.readBillLines('06-07', 'PREM', 'Tax', 'SHYAM')).toEqual(['Fee for IT Return for the Assessment Year ##,1500', 'New Name,New', 'Expenses,200']);
    const rec = readdirSync(join(dir, 'years/06-07')).map((f) => json(join(dir, 'years/06-07', f))).find((r) => r.name === 'PREM');
    expect(rec.bills[0]).toEqual({
      type: 'Tax',
      name: 'SHYAM',
      groups: [{ rows: [{ text: 'Fee for IT Return for the Assessment Year ##', amount: '1500' }] }, { rows: [{ text: 'Expenses', amount: '200' }] }],
    });
    await web.renameBill('06-07', 'PREM', 'Tax', 'SHYAM', 'ram');
    expect(await web.bills('06-07', 'PREM', 'Tax')).toEqual(['RAM']);
    await expect(web.createBill('06-07', 'PREM', 'Tax', 'Ram')).rejects.toThrow('already exists');
    await web.deleteBill('06-07', 'PREM', 'Tax', 'RAM');
    expect(await web.bills('06-07', 'PREM', 'Tax')).toEqual([]);
  });

  it('copies clients to the next year with history', async () => {
    await web.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [
      { desc: 'Fee for Tax Audit for the Assessment Year 06-07', amount: '15000' },
      { desc: 'Expenses', amount: '100' },
    ]);
    await web.setBillNo('06-07', 'RISHABH', '55');
    expect(await web.addNextYear()).toBe('07-08');
    expect((await web.planCopy('06-07', '07-08')).fresh.map((c) => c.name)).toEqual(['PREM', 'RISHABH']);
    await web.copyClients('06-07', '07-08', ['RISHABH']);
    expect(await web.clients('07-08')).toEqual([{ name: 'RISHABH', serial: '2', billNo: '55' }]);
    const rows = await web.readBill('07-08', 'RISHABH', 'Audit', 'PREM CHAND');
    expect(rows).toEqual([
      { desc: 'Fee for Tax Audit for the Assessment Year 07-08', amount: '0' },
      { desc: 'Expenses', amount: '0' },
    ]);
    expect((await web.billHistory('07-08', 'RISHABH', 'Audit', 'PREM CHAND', rows))[0]).toEqual({ year: '06-07', values: ['15000', '100'], counted: [15000, 100], total: 15100 });
    await web.writeBill('06-07', 'PREM', 'Vat', 'GOPAL', [{ desc: 'VAT return', amount: '700' }]);
    await web.copyClients('06-07', '07-08', ['PREM']);
    expect(await web.readBill('07-08', 'PREM', 'Vat', 'GOPAL')).toEqual([{ desc: 'VAT return', amount: '0' }]);
    expect((await web.planCopy('06-07', '07-08')).collided.map((c) => c.name)).toEqual(['PREM', 'RISHABH']);
    // Copying again replaces the client (same id, one file).
    await web.copyClients('06-07', '07-08', ['PREM']);
    expect(readdirSync(join(dir, 'years/07-08'))).toHaveLength(2);
    expect(await web.copyClientToNextYear('06-07', 'PREM')).toBe('07-08');
    expect(await web.copyClientToNextYear('07-08', 'PREM')).toBe(null);
  });

  it('adding a client brings bills and Bill No. from the previous years', async () => {
    await web.addNextYear();
    await web.writeBill('06-07', 'PREM', 'Others', 'X', [{ desc: 'Misc', amount: '5' }]);
    await web.setBillNo('06-07', 'PREM', '7');
    await web.addClient('07-08', 'prem', false);
    expect(await web.readBill('07-08', 'PREM', 'Others', 'X')).toEqual([{ desc: 'Misc', amount: '0' }]);
    expect((await web.clients('07-08'))[0]).toEqual({ name: 'PREM', serial: '1', billNo: '7' });
  });

  it('keeps earlier years linked to a client after it is renamed', async () => {
    await web.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'Fee', amount: '900' }]);
    await web.addNextYear();
    await web.copyClients('06-07', '07-08', ['RISHABH']);
    await web.modifyClient('07-08', 'RISHABH', 'Rishabh Jain', '', false);
    const rows = await web.readBill('07-08', 'RISHABH JAIN', 'Audit', 'PREM CHAND');
    expect((await web.billHistory('07-08', 'RISHABH JAIN', 'Audit', 'PREM CHAND', rows))[0].values).toEqual(['900']);
    // A new bill of the renamed client also starts from its earlier rows.
    await web.writeBill('06-07', 'RISHABH', 'Tax', 'ITR', [{ desc: 'Return', amount: '300' }]);
    await web.createBill('07-08', 'RISHABH JAIN', 'Tax', 'itr');
    expect(await web.readBill('07-08', 'RISHABH JAIN', 'Tax', 'ITR')).toEqual([{ desc: 'Return', amount: '0' }]);
  });

  it('adds a bill type and keeps settings', async () => {
    await web.addBillType('GST');
    expect((await web.billTypes()).map((t) => t.tab)).toEqual(['Audit', 'Vat', 'Tax', 'Others', 'GST']);
    await expect(web.addBillType('gst')).rejects.toThrow('already exists');
    await expect(web.addBillType('a(b')).rejects.toThrow('cannot contain');
    await web.saveLetterhead({ firmName: ['For X & Co. 100%', 'CA'], firmAddress: ['Road 1'], indexTitles: ['Bills ##', '', ''] });
    expect(await web.letterhead()).toEqual({ firmName: ['For X & Co. 100', 'CA'], firmAddress: ['Road 1'], indexTitles: ['Bills ##', '', ''] });
    await web.saveDropdowns(await web.billTypes(), new Map([['Vat', ['VAT return for ##', '', 'a^b']]]));
    expect(await web.dropdown('Vat', '06-07')).toEqual(['VAT return for 06-07', 'a b']);
    expect(await web.dropdown('Audit', '06-07')).toEqual(['Income tax for the Assessment Year 06-07']);
    await web.setPassword('new pass');
    expect(await web.checkPassword('new pass')).toBe(true);
    await web.setBackupPath('D:\\Backups');
    expect(await web.backupPath()).toBe('D:\\Backups');
  });

  it('marks open clients, one file each', async () => {
    expect(await web.isLocked('06-07', 'PREM')).toBe(false);
    await web.lock('06-07', 'PREM');
    await web.lock('06-07', 'RISHABH');
    expect(await web.isLocked('06-07', 'prem')).toBe(true);
    await web.unlock('06-07', 'PREM');
    expect(await web.isLocked('06-07', 'PREM')).toBe(false);
    expect(await web.isLocked('06-07', 'RISHABH')).toBe(true);
  });

  it('backs up into a folder that opens like the original', async () => {
    await web.lock('06-07', 'PREM');
    const dest = mkdtempSync(join(tmpdir(), 'usw-bak-'));
    await web.backupTo(new NodeDir(dest));
    expect(readdirSync(dest).sort()).toEqual(['utility-soft.json', 'years']);
    const copy = new WebBooks(new NodeDir(dest));
    expect(await copy.checkPassword('puja')).toBe(true);
    expect(await copy.readBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual([{ desc: 'pooja', amount: '20' }]);
    expect(await copy.isLocked('06-07', 'PREM')).toBe(false);
  });

  it('starts a new store with the default tabs and lists', async () => {
    const d = mkdtempSync(join(tmpdir(), 'usw-new-'));
    const fresh = await createStore(new NodeDir(d), 'secret');
    expect(await fresh.checkPassword('secret')).toBe(true);
    expect(await fresh.letterhead()).toBe(null);
    expect((await fresh.billTypes()).map((t) => t.tab)).toEqual(['Audit', 'Vat', 'Tax', 'Others']);
    expect(await fresh.dropdown('Vat', '26-27')).toEqual(['Fee for VAT Audit for the Assessment Year 26-27', 'Expenses']);
    expect(await fresh.years()).toEqual([]);
    await fresh.addYear('26-27');
    expect(existsSync(join(d, 'years/26-27'))).toBe(true);
    await fresh.addClient('26-27', 'Asha', false);
    expect(await fresh.clients('26-27')).toEqual([{ name: 'ASHA', serial: '1', billNo: '' }]);
  });

  it('says clearly when a file is damaged or from a newer version', async () => {
    const { writeFileSync } = await import('node:fs');
    const f = readdirSync(join(dir, 'years/06-07'))[0];
    writeFileSync(join(dir, 'years/06-07', f), '{ broken');
    await expect(web.clients('06-07')).rejects.toThrow('damaged');
    const s = json(join(dir, 'utility-soft.json'));
    writeFileSync(join(dir, 'utility-soft.json'), JSON.stringify({ ...s, version: 99 }));
    await expect(web.settings()).rejects.toThrow('newer');
  });
});
