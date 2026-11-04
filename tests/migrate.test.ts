import { beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { NodeDir } from './nodefs';
import { Workspace } from '../src/core/workspace';
import { WebBooks } from '../src/core/webstore';
import { exportToDesktop, migrateDesktop } from '../src/core/migrate';
import { verify } from '../src/core/verify';
import { decodeCipherLines, decodeCipherValue, encodeCipherLines, encodePlainLines } from '../src/core/codec';
import { readImpinfo, writeBillTypes } from '../src/core/config';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function copyOf(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'usw-mig-'));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

const empty = () => mkdtempSync(join(tmpdir(), 'usw-dest-'));

/** Every file and folder under `root` with its bytes and modified time. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = statSync(p);
      if (e.isDirectory()) {
        out.set(relative(root, p) + '/', String(st.mtimeMs));
        walk(p);
      } else out.set(relative(root, p), `${st.mtimeMs}:${readFileSync(p).toString('base64')}`);
    }
  };
  walk(root);
  out.set('.', String(statSync(root).mtimeMs));
  return out;
}

const desktopOf = (root: string) => ({ program: new NodeDir(root), data: new NodeDir(join(root, 'data')) });

/** A desktop installation with two years, groups, history, odd rows and other files. */
async function richDesktop(): Promise<string> {
  const root = copyOf('java-sample');
  const program = new NodeDir(root);
  const ws = new Workspace(program, await program.dir('data'));
  await ws.saveLetterhead({ firmName: ['For JAIN & CO.', 'Chartered Accountants'], firmAddress: ['12, Road'], indexTitles: ['Index ##', '', ''] });
  await ws.addClient('06-07', 'Mohan', false);
  await ws.addClient('06-07', 'Prakash', true);
  await ws.writeBill('06-07', 'MOHAN', 'Vat', 'VAT AUDIT', [
    { desc: 'Fee for VAT Audit for the Assessment Year 06-07', amount: '700' },
    { desc: 'Expenses', amount: '50' },
    { desc: 'New Name', amount: '' },
    { desc: 'Fee for IT Return', amount: '1200' },
  ]);
  await ws.setBillNo('06-07', 'MOHAN', '12-14');
  await ws.addNextYear();
  await ws.copyClients('06-07', '07-08', ['MOHAN', 'RISHABH']);
  const bills = join(root, 'data', 'bills');
  // Rows as the Java program writes them: other group-break forms, padding, no comma, empty.
  writeFileSync(join(bills, '07-08/MOHAN/Tax/ODD.txt'), encodeCipherLines(['heading ,', 'New Name,', 'x,5', 'New Name,0', 'no comma', ',', '  lead,7']));
  // Files that are not data.
  writeFileSync(join(root, 'data', 'notes.txt'), 'office notes');
  mkdirSync(join(bills, 'old stuff', 'deep'), { recursive: true });
  writeFileSync(join(bills, 'old stuff', 'deep', 'a.bin'), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(bills, '06-07', 'readme.txt'), 'year note');
  writeFileSync(join(bills, '06-07/MOHAN/letter.doc'), 'letter');
  mkdirSync(join(bills, '06-07/MOHAN/Scans'));
  writeFileSync(join(bills, '06-07/MOHAN/Scans/p1.jpg'), 'jpg');
  writeFileSync(join(bills, '06-07/MOHAN/Vat/1q2m.txt'), encodeCipherLines(['temp,1']));
  writeFileSync(join(bills, '06-07/MOHAN/Vat/scan.pdf'), 'pdf');
  writeFileSync(join(bills, '07-08/RISHABH/Audit/.DS_Store'), 'x');
  return root;
}

