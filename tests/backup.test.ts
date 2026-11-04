import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDir } from './nodefs';
import { FAST, copyOf, desktopOf, empty } from './testdata';
import { WebBooks } from '../src/core/webstore';
import { migrateDesktop } from '../src/core/migrate';
import { backupsToKeep, checkBackup, dailyBackup, insideBackups, listBackups, makeBackup, openBackup, restoreBackup } from '../src/core/backup';

async function store() {
  const dir = empty();
  const r = await migrateDesktop(desktopOf(copyOf('java-sample')), new NodeDir(dir), FAST);
  return { dir, web: r.books };
}

describe('backups', () => {
  it('copies the data, checks it, and opens like the original', async () => {
    const { web } = await store();
    await web.addYear('07-08');
    const dest = empty();
    await makeBackup(web, new NodeDir(dest));
    expect(readdirSync(dest).sort()).toEqual(['backup.json', 'settings.dat', 'utility-soft.json', 'years']);
    expect(readdirSync(join(dest, 'years')).sort()).toEqual(['06-07', '07-08']);
    expect(await checkBackup(new NodeDir(dest))).toEqual([]);
    const copy = (await WebBooks.unlock(new NodeDir(dest), 'puja'))!;
    expect(await copy.readBillLines('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['pooja,20']);
    // A changed file is noticed.
    const f = join(dest, 'settings.dat');
    const b = readFileSync(f);
    b[10] ^= 1;
    writeFileSync(f, b);
    expect(await checkBackup(new NodeDir(dest))).toEqual(['settings.dat']);
  });

  it('makes one automatic backup a day and keeps 7 daily, 4 weekly and 12 monthly', async () => {
    const { web } = await store();
    const day = Date.parse('2026-11-04T09:00:00');
    expect(await dailyBackup(web, day)).toBe(true);
    expect(await dailyBackup(web, day + 3600_000)).toBe(false);
    expect(await dailyBackup(web, day + 24 * 3600_000)).toBe(true);
    expect((await listBackups(await insideBackups(web))).length).toBe(2);

    const days = Array.from({ length: 400 }, (_, i) => Date.parse('2026-11-04T09:00:00') - i * 24 * 3600_000);
    const keep = [...backupsToKeep(days)].sort((a, b) => b - a);
    expect(keep.length).toBeLessThanOrEqual(1 + 7 + 4 + 12);
    expect(keep.slice(0, 7)).toEqual(days.slice(0, 7));
    expect(new Date(keep[keep.length - 1]).getMonth()).not.toBe(new Date(keep[keep.length - 2]).getMonth());
  });

  it('restores a backup, after backing up what is there now; the password stays', async () => {
    const { web } = await store();
    const dest = empty();
    await makeBackup(web, new NodeDir(dest));
    await web.addClient('06-07', 'Zed', false);
    await web.writeBill('06-07', 'RISHABH', 'Audit', 'PREM CHAND', [{ desc: 'pooja', amount: '99' }]);
    await web.addYear('07-08');
    await web.setPassword('changed');
    await restoreBackup(web, new NodeDir(dest));
    const now = (await WebBooks.unlock(web.root, 'changed'))!;
    expect(await now.years()).toEqual(['06-07']);
    expect(await now.clientNames('06-07')).toEqual(['PREM', 'RISHABH']);
    expect(await now.readBillLines('06-07', 'RISHABH', 'Audit', 'PREM CHAND')).toEqual(['pooja,20']);
    // What was there before the restore is itself a backup.
    const [before] = await listBackups(await insideBackups(web));
    expect(await openBackup(web, before.dir).clientNames('06-07')).toEqual(['PREM', 'RISHABH', 'ZED']);
  });

  it('restores today’s automatic backup (which keeping one a day would otherwise remove)', async () => {
    const { web } = await store();
    const t = Date.parse('2026-11-04T09:00:00');
    await dailyBackup(web, t);
    await web.addClient('06-07', 'Zed', false);
    const [today] = await listBackups(await insideBackups(web));
    await restoreBackup(web, today.dir, t + 60_000);
    expect(await web.clientNames('06-07')).toEqual(['PREM', 'RISHABH']);
    const left = await listBackups(await insideBackups(web));
    expect(left).toHaveLength(1);
    expect(await openBackup(web, left[0].dir).clientNames('06-07')).toEqual(['PREM', 'RISHABH', 'ZED']);
  });

  it('refuses a damaged backup or one of other data', async () => {
    const { web } = await store();
    const dest = empty();
    await makeBackup(web, new NodeDir(dest));
    const other = await store();
    await expect(restoreBackup(other.web, new NodeDir(dest))).rejects.toThrow();
    writeFileSync(join(dest, 'settings.dat'), 'x');
    await expect(restoreBackup(web, new NodeDir(dest))).rejects.toThrow('damaged');
    expect(await web.clientNames('06-07')).toEqual(['PREM', 'RISHABH']);
  });
});
