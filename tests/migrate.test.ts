import { beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeDir } from './nodefs';
import { FAST, desktopOf, empty, everything, javaClient, richDesktop, snapshot } from './testdata';
import { WebBooks } from '../src/core/webstore';
import { exportToDesktop, migrateDesktop } from '../src/core/migrate';
import { verify } from '../src/core/verify';
import { decodeCipherLines, decodeCipherValue, encodeCipherLines, encodeCipherValue, encodePlainLines } from '../src/core/codec';
import { readImpinfo } from '../src/core/config';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function copyOf(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'usw-mig-'));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

describe('migration to the web format', () => {
  let root: string;
  beforeEach(() => {
    root = richDesktop();
  });

  it('copies everything, checks it and leaves the desktop folder untouched', async () => {
    const before = snapshot(root);
    const dest = empty();
    const r = await migrateDesktop(desktopOf(root), new NodeDir(dest), FAST);
    expect(r.report.differences).toEqual([]);
    expect(r.report.ok).toBe(true);
    expect(r).toMatchObject({ years: 2, clients: 6, bills: 5 });
    expect(r.extras.sort()).toEqual([
      'bills/06-07/MOHAN/Scans',
      'bills/06-07/MOHAN/Vat/1q2m.txt',
      'bills/06-07/MOHAN/Vat/scan.pdf',
      'bills/06-07/MOHAN/letter.doc',
      'bills/06-07/readme.txt',
      'bills/07-08/RISHABH/Audit/.DS_Store',
      'bills/old stuff',
      'notes.txt',
    ]);
    expect(r.report.counts).toEqual({ years: 2, clients: 6, bills: 5, rows: 19, extras: 8 });
    expect(r.report.notes.join(' ')).toContain('4 rows are written slightly differently');
    expect(r.recoveryCode).toMatch(/^([0-9A-Z]{4}-){5}[0-9A-Z]{4}$/);
    expect(snapshot(root)).toEqual(before);

    const web = (await WebBooks.unlock(new NodeDir(dest), 'puja'))!;
    expect(web).not.toBe(null);
    expect(await WebBooks.unlock(new NodeDir(dest), 'wrong')).toBe(null);
    expect(await web.years()).toEqual(['06-07', '07-08']);
    expect((await web.clients('06-07')).map((c) => `${c.serial}|${c.name}|${c.billNo}`)).toEqual(['1|MOHAN|12-14', '1A|PRAKASH|', '2|PREM|', '3|RISHABH|']);
    expect(await web.readBill('06-07', 'MOHAN', 'Vat', 'VAT AUDIT')).toEqual([
      { desc: 'Fee for VAT Audit for the Assessment Year 06-07', amount: '700' },
      { desc: 'Expenses', amount: '50' },
      { desc: 'New Name', amount: 'New' },
      { desc: 'Fee for IT Return', amount: '1200' },
    ]);
    // Amounts that are not plain whole numbers are kept as they were.
    expect((await web.readBillLines('07-08', 'MOHAN', 'Tax', 'ODD'))?.slice(-2)).toEqual(['odd,12a', 'zero,007']);
    const hist = await web.billHistory('07-08', 'MOHAN', 'Vat', 'VAT AUDIT', await web.readBill('07-08', 'MOHAN', 'Vat', 'VAT AUDIT'));
    expect(hist[0].values).toEqual(['700', '50', '--', '1200']);
    expect((await web.letterhead())?.firmName).toEqual(['For JAIN & CO.', 'Chartered Accountants']);

    // Nothing readable on disk: no names, no bill text, no amounts, not even in file names.
    const disk = everything(dest);
    for (const secret of ['MOHAN', 'PRAKASH', 'RISHABH', 'pooja', 'JAIN', 'VAT AUDIT', '12-14', 'office notes', 'letter.doc', 'puja']) {
      expect(disk).not.toContain(secret);
    }
    // The same client has the same id in both years.
    const ids = readdirSync(join(dest, 'years/06-07'));
    expect(readdirSync(join(dest, 'years/07-08')).every((f) => ids.includes(f))).toBe(true);
  });

  it('opens with the recovery code too', async () => {
    const dest = empty();
    const r = await migrateDesktop(desktopOf(root), new NodeDir(dest), FAST);
    const typed = r.recoveryCode.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o');
    const web = (await WebBooks.unlockWithRecovery(new NodeDir(dest), typed, FAST))!;
    expect(await web.clientNames('07-08')).toEqual(['MOHAN', 'RISHABH']);
    expect(await WebBooks.unlockWithRecovery(new NodeDir(dest), 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA')).toBe(null);
    // The whole note pasted works too.
    expect(await WebBooks.unlockWithRecovery(new NodeDir(dest), `Utility Soft recovery code for “X”: ${r.recoveryCode}`)).not.toBe(null);
    expect(await WebBooks.unlockWithRecovery(new NodeDir(dest), `Utility Soft recovery code for "X":\n\n${r.recoveryCode}\n\nKeep this email. If you forget…`)).not.toBe(null);
    // A new password, set after recovering.
    await web.setPassword('new one');
    expect(await WebBooks.unlock(new NodeDir(dest), 'new one')).not.toBe(null);
    expect(await WebBooks.unlock(new NodeDir(dest), 'puja')).toBe(null);
    // A new recovery code replaces the old one.
    const code = await web.newRecoveryCode();
    expect(await WebBooks.unlockWithRecovery(new NodeDir(dest), r.recoveryCode)).toBe(null);
    expect(await WebBooks.unlockWithRecovery(new NodeDir(dest), code)).not.toBe(null);
  });

  it('lists every difference when the desktop data changes afterwards', async () => {
    const r = await migrateDesktop(desktopOf(root), new NodeDir(empty()), FAST);
    writeFileSync(join(root, 'data/bills/06-07/MOHAN/Vat/VAT AUDIT.txt'), encodeCipherLines(['Fee for VAT Audit for the Assessment Year ##,750']));
    javaClient(root, '07-08', 'ZED', '3', '');
    writeFileSync(join(root, 'data/bills/06-07/PREM/billfromto.txt'), encodeCipherValue('9'));
    writeFileSync(join(root, 'data/notes.txt'), 'changed');
    writeFileSync(join(root, 'pass.txt'), encodeCipherValue('other'));
    const v = await verify(desktopOf(root), r.books);
    expect(v.ok).toBe(false);
    expect(v.differences).toEqual([
      { where: 'Password', desktop: 'one password', web: 'a different password' },
      { where: '06-07 › MOHAN › Vat › VAT AUDIT, row 1', desktop: '“Fee for VAT Audit for the Assessment Year ##”, amount “750”', web: '“Fee for VAT Audit for the Assessment Year ##”, amount “700”' },
      { where: '06-07 › PREM › Bill No.', desktop: '9', web: '(empty)' },
      { where: '07-08 › ZED', desktop: 'present', web: '(missing)' },
      { where: 'File notes.txt', desktop: 'one content', web: 'a different content' },
    ]);
  });

  it('refuses a folder that is not empty or inside the desktop folder, and never writes there', async () => {
    const dest = empty();
    writeFileSync(join(dest, 'x.txt'), 'x');
    await expect(migrateDesktop(desktopOf(root), new NodeDir(dest), FAST)).rejects.toThrow('not empty');
    mkdirSync(join(root, 'data', 'copy'));
    const before = snapshot(root);
    await expect(migrateDesktop(desktopOf(root), new NodeDir(join(root, 'data', 'copy')), FAST)).rejects.toThrow('outside');
    await expect(migrateDesktop(desktopOf(root), new NodeDir(root), FAST)).rejects.toThrow('outside');
    expect(snapshot(root)).toEqual(before);
  });

  it('reports clients open in the desktop version and recovers wiped tabs', async () => {
    writeFileSync(join(root, 'data/activelocation.txt'), encodePlainLines(['06-07,MOHAN']));
    writeFileSync(join(root, 'impinfo.txt'), encodeCipherLines(['']));
    const r = await migrateDesktop(desktopOf(root), new NodeDir(empty()), FAST);
    expect(r.openInDesktop).toEqual(['06-07,MOHAN']);
    expect(r.report.ok).toBe(true);
    expect((await r.books.billTypes()).map((t) => t.folder).sort()).toEqual(['Audit', 'Others', 'Tax', 'Vat']);
    expect(await r.books.bills('07-08', 'MOHAN', 'Tax')).toEqual(['ODD']);
  });

  it('migrates a folder without data or password', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'usw-bare-'));
    for (const f of ['impinfo.txt', 'ddown.txt']) cpSync(join(FIXTURES, 'java-sample', f), join(bare, f));
    await expect(migrateDesktop({ program: new NodeDir(bare), data: null }, new NodeDir(empty()), FAST)).rejects.toThrow('no password');
    const dest = empty();
    const r = await migrateDesktop({ program: new NodeDir(bare), data: null }, new NodeDir(dest), { ...FAST, password: 'chosen' });
    expect(r.report.ok).toBe(true);
    expect(r.report.notes[0]).toContain('had no password');
    expect(await (await WebBooks.unlock(new NodeDir(dest), 'chosen'))!.years()).toEqual([]);
  });
});

