import { beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeDir } from './nodefs';
import { Workspace } from '../src/core/workspace';
import { readPassword, writeLetterhead, readImpinfo, letterheadFromImpinfo, writeDropdowns, readDropdownLines, writeBillTypes } from '../src/core/config';
import { decodeCipherLines, decodeCipherValue } from '../src/core/codec';

const SAMPLE = join(import.meta.dirname, 'fixtures', 'java-sample');

function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usw-'));
  cpSync(SAMPLE, dir, { recursive: true });
  return dir;
}

const raw = (p: string) => decodeCipherLines(new Uint8Array(readFileSync(p)));
const val = (p: string) => decodeCipherValue(new Uint8Array(readFileSync(p)));

describe('workspace on the Java sample data', () => {
  let root: string;
  let ws: Workspace;
  beforeEach(async () => {
    root = freshCopy();
    const program = new NodeDir(root);
    ws = new Workspace(program, await program.dir('data'));
  });

  it('reads years, clients and bills written by Java', async () => {
    expect(await readPassword(ws.program)).toBe('puja');
    expect(await ws.years()).toEqual(['06-07']);
    expect(await ws.clients('06-07')).toEqual([
      { name: 'PREM', serial: '1', billNo: '' },
      { name: 'RISHABH', serial: '2', billNo: '' },
    ]);
    expect((await ws.billTypes()).map((t) => t.tab)).toEqual(['Audit', 'Vat', 'Tax', 'Others']);
    expect(await ws.bills('06-07', 'RISHABH', 'Audit')).toEqual(['PREM CHAND']);
    expect(await ws.readBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual([{ desc: 'pooja', amount: '20' }]);
  });

  it('adds clients with correct serial numbers and folders', async () => {
    await ws.addClient('06-07', 'mohan', false);
    await ws.addClient('06-07', 'Aaron', false);
    await ws.addClient('06-07', 'PRAKASH', true);
    expect((await ws.clients('06-07')).map((c) => `${c.serial} ${c.name}`)).toEqual([
      '1 AARON', '2 MOHAN', '2A PRAKASH', '3 PREM', '4 RISHABH',
    ]);
    const d = join(root, 'data', 'bills', '06-07', 'MOHAN');
    expect(readdirSync(d).sort()).toEqual(['Audit', 'Others', 'Tax', 'Vat', 'billfromto.txt', 'serialno.txt']);
    await expect(ws.addClient('06-07', 'Mohan', false)).rejects.toThrow('already exists');
    await expect(ws.addClient('06-07', 'a/b', false)).rejects.toThrow('cannot contain');
  });

  it('deletes several clients and renumbers correctly', async () => {
    for (const n of ['A', 'B', 'C', 'D']) await ws.addClient('06-07', n, false);
    // A1 B2 C3 D4 PREM5 RISHABH6
    await ws.deleteClients('06-07', ['B', 'D']);
    expect((await ws.clients('06-07')).map((c) => `${c.name}=${c.serial}`)).toEqual(['A=1', 'C=2', 'PREM=3', 'RISHABH=4']);
  });

  it('renames, merges and sets the bill no.', async () => {
    await ws.setBillNo('06-07', 'PREM', '12-14');
    expect(val(join(root, 'data/bills/06-07/PREM/billfromto.txt'))).toBe('12-14');
    // RISHABH (2) renamed to AMIT -> first position.
    await ws.modifyClient('06-07', 'RISHABH', 'amit', 'B-7', false);
    expect((await ws.clients('06-07')).map((c) => `${c.name}=${c.serial}=${c.billNo}`)).toEqual(['AMIT=1=B-7', 'PREM=2=12-14']);
    expect(await ws.readBill('06-07', 'AMIT', 'Audit', 'PREM CHAND')).toEqual([{ desc: 'pooja', amount: '20' }]);
    expect(existsSync(join(root, 'data/bills/06-07/RISHABH'))).toBe(false);
    // Merge AMIT into PREM.
    await ws.modifyClient('06-07', 'AMIT', 'PREM', 'X', false);
    expect((await ws.clients('06-07')).map((c) => `${c.name}=${c.serial}=${c.billNo}`)).toEqual(['PREM=1=X']);
    expect(await ws.bills('06-07', 'PREM', 'Audit')).toEqual(['PREM CHAND']);
  });

  it('creates, edits, renames and deletes bills', async () => {
    const name = await ws.createBill('06-07', 'PREM', 'Tax', 'shyam');
    expect(name).toBe('SHYAM');
    await ws.writeBill('06-07', 'PREM', 'Tax', 'SHYAM', [
      { desc: 'Fee for IT Return for the Assessment Year 06-07', amount: '1500' },
      { desc: 'New Name', amount: '' },
      { desc: 'Expenses', amount: '200' },
    ]);
    expect(raw(join(root, 'data/bills/06-07/PREM/Tax/SHYAM.txt'))).toEqual([
      'Fee for IT Return for the Assessment Year ##,1500', 'New Name,New', 'Expenses,200',
    ]);
    await ws.renameBill('06-07', 'PREM', 'Tax', 'SHYAM', 'ram');
    expect(await ws.bills('06-07', 'PREM', 'Tax')).toEqual(['RAM']);
    await expect(ws.createBill('06-07', 'PREM', 'Tax', 'Ram')).rejects.toThrow('already exists');
    await ws.deleteBill('06-07', 'PREM', 'Tax', 'RAM');
    expect(await ws.bills('06-07', 'PREM', 'Tax')).toEqual([]);
  });

  it('copies clients to the next year with history', async () => {
    await ws.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [
      { desc: 'Fee for Tax Audit for the Assessment Year 06-07', amount: '15000' },
      { desc: 'Expenses', amount: '100' },
    ]);
    await ws.setBillNo('06-07', 'RISHABH', '55');
    const next = await ws.addNextYear();
    expect(next).toBe('07-08');
    const plan = await ws.planCopy('06-07', '07-08');
    expect(plan.fresh.map((c) => c.name)).toEqual(['PREM', 'RISHABH']);
    await ws.copyClients('06-07', '07-08', ['RISHABH']);
    expect(await ws.clients('07-08')).toEqual([{ name: 'RISHABH', serial: '2', billNo: '55' }]);
    expect(await ws.readBill('07-08', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual([
      { desc: 'Fee for Tax Audit for the Assessment Year 07-08', amount: '0' },
      { desc: 'Expenses', amount: '0' },
    ]);
    const hist = await ws.billHistory('07-08', 'RISHABH', 'Audit', 'PREM CHAND', await ws.readBill('07-08', 'RISHABH', 'Audit', 'PREM CHAND'));
    expect(hist[0]).toEqual({ year: '06-07', values: ['15000', '100'], total: 15100 });
    // New bill in 07-08 picks up rows from 06-07.
    await ws.writeBill('06-07', 'PREM', 'Vat', 'GOPAL', [{ desc: 'VAT return', amount: '700' }]);
    await ws.copyClients('06-07', '07-08', ['PREM']);
    expect(await ws.readBill('07-08', 'PREM', 'Vat', 'GOPAL')).toEqual([{ desc: 'VAT return', amount: '0' }]);
    const plan2 = await ws.planCopy('06-07', '07-08');
    expect(plan2.collided.map((c) => c.name)).toEqual(['PREM', 'RISHABH']);
  });

  it('adding a client brings bills from the previous years', async () => {
    await ws.addNextYear();
    await ws.writeBill('06-07', 'PREM', 'Others', 'X', [{ desc: 'Misc', amount: '5' }]);
    await ws.addClient('07-08', 'prem', false);
    expect(await ws.readBill('07-08', 'PREM', 'Others', 'X')).toEqual([{ desc: 'Misc', amount: '0' }]);
    expect((await ws.clients('07-08'))[0].serial).toBe('1');
  });

  it('keeps every year of a bill openable by the Java program', async () => {
    await ws.addNextYear();
    await ws.copyClients('06-07', '07-08', ['RISHABH']);
    // Last year gets a heading row without an amount, after next year already has it.
    await ws.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'pooja', amount: '' }]);
    expect(raw(join(root, 'data/bills/07-08/RISHABH/Audit/PREM CHAND.txt'))).toEqual(['pooja ,0']);
    expect(await ws.readBill('07-08', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual([{ desc: 'pooja', amount: '0' }]);
    // Saving 07-08 keeps the padding; giving 06-07 an amount again lets it go.
    await ws.writeBill('07-08', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'pooja', amount: '5' }]);
    expect(raw(join(root, 'data/bills/07-08/RISHABH/Audit/PREM CHAND.txt'))).toEqual(['pooja ,5']);
    await ws.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'pooja', amount: '3' }]);
    expect(raw(join(root, 'data/bills/07-08/RISHABH/Audit/PREM CHAND.txt'))).toEqual(['pooja,5']);
  });

  it('finds and fixes bills the Java program could not open', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { encodeCipherLines } = await import('../src/core/codec');
    const d = join(root, 'data/bills/07-08/RISHABH/Audit');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(root, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt'), encodeCipherLines(['pooja,']));
    writeFileSync(join(d, 'PREM CHAND.txt'), encodeCipherLines(['pooja,0', 'Fee,10']));
    expect(await ws.protectAll()).toEqual({ checked: 2, fixed: 1 });
    expect(raw(join(d, 'PREM CHAND.txt'))).toEqual(['pooja ,0', 'Fee,10']);
    expect(await ws.protectAll()).toEqual({ checked: 2, fixed: 0 });
  });

  it('adds a bill type everywhere', async () => {
    await ws.addBillType('GST');
    expect((await ws.billTypes()).map((t) => t.tab)).toEqual(['Audit', 'Vat', 'Tax', 'Others', 'GST']);
    expect(existsSync(join(root, 'data/bills/06-07/PREM/GST'))).toBe(true);
    await expect(ws.addBillType('gst')).rejects.toThrow('already exists');
  });

  it('locks clients in activelocation.txt', async () => {
    expect(await ws.isLocked('06-07', 'PREM')).toBe(false);
    await ws.lock('06-07', 'PREM');
    expect(readFileSync(join(root, 'data/activelocation.txt'), 'latin1')).toBe('06-07,PREM\r\n');
    expect(await ws.isLocked('06-07', 'prem')).toBe(true);
    await ws.unlock('06-07', 'PREM');
    expect(readFileSync(join(root, 'data/activelocation.txt'), 'latin1')).toBe('');
  });

  it('backs up the data folder', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'usw-bak-'));
    await ws.backupTo(new NodeDir(dest));
    expect(readdirSync(dest).sort()).toEqual(['activelocation.txt', 'bills']);
    expect(readFileSync(join(dest, 'bills/06-07/RISHABH/Audit/PREM CHAND.txt'))).toEqual(
      readFileSync(join(root, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt')),
    );
  });

  it('writes the letterhead, drop-downs and repairs a wiped bill-type line', async () => {
    await writeLetterhead(ws.program, { firmName: ['For X & Co.', 'CA'], firmAddress: ['Road 1'], indexTitles: ['Bills ##', '', ''] });
    const lines = await readImpinfo(ws.program);
    expect(lines?.[0]).toBe('(Audit^Audit)(Vat^Vat)(Tax^Tax)(Others^Others)');
    expect(letterheadFromImpinfo(lines)?.firmName).toEqual(['For X & Co.', 'CA']);
    await writeDropdowns(ws.program, await ws.billTypes(), new Map([['Vat', ['VAT return for ##', '']]]));
    const dd = await readDropdownLines(ws.program);
    expect(dd[0]).toBe('Audit^Income tax for the Assessment Year ##');
    expect(dd[1]).toBe('Vat^VAT return for ##');
    expect(await ws.dropdown('Vat', '06-07')).toEqual(['VAT return for 06-07']);
    await writeBillTypes(ws.program, []);
    expect(await ws.repairBillTypes()).toBe(true);
    expect((await ws.billTypes()).map((t) => t.folder)).toEqual(['Audit']);
  });
});
