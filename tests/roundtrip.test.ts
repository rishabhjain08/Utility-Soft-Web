// Generated desktop data, moved to the web format and exported back, many times over:
// every round trip must give back exactly what was there.
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDir } from './nodefs';
import { FAST, copyOf, desktopOf, empty, javaClient } from './testdata';
import { exportToDesktop, migrateDesktop } from '../src/core/migrate';
import { compare, verify, webSide } from '../src/core/verify';
import { encodeCipherLines } from '../src/core/codec';

/** A small, repeatable random generator (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghij&.-()0123456789ÉçÑ₹';
const TEXT = `${LETTERS},;:'"!@#$%+=/[]{}##`;

function generate(seed: number): string {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const word = (chars: string, min: number, max: number) => {
    let s = '';
    const n = min + Math.floor(r() * (max - min + 1));
    for (let i = 0; i < n; i++) s += chars[Math.floor(r() * chars.length)];
    return s;
  };
  const folderName = () => {
    let n = word(LETTERS, 1, 14).trim().replace(/[. ]+$/, '');
    if (!n || /^(con|prn|aux|nul)$/i.test(n)) n = `X${seed}`;
    return n.toUpperCase();
  };
  const amount = () => pick(['', '0', String(Math.floor(r() * 100000)), String(-Math.floor(r() * 500)), '12a', '007', '+5', ' 7']);
  const line = () => {
    const k = r();
    if (k < 0.08) return pick(['New Name,New', 'New Name,', 'New Name,0', ' New Name ,']);
    if (k < 0.12) return pick(['no comma here', ',', `${word(TEXT, 1, 10)}  ,5`]);
    return `${word(TEXT, 0, 40)},${amount()}`;
  };
  const root = copyOf('java-sample');
  const first = 1 + Math.floor(r() * 20);
  const years = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => `${String(first + i).padStart(2, '0')}-${String(first + i + 1).padStart(2, '0')}`);
  const names = Array.from({ length: 1 + Math.floor(r() * 8) }, folderName);
  for (const y of years) {
    mkdirSync(join(root, 'data/bills', y), { recursive: true });
    for (const n of new Set(names.filter(() => r() < 0.7))) {
      const bills: Record<string, string[]> = {};
      for (let i = 0; i < Math.floor(r() * 4); i++) bills[`${pick(['Audit', 'Vat', 'Tax', 'Others'])}/${folderName()}`] = Array.from({ length: Math.floor(r() * 8) }, line);
      javaClient(root, y, n, pick(['', '1', '2', '3A', '10', String(Math.floor(r() * 50))]), pick(['', '12-14', 'B-7']), bills);
      if (r() < 0.1) writeFileSync(join(root, 'data/bills', y, n, `note ${seed}.txt`), word(TEXT, 0, 30));
    }
  }
  if (r() < 0.3) writeFileSync(join(root, 'data/extra.bin'), Buffer.from(word(TEXT, 0, 50)));
  // A client folder without S.No. or Bill No. files.
  if (r() < 0.3) {
    mkdirSync(join(root, 'data/bills', years[0], 'BARE', 'Vat'), { recursive: true });
    writeFileSync(join(root, 'data/bills', years[0], 'BARE', 'Vat', `${folderName()}.txt`), encodeCipherLines([line()]));
  }
  return root;
}

describe('round trips of generated data', () => {
  it('desktop -> web -> desktop -> web gives back the same data, 40 times', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const src = generate(seed);
      const first = await migrateDesktop(desktopOf(src), new NodeDir(empty()), FAST);
      expect(first.report.differences, `seed ${seed}: migration`).toEqual([]);
      if (process.env.SHOW) console.log(seed, JSON.stringify(first.report.counts), first.report.notes.length);
      const out = empty();
      const exp = await exportToDesktop(first.books, new NodeDir(out), 'puja');
      expect(exp.report.differences, `seed ${seed}: export`).toEqual([]);
      expect((await verify(desktopOf(src), first.books)).ok, `seed ${seed}: original vs web`).toBe(true);
      const again = await migrateDesktop(desktopOf(out), new NodeDir(empty()), FAST);
      expect(again.report.differences, `seed ${seed}: second migration`).toEqual([]);
      const same = await compare(webSide(first.books), webSide(again.books));
      expect(same.differences, `seed ${seed}: first vs second web copy`).toEqual([]);
    }
  }, 600_000);
});
