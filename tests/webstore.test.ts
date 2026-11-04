// The web format: everything the desktop version does, plus encryption, safe
// changes of several files, earlier versions, the bin, conflicts and open clients.
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDir } from './nodefs';
import { FAST, copyOf, desktopOf, empty, everything } from './testdata';
import { BillConflict, WebBooks, createStore, isWebStore } from '../src/core/webstore';
import { migrateDesktop } from '../src/core/migrate';
import { FsDir } from '../src/core/fs';

async function sampleStore(): Promise<{ dir: string; web: WebBooks }> {
  const dir = empty();
  const r = await migrateDesktop(desktopOf(copyOf('java-sample')), new NodeDir(dir), FAST);
  return { dir, web: r.books };
}

const MIN = 60_000;

/** A folder that stops working (as if the computer was switched off) after `writes` more writes. */
class Failing implements FsDir {
  constructor(
    private inner: FsDir,
    private budget: { writes: number },
  ) {}
  get name() {
    return this.inner.name;
  }
  list() {
    return this.inner.list();
  }
  async dir(name: string, create?: boolean): Promise<FsDir> {
    return new Failing(await this.inner.dir(name, create), this.budget);
  }
  read(name: string) {
    return this.inner.read(name);
  }
  stat(name: string) {
    return this.inner.stat!(name);
  }
  async write(name: string, data: Uint8Array) {
    if (this.budget.writes-- <= 0) throw new Error('power cut');
    await this.inner.write(name, data);
  }
  async remove(name: string) {
    if (this.budget.writes-- <= 0) throw new Error('power cut');
    await this.inner.remove(name);
  }
}

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
    expect(await web.clients('06-07')).toMatchObject([
      { name: 'PREM', serial: '1', billNo: '' },
      { name: 'RISHABH', serial: '2', billNo: '' },
    ]);
    expect((await web.billTypes()).map((t) => t.tab)).toEqual(['Audit', 'Vat', 'Tax', 'Others']);
    expect(await web.bills('06-07', 'RISHABH', 'Audit')).toEqual(['PREM CHAND']);
    expect(await web.readBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual([{ desc: 'pooja', amount: '20' }]);
    const manifest = JSON.parse(readFileSync(join(dir, 'utility-soft.json'), 'utf8'));
    expect(manifest.format).toBe('utility-soft');
    expect(Object.keys(manifest.keys)).toEqual(['password', 'recovery']);
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
    const rec = (await web.records('06-07')).find((r) => r.name === 'PREM')!;
    expect(rec.bills[0]).toMatchObject({
      type: 'Tax',
      name: 'SHYAM',
      groups: [{ rows: [{ text: 'Fee for IT Return for the Assessment Year ##', amount: 1500 }] }, { rows: [{ text: 'Expenses', amount: 200 }] }],
    });
    // Bills keep their id through a rename (earlier years stay linked).
    const id = rec.bills[0].id;
    await web.renameBill('06-07', 'PREM', 'Tax', 'SHYAM', 'ram');
    expect(await web.bills('06-07', 'PREM', 'Tax')).toEqual(['RAM']);
    expect((await web.records('06-07')).find((r) => r.name === 'PREM')!.bills[0].id).toBe(id);
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
    expect(await web.clients('07-08')).toMatchObject([{ name: 'RISHABH', serial: '2', billNo: '55' }]);
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
    expect((await web.clients('07-08'))[0]).toMatchObject({ name: 'PREM', serial: '1', billNo: '7' });
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

  it('stores amounts as whole numbers, without leading zeros or plus', async () => {
    await web.writeBill('06-07', 'PREM', 'Tax', 'X', [
      { desc: 'a', amount: '007' },
      { desc: 'b', amount: '+5' },
      { desc: 'c', amount: '' },
      { desc: 'd', amount: '-3' },
    ]);
    expect(await web.readBillLines('06-07', 'PREM', 'Tax', 'X')).toEqual(['a,7', 'b,5', 'c,', 'd,-3']);
    const rows = (await web.records('06-07')).find((r) => r.name === 'PREM')!.bills[0].groups[0].rows;
    expect(rows.map((r) => r.amount)).toEqual([7, 5, null, -3]);
  });

  it('starts a new store with the default tabs and lists, and a recovery code', async () => {
    const d = empty();
    const { books: fresh, recoveryCode } = await createStore(new NodeDir(d), 'secret', FAST);
    expect(recoveryCode).toMatch(/^([0-9A-Z]{4}-){5}[0-9A-Z]{4}$/);
    expect(await WebBooks.unlock(new NodeDir(d), 'secret')).not.toBe(null);
    expect(await WebBooks.unlockWithRecovery(new NodeDir(d), recoveryCode)).not.toBe(null);
    expect(await fresh.letterhead()).toBe(null);
    expect((await fresh.billTypes()).map((t) => t.tab)).toEqual(['Audit', 'Vat', 'Tax', 'Others']);
    expect(await fresh.dropdown('Vat', '26-27')).toEqual(['Fee for VAT Audit for the Assessment Year 26-27', 'Expenses']);
    expect(await fresh.years()).toEqual([]);
    await fresh.addYear('26-27');
    expect(existsSync(join(d, 'years/26-27'))).toBe(true);
    await fresh.addClient('26-27', 'Asha', false);
    expect(await fresh.clients('26-27')).toMatchObject([{ name: 'ASHA', serial: '1', billNo: '' }]);
    expect(everything(d)).not.toContain('ASHA');
    expect(everything(d)).not.toContain('Expenses');
  });

  it('refuses data from a newer version', async () => {
    const m = JSON.parse(readFileSync(join(dir, 'utility-soft.json'), 'utf8'));
    writeFileSync(join(dir, 'utility-soft.json'), JSON.stringify({ ...m, version: 99 }));
    await expect(WebBooks.unlock(new NodeDir(dir), 'puja')).rejects.toThrow('newer');
  });
});

