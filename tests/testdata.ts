// Test data shared by the unit tests.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { NodeDir } from './nodefs';
import { decodeCipherLines, encodeCipherLines, encodeCipherValue } from '../src/core/codec';

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** Few PBKDF2 rounds, so tests are quick. */
export const FAST = { iterations: 1000 };

export const empty = () => mkdtempSync(join(tmpdir(), 'usw-dest-'));

export function copyOf(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'usw-fix-'));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

export const desktopOf = (root: string) => ({ program: new NodeDir(root), data: new NodeDir(join(root, 'data')) });

/** Every file and folder under `root` with its bytes and modified time. */
export function snapshot(root: string): Map<string, string> {
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

/** All file names and contents under `root` as one text, to look for things that must not be readable. */
export function everything(root: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      parts.push(relative(root, p));
      if (e.isDirectory()) walk(p);
      else parts.push(readFileSync(p).toString('latin1'), readFileSync(p).toString('utf8'), readFileSync(p).toString('utf16le'));
    }
  };
  walk(root);
  return parts.join('\n');
}

const TYPES = ['Audit', 'Vat', 'Tax', 'Others'];

/** A client folder as the Java program writes it. */
export function javaClient(root: string, year: string, name: string, serial: string, billNo: string, bills: Record<string, string[]> = {}) {
  const c = join(root, 'data/bills', year, name);
  for (const t of TYPES) mkdirSync(join(c, t), { recursive: true });
  writeFileSync(join(c, 'serialno.txt'), encodeCipherValue(serial));
  writeFileSync(join(c, 'billfromto.txt'), encodeCipherValue(billNo));
  for (const [k, lines] of Object.entries(bills)) writeFileSync(join(c, `${k}.txt`), encodeCipherLines(lines));
}

/** A desktop installation with two years, groups, history, odd rows and other files. */
export function richDesktop(): string {
  const root = copyOf('java-sample');
  const impinfo = decodeCipherLines(readFileSync(join(root, 'impinfo.txt')));
  writeFileSync(join(root, 'impinfo.txt'), encodeCipherLines([impinfo[0], '~For JAIN & CO.%~Chartered Accountants%', '~12, Road%', '%$Index ##%$%$%$']));
  javaClient(root, '06-07', 'MOHAN', '1', '12-14', {
    'Vat/VAT AUDIT': ['Fee for VAT Audit for the Assessment Year ##,700', 'Expenses,50', 'New Name,New', 'Fee for IT Return,1200'],
  });
  javaClient(root, '06-07', 'PRAKASH', '1A', '');
  writeFileSync(join(root, 'data/bills/06-07/PREM/serialno.txt'), encodeCipherValue('2'));
  writeFileSync(join(root, 'data/bills/06-07/RISHABH/serialno.txt'), encodeCipherValue('3'));
  javaClient(root, '07-08', 'MOHAN', '1', '12-14', {
    'Vat/VAT AUDIT': ['Fee for VAT Audit for the Assessment Year ##,0', 'Expenses,0', 'New Name,New', 'Fee for IT Return,0'],
    // Rows as the Java program writes them: other group-break forms, padding, no comma, empty, odd amounts.
    'Tax/ODD': ['heading ,', 'New Name,', 'x,5', 'New Name,0', 'no comma', ',', '  lead,7', 'odd,12a', 'zero,007'],
  });
  javaClient(root, '07-08', 'RISHABH', '3', '', { 'Audit/PREM CHAND': ['pooja,0'] });
  const bills = join(root, 'data', 'bills');
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