describe('migration to the web format', () => {
  let root: string;
  beforeEach(async () => {
    root = await richDesktop();
  });

  it('copies everything, checks it and leaves the desktop folder untouched', async () => {
    const before = snapshot(root);
    const dest = empty();
    const r = await migrateDesktop(desktopOf(root), new NodeDir(dest));
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
    expect(r.report.counts).toEqual({ years: 2, clients: 6, bills: 5, rows: 17, extras: 8 });
    expect(r.report.notes.join(' ')).toContain('4 rows are written slightly differently');
    expect(snapshot(root)).toEqual(before);

    const web = new WebBooks(new NodeDir(dest));
    expect(await web.checkPassword('puja')).toBe(true);
    expect(await web.years()).toEqual(['06-07', '07-08']);
    expect((await web.clients('06-07')).map((c) => `${c.serial}|${c.name}|${c.billNo}`)).toEqual(['1|MOHAN|12-14', '1A|PRAKASH|', '2|PREM|', '3|RISHABH|']);
    expect(await web.readBill('06-07', 'MOHAN', 'Vat', 'VAT AUDIT')).toEqual([
      { desc: 'Fee for VAT Audit for the Assessment Year 06-07', amount: '700' },
      { desc: 'Expenses', amount: '50' },
      { desc: 'New Name', amount: 'New' },
      { desc: 'Fee for IT Return', amount: '1200' },
    ]);
    const hist = await web.billHistory('07-08', 'MOHAN', 'Vat', 'VAT AUDIT', await web.readBill('07-08', 'MOHAN', 'Vat', 'VAT AUDIT'));
    expect(hist[0].values).toEqual(['700', '50', '--', '1200']);
    expect((await web.letterhead())?.firmName).toEqual(['For JAIN & CO.', 'Chartered Accountants']);
    expect(readFileSync(join(dest, 'desktop-extras/bills/old stuff/deep/a.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
    // The same client has the same id in both years.
    const ids = readdirSync(join(dest, 'years/06-07'));
    expect(readdirSync(join(dest, 'years/07-08')).every((f) => ids.includes(f))).toBe(true);
  });

  it('lists every difference when the desktop data changes afterwards', async () => {
    const dest = empty();
    await migrateDesktop(desktopOf(root), new NodeDir(dest));
    const ws = new Workspace(new NodeDir(root), new NodeDir(join(root, 'data')));
    await ws.writeBill('06-07', 'MOHAN', 'Vat', 'VAT AUDIT', [{ desc: 'Fee for VAT Audit for the Assessment Year 06-07', amount: '750' }]);
    await ws.addClient('07-08', 'Zed', false);
    await ws.setBillNo('06-07', 'PREM', '9');
    writeFileSync(join(root, 'data/notes.txt'), 'changed');
    await ws.setPassword('other');
    const r = await verify(desktopOf(root), new WebBooks(new NodeDir(dest)));
    expect(r.ok).toBe(false);
    expect(r.differences).toEqual([
      { where: 'Password', desktop: 'one password', web: 'a different password' },
      { where: '06-07 › MOHAN › Vat › VAT AUDIT, row 1', desktop: '“Fee for VAT Audit for the Assessment Year ##”, amount “750”', web: '“Fee for VAT Audit for the Assessment Year ##”, amount “700”' },
      { where: '06-07 › PREM › Bill No.', desktop: '9', web: '(empty)' },
      { where: '07-08 › ZED', desktop: 'present', web: '(missing)' },
      { where: 'File notes.txt', desktop: 'one content', web: 'a different content' },
    ]);
  });

  it('refuses a folder that is not empty and never writes to the desktop folder', async () => {
    const dest = empty();
    writeFileSync(join(dest, 'x.txt'), 'x');
    await expect(migrateDesktop(desktopOf(root), new NodeDir(dest))).rejects.toThrow('not empty');
    // Nor inside the desktop folder.
    mkdirSync(join(root, 'data', 'copy'));
    const before = snapshot(root);
    await expect(migrateDesktop(desktopOf(root), new NodeDir(join(root, 'data', 'copy')))).rejects.toThrow('outside');
    await expect(migrateDesktop(desktopOf(root), new NodeDir(root))).rejects.toThrow('outside');
    expect(snapshot(root)).toEqual(before);
  });

  it('reports clients open in the desktop version and recovers wiped tabs', async () => {
    writeFileSync(join(root, 'data/activelocation.txt'), encodePlainLines(['06-07,MOHAN']));
    await writeBillTypes(new NodeDir(root), []);
    const dest = empty();
    const r = await migrateDesktop(desktopOf(root), new NodeDir(dest));
    expect(r.openInDesktop).toEqual(['06-07,MOHAN']);
    expect(r.report.ok).toBe(true);
    const web = new WebBooks(new NodeDir(dest));
    expect((await web.billTypes()).map((t) => t.folder).sort()).toEqual(['Audit', 'Others', 'Tax', 'Vat']);
    expect(await web.bills('07-08', 'MOHAN', 'Tax')).toEqual(['ODD']);
  });

  it('migrates a program folder that has no data folder yet', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'usw-bare-'));
    for (const f of ['pass.txt', 'impinfo.txt', 'ddown.txt']) cpSync(join(FIXTURES, 'java-sample', f), join(bare, f));
    const dest = empty();
    const r = await migrateDesktop({ program: new NodeDir(bare), data: null }, new NodeDir(dest));
    expect(r.report.ok).toBe(true);
    expect(await new WebBooks(new NodeDir(dest)).years()).toEqual([]);
  });
});