describe('safety', () => {
  let dir: string;
  let web: WebBooks;
  let now: number;
  beforeEach(async () => {
    ({ dir, web } = await sampleStore());
    now = Date.parse('2026-11-04T10:00:00Z');
    web = web.as({ now: () => now });
    for (const n of ['A', 'B', 'C', 'D']) await web.addClient('06-07', n, false);
  });

  it('finishes a change of several files that was cut off half way', async () => {
    // Deleting B renumbers C, D, PREM and RISHABH: power cut after the journal and two files.
    const budget = { writes: 3 };
    const cut = new WebBooks(new (await import('../src/core/vault')).Vault(new Failing(new NodeDir(dir), budget), web.vault.key), { now: () => now });
    await expect(cut.deleteClients('06-07', ['B'])).rejects.toThrow('power cut');
    const half = (await web.clients('06-07')).map((c) => `${c.name}=${c.serial}`);
    expect(half).not.toEqual(['A=1', 'C=2', 'D=3', 'PREM=4', 'RISHABH=5']);
    // Opening it a few minutes later finishes it.
    now += 2 * MIN;
    expect(await web.open()).toEqual({ recovered: expect.any(Number), skipped: 0 });
    expect((await web.clients('06-07')).map((c) => `${c.name}=${c.serial}`)).toEqual(['A=1', 'C=2', 'D=3', 'PREM=4', 'RISHABH=5']);
    expect(readdirSync(join(dir, 'journal'))).toEqual([]);
    expect(await web.logText()).toContain('Finished an interrupted change (delete B)');
  });

  it('does not undo what was changed after the interruption', async () => {
    const cut = new WebBooks(new (await import('../src/core/vault')).Vault(new Failing(new NodeDir(dir), { writes: 2 }), web.vault.key), { now: () => now });
    await expect(cut.deleteClients('06-07', ['B'])).rejects.toThrow('power cut');
    await web.setBillNo('06-07', 'RISHABH', '99');
    now += 2 * MIN;
    const r = await web.open();
    expect(r.skipped).toBe(1);
    expect((await web.clients('06-07')).find((c) => c.name === 'RISHABH')!.billNo).toBe('99');
  });

  it('keeps earlier versions of a bill', async () => {
    const save = (amount: string) => web.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'pooja', amount }]);
    await save('21');
    now += 1 * MIN;
    await save('22'); // Too soon for another version.
    now += 11 * MIN;
    await save('23');
    const v = await web.billVersions('06-07', 'RISHABH', 'Audit', 'PREM CHAND');
    expect(v.map((x) => x.lines)).toEqual([['pooja,22'], ['pooja,20']]);
  });

  it('keeps deleted clients and bills in the bin, and puts them back', async () => {
    await web.writeBill('06-07', 'C', 'Tax', 'ITR', [{ desc: 'Return', amount: '300' }]);
    await web.deleteClients('06-07', ['C']);
    expect((await web.clients('06-07')).map((c) => `${c.name}=${c.serial}`)).toEqual(['A=1', 'B=2', 'D=3', 'PREM=4', 'RISHABH=5']);
    await web.deleteBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND');
    const bin = await web.bin();
    expect(bin.map((e) => (e.kind === 'client' ? `client ${e.record.name}` : `bill ${e.bill.name}`))).toEqual(['bill PREM CHAND', 'client C']);
    expect(await web.restore(bin[1])).toBe('C (06-07) is back, S.No. 3.');
    expect((await web.clients('06-07')).map((c) => `${c.name}=${c.serial}`)).toEqual(['A=1', 'B=2', 'C=3', 'D=4', 'PREM=5', 'RISHABH=6']);
    expect(await web.readBillLines('06-07', 'C', 'Tax', 'ITR')).toEqual(['Return,300']);
    await web.restore(bin[0]);
    expect(await web.readBillLines('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['pooja,20']);
    expect(await web.bin()).toEqual([]);
    // Emptied after 30 days.
    await web.deleteClients('06-07', ['A']);
    now += 31 * 24 * 60 * MIN;
    await web.open();
    expect(await web.bin()).toEqual([]);
  });

  it('refuses to save over a bill changed on another computer', async () => {
    const read = await web.readBillLines('06-07', 'RISHABH', 'Audit', 'PREM CHAND');
    const other = web.as({ computer: { id: 'other', name: 'Office PC' } });
    await other.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'pooja', amount: '99' }]);
    const e = await web.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'pooja', amount: '25' }], read).catch((x) => x);
    expect(e).toBeInstanceOf(BillConflict);
    expect((e as BillConflict).current).toEqual(['pooja,99']);
    // Keeping mine: saved over the version now known.
    const saved = await web.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'pooja', amount: '25' }], ['pooja,99']);
    expect(saved).toEqual(['pooja,25']);
  });

  it('says which computer has a client open, until it stops saying so', async () => {
    const office = web.as({ computer: { id: 'pc1', name: 'Office PC' } });
    await office.lock('06-07', 'PREM');
    expect(await web.lockInfo('06-07', 'PREM')).toEqual({ computer: { id: 'pc1', name: 'Office PC' }, since: now, mine: false });
    expect(await office.lockInfo('06-07', 'prem')).toMatchObject({ mine: true });
    // Another computer cannot release it; it lapses when the office computer goes quiet.
    await web.unlock('06-07', 'PREM');
    expect(await web.isLocked('06-07', 'PREM')).toBe(true);
    now += 4 * MIN;
    await office.heartbeat('06-07', 'PREM');
    now += 4 * MIN;
    expect(await web.isLocked('06-07', 'PREM')).toBe(true);
    now += 2 * MIN;
    expect(await web.isLocked('06-07', 'PREM')).toBe(false);
    await office.unlock('06-07', 'PREM');
    expect(readdirSync(join(dir, 'open'))).toEqual([]);
    expect(everything(dir)).not.toContain('Office PC');
  });

  it('sets aside a damaged client file and can put back its last good version', async () => {
    await web.setBillNo('06-07', 'PREM', '5');
    now += 11 * MIN;
    await web.setBillNo('06-07', 'PREM', '6');
    const rec = (await web.records('06-07')).find((r) => r.name === 'PREM')!;
    const file = join(dir, 'years/06-07', `${rec.id}.dat`);
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(file, bytes);
    const fresh = web.as({});
    expect((await fresh.clients('06-07')).map((c) => c.name)).toEqual(['A', 'B', 'C', 'D', 'RISHABH']);
    expect(fresh.problems()).toEqual([{ path: `years/06-07/${rec.id}.dat`, year: '06-07', name: 'PREM', restorable: true }]);
    expect(await fresh.restoreDamaged(fresh.problems()[0])).toBe('PREM');
    expect((await fresh.clients('06-07')).find((c) => c.name === 'PREM')!.billNo).toBe('5');
    expect(fresh.problems()).toEqual([]);
  });

  it('sees changes made by another computer', async () => {
    expect((await web.clients('06-07')).length).toBe(6);
    const other = web.as({ computer: { id: 'other', name: '' } });
    await other.setBillNo('06-07', 'A', '42');
    expect((await web.clients('06-07')).find((c) => c.name === 'A')!.billNo).toBe('42');
  });

  it('keeps an encrypted log of problems', async () => {
    await web.log('Something went wrong with PREM');
    expect(await web.logText()).toContain('Something went wrong with PREM');
    expect(everything(dir)).not.toContain('Something went wrong');
  });
});
