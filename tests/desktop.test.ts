// Reading desktop (Java) folders, and the padding that keeps exported bills openable by Java.
import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeDir } from './nodefs';
import { DesktopData, desktopBillTypes } from '../src/core/desktop';
import { decodeCipherLines, encodeCipherLines } from '../src/core/codec';
import { letterheadFromImpinfo, readImpinfo, readPassword } from '../src/core/config';

const SAMPLE = join(import.meta.dirname, 'fixtures', 'java-sample');

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usw-desk-'));
  cpSync(SAMPLE, dir, { recursive: true });
  return dir;
}

const raw = (p: string) => decodeCipherLines(new Uint8Array(readFileSync(p)));

describe('desktop folders', () => {
  it('reads years, clients and bills written by Java', async () => {
    const root = copy();
    const d = new DesktopData(new NodeDir(join(root, 'data')));
    expect(await readPassword(new NodeDir(root))).toBe('puja');
    expect(await d.years()).toEqual(['06-07']);
    expect(await d.clients('06-07')).toEqual([
      { name: 'PREM', serial: '1', billNo: '' },
      { name: 'RISHABH', serial: '2', billNo: '' },
    ]);
    expect(await d.bills('06-07', 'RISHABH', 'Audit')).toEqual(['PREM CHAND']);
    expect(await d.readBillLines('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['pooja,20']);
    expect(letterheadFromImpinfo(await readImpinfo(new NodeDir(root)))).not.toBe(null);
  });

  it('finds the tabs from the folders when impinfo.txt lost them', async () => {
    const root = copy();
    writeFileSync(join(root, 'impinfo.txt'), encodeCipherLines(['']));
    const types = await desktopBillTypes(new NodeDir(root), new NodeDir(join(root, 'data')));
    expect(types.map((t) => t.folder)).toEqual(['Audit']);
  });

  it('pads rows the Java program could not open', async () => {
    const root = copy();
    const d = join(root, 'data/bills/07-08/RISHABH/Audit');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(root, 'data/bills/06-07/RISHABH/Audit/PREM CHAND.txt'), encodeCipherLines(['pooja,']));
    writeFileSync(join(d, 'PREM CHAND.txt'), encodeCipherLines(['pooja,0', 'Fee,10']));
    const data = new DesktopData(new NodeDir(join(root, 'data')));
    const types = [{ folder: 'Audit', tab: 'Audit' }];
    expect(await data.protectAll(types)).toBe(1);
    expect(raw(join(d, 'PREM CHAND.txt'))).toEqual(['pooja ,0', 'Fee,10']);
    expect(await data.protectAll(types)).toBe(0);
  });
});