describe('export to the desktop layout', () => {
  it('gives back what was migrated, and the desktop version can read it', async () => {
    const root = richDesktop();
    const { books: web } = await migrateDesktop(desktopOf(root), new NodeDir(empty()), FAST);
    const out = empty();
    const r = await exportToDesktop(web, new NodeDir(out), 'puja');
    expect(r.report.differences).toEqual([]);
    expect(r.relocated).toEqual([]);
    expect((await verify(desktopOf(out), web)).ok).toBe(true);
    for (const f of ['bills/06-07/MOHAN/letter.doc', 'bills/old stuff/deep/a.bin', 'notes.txt', 'bills/06-07/MOHAN/Vat/1q2m.txt', 'bills/06-07/MOHAN/Scans/p1.jpg']) {
      expect(readFileSync(join(out, 'data', f))).toEqual(readFileSync(join(root, 'data', f)));
    }
    expect(decodeCipherValue(readFileSync(join(out, 'pass.txt')))).toBe('puja');
    expect(await readImpinfo(new NodeDir(out))).toEqual(await readImpinfo(new NodeDir(root)));
    expect(readFileSync(join(out, 'ddown.txt'))).toEqual(readFileSync(join(root, 'ddown.txt')));
    expect(decodeCipherLines(readFileSync(join(out, 'data/bills/07-08/MOHAN/Tax/ODD.txt')))).toEqual([
      'heading,', 'New Name,New', 'x,5', 'New Name,New', 'no comma,', ',', '  lead,7', 'odd,12a', 'zero,007',
    ]);
    expect(readdirSync(join(out, 'data/bills/07-08/MOHAN')).sort()).toEqual(['Audit', 'Others', 'Tax', 'Vat', 'billfromto.txt', 'serialno.txt']);
    expect(readFileSync(join(out, 'data/activelocation.txt')).length).toBe(0);
  });

  it('puts kept files of a renamed client aside, and pads rows for the desktop version', async () => {
    const root = richDesktop();
    const { books: web } = await migrateDesktop(desktopOf(root), new NodeDir(empty()), FAST);
    await web.modifyClient('06-07', 'MOHAN', 'Mohan Lal', '12-14', true);
    // A heading row without an amount last year, and the same row this year.
    await web.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'pooja', amount: '' }]);
    const out = empty();
    const r = await exportToDesktop(web, new NodeDir(out), 'puja');
    expect(r.report.differences).toEqual([]);
    expect(r.relocated.sort()).toEqual(['bills/06-07/MOHAN/Scans', 'bills/06-07/MOHAN/Vat/1q2m.txt', 'bills/06-07/MOHAN/Vat/scan.pdf', 'bills/06-07/MOHAN/letter.doc']);
    expect(readFileSync(join(out, 'Other files/bills/06-07/MOHAN/letter.doc'), 'utf8')).toBe('letter');
    expect(readdirSync(join(out, 'data/bills/06-07')).sort()).toEqual(['MOHAN LAL', 'PRAKASH', 'PREM', 'RISHABH', 'readme.txt']);
    expect(decodeCipherLines(readFileSync(join(out, 'data/bills/07-08/RISHABH/Audit/PREM CHAND.txt')))).toEqual(['pooja ,0']);
    expect(r.report.notes.join(' ')).toContain('“Other files”');
  });

  it('refuses a wrong password or a folder that is not empty', async () => {
    const { books: web } = await migrateDesktop(desktopOf(richDesktop()), new NodeDir(empty()), FAST);
    await expect(exportToDesktop(web, new NodeDir(empty()), 'nope')).rejects.toThrow('password');
    const full = empty();
    writeFileSync(join(full, 'a'), '');
    await expect(exportToDesktop(web, new NodeDir(full), 'puja')).rejects.toThrow('not empty');
  });

  it('round-trips the bills the Java program wrote (crash fixture)', async () => {
    const r = await migrateDesktop(desktopOf(copyOf('java-crash')), new NodeDir(empty()), FAST);
    expect(r.report.differences).toEqual([]);
    const out = empty();
    const e = await exportToDesktop(r.books, new NodeDir(out), 'puja');
    expect(e.report.differences).toEqual([]);
    expect((await verify(desktopOf(out), r.books)).ok).toBe(true);
  });
});