describe('export to the desktop layout', () => {
  it('gives back what was migrated, and the desktop version can read it', async () => {
    const root = await richDesktop();
    const dest = empty();
    await migrateDesktop(desktopOf(root), new NodeDir(dest));
    const web = new WebBooks(new NodeDir(dest));
    const out = empty();
    const r = await exportToDesktop(web, new NodeDir(out), 'puja');
    expect(r.report.differences).toEqual([]);
    expect(r.relocated).toEqual([]);
    // Same as the original, as the desktop version reads it.
    const a = await verify(desktopOf(out), web);
    expect(a.ok).toBe(true);
    for (const f of ['bills/06-07/MOHAN/letter.doc', 'bills/old stuff/deep/a.bin', 'notes.txt', 'bills/06-07/MOHAN/Vat/1q2m.txt']) {
      expect(readFileSync(join(out, 'data', f))).toEqual(readFileSync(join(root, 'data', f)));
    }
    expect(decodeCipherValue(readFileSync(join(out, 'pass.txt')))).toBe('puja');
    expect(await readImpinfo(new NodeDir(out))).toEqual(await readImpinfo(new NodeDir(root)));
    expect(readFileSync(join(out, 'ddown.txt'))).toEqual(readFileSync(join(root, 'ddown.txt')));
    expect(decodeCipherLines(readFileSync(join(out, 'data/bills/07-08/MOHAN/Tax/ODD.txt')))).toEqual([
      'heading,', 'New Name,New', 'x,5', 'New Name,New', 'no comma,', ',', '  lead,7',
    ]);
    expect(readdirSync(join(out, 'data/bills/07-08/MOHAN')).sort()).toEqual(['Audit', 'Others', 'Tax', 'Vat', 'billfromto.txt', 'serialno.txt']);
    expect(readFileSync(join(out, 'data/activelocation.txt')).length).toBe(0);
  });

  it('puts kept files of a renamed client aside, and pads rows for the desktop version', async () => {
    const root = await richDesktop();
    const dest = empty();
    await migrateDesktop(desktopOf(root), new NodeDir(dest));
    const web = new WebBooks(new NodeDir(dest));
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
    const root = await richDesktop();
    const dest = empty();
    await migrateDesktop(desktopOf(root), new NodeDir(dest));
    const web = new WebBooks(new NodeDir(dest));
    await expect(exportToDesktop(web, new NodeDir(empty()), 'nope')).rejects.toThrow('password');
    const full = empty();
    writeFileSync(join(full, 'a'), '');
    await expect(exportToDesktop(web, new NodeDir(full), 'puja')).rejects.toThrow('not empty');
  });

  it('round-trips the bills the Java program wrote (crash fixture)', async () => {
    const root = copyOf('java-crash');
    const dest = empty();
    const r = await migrateDesktop(desktopOf(root), new NodeDir(dest));
    expect(r.report.differences).toEqual([]);
    const out = empty();
    const e = await exportToDesktop(new WebBooks(new NodeDir(dest)), new NodeDir(out), 'puja');
    expect(e.report.differences).toEqual([]);
    expect((await verify(desktopOf(out), new WebBooks(new NodeDir(dest)))).ok).toBe(true);
  });
});
