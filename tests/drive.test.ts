import { describe, expect, it } from 'vitest';
import { NodeDir } from './nodefs';
import { FAST, copyOf, desktopOf, empty } from './testdata';
import { FakeDrive } from './fakedrive';
import { Drive } from '../src/core/drive';
import { backupToDrive, driveDue, fromDrive, restoreBackup } from '../src/core/backup';
import { pack, unpack, writeOut, MemDir } from '../src/core/pack';
import { migrateDesktop } from '../src/core/migrate';
import { WebBooks } from '../src/core/webstore';

async function store() {
  const r = await migrateDesktop(desktopOf(copyOf('java-sample')), new NodeDir(empty()), FAST);
  return r.books;
}

describe('packing a backup into one file', () => {
  it('keeps every file and empty folder', async () => {
    const m = new MemDir('x');
    m.ensure(['years', '06-07']).files.set('a.dat', new Uint8Array([1, 2, 3]));
    m.ensure(['years', '07-08']);
    m.files.set('backup.json', new TextEncoder().encode('{}'));
    const back = unpack(await pack(m))!;
    expect([...back.dirs.get('years')!.dirs.keys()].sort()).toEqual(['06-07', '07-08']);
    expect(back.dirs.get('years')!.dirs.get('06-07')!.files.get('a.dat')).toEqual(new Uint8Array([1, 2, 3]));
    expect(unpack(new Uint8Array([1, 2, 3]))).toBe(null);
  });
});

describe('Google Drive backups', () => {
  it('backs up, lists, thins out, and restores, also on a new computer', async () => {
    const web = await store();
    const fake = new FakeDrive();
    let asked = 0;
    const drive = new Drive(async (fresh) => {
      asked++;
      if (fresh) fake.token = 'good';
      return fake.token;
    }, fake.fetch);
    const day = Date.parse('2026-11-04T09:00:00');
    for (let i = 0; i < 10; i++) await backupToDrive(web, drive, day - i * 24 * 3600_000);
    const list = await drive.list(await web.storeId());
    expect(list).toHaveLength(7); // the last 7 days (the week and month before are among them)
    expect(list[0]).toMatchObject({ at: day, label: web.root.name });
    expect((await web.settings()).drive?.last).toBe(day - 9 * 24 * 3600_000);
    // The file in Drive is encrypted.
    const raw = [...fake.files.values()].find((f) => f.name.endsWith('.usbackup'))!.data;
    expect(new TextDecoder('latin1').decode(raw)).not.toContain('RISHABH');

    // A token that has expired is asked for again.
    fake.token = 'renewed';
    expect((await drive.list()).length).toBe(7);
    expect(asked).toBeGreaterThan(1);

    // Restore into the same data.
    await web.addClient('06-07', 'Zed', false);
    const b = await fromDrive(drive, list[0]);
    await restoreBackup(web, b);
    expect(await web.clientNames('06-07')).toEqual(['PREM', 'RISHABH']);

    // A new computer: the backup written into an empty folder opens with the password.
    const dir = empty();
    await writeOut(await fromDrive(drive, list[0]), new NodeDir(dir));
    const opened = (await WebBooks.unlock(new NodeDir(dir), 'puja'))!;
    expect(await opened.clientNames('06-07')).toEqual(['PREM', 'RISHABH']);
  });

  it('is due once a day when switched on', () => {
    const now = Date.parse('2026-11-04T09:00:00');
    expect(driveDue(undefined, now)).toBe(false);
    expect(driveDue({ daily: true }, now)).toBe(true);
    expect(driveDue({ daily: true, last: now - 3600_000 }, now)).toBe(false);
    expect(driveDue({ daily: true, last: now - 24 * 3600_000 }, now)).toBe(true);
    expect(driveDue({ daily: false, last: 0 }, now)).toBe(false);
  });
});
