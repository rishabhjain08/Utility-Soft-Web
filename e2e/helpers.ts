import { Page, expect } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderPicker } from './fs-shim';
import { decodeCipherLines, decodeCipherValue, encodeCipherLines, encodeCipherValue } from '../src/core/codec';
import { ClientYear, Settings, dropdownLines, groupsFromLines, linesFromGroups } from '../src/core/webstore';
import { Letterhead, billTypesFromImpinfo, letterheadFromImpinfo } from '../src/core/config';
import { migrateDesktop } from '../src/core/migrate';
import { NodeDir } from '../tests/nodefs';

export const FIXTURES = join(import.meta.dirname, '..', 'tests', 'fixtures');

/** A fresh copy of a fixture program folder in a temp dir. */
export function programCopy(fixture = 'java-sample'): string {
  const dir = mkdtempSync(join(tmpdir(), 'usw-e2e-'));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

export const cipherLines = (p: string) => decodeCipherLines(new Uint8Array(readFileSync(p)));
export const cipherValue = (p: string) => decodeCipherValue(new Uint8Array(readFileSync(p)));

export async function start(page: Page): Promise<FolderPicker> {
  const picker = new FolderPicker(page);
  await picker.install();
  // Chrome's print dialog cannot be driven by tests: record what would be printed
  // into #printed instead (and count the calls).
  await page.addInitScript(() => {
    window.print = () => {
      const w = window as unknown as { __prints: number };
      w.__prints = (w.__prints ?? 0) + 1;
      let d = document.getElementById('printed');
      if (!d) {
        d = document.createElement('div');
        d.id = 'printed';
        document.body.appendChild(d);
      }
      d.innerHTML = document.getElementById('print-root')!.innerHTML;
    };
  });
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
  await page.goto('/');
  return picker;
}

/**
 * Opens a folder and logs in. A desktop (Java) folder is then used as it is,
 * unless `keepDesktop` is false (the "Move to the new format" screen stays).
 */
export async function login(page: Page, picker: FolderPicker, dir: string, password = 'puja', keepDesktop = true) {
  picker.next(dir);
  await page.getByRole('button', { name: /Open Utility Soft folder/ }).click();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'OK' }).click();
  if (keepDesktop && !existsSync(join(dir, 'utility-soft.json'))) {
    await page.getByRole('button', { name: 'Keep using the desktop files' }).click();
  }
}

/** Rows of the client list as "serial|name|billno". */
export async function clientRows(page: Page): Promise<string[]> {
  return page.locator('table.clients tbody tr').evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.querySelector('input') as HTMLInputElement | null)?.value ?? td.textContent?.trim()).join('|')),
  );
}

export async function expectClients(page: Page, rows: string[]) {
  await expect.poll(() => clientRows(page)).toEqual(rows);
}

export async function selectClient(page: Page, name: string) {
  await page.locator('table.clients tbody tr', { has: page.locator('td.name', { hasText: new RegExp(`^${name}$`) }) }).click();
}

/** Rows of the bill grid as "desc|amount" (group breaks, saved as separators, as "--sep--"). */
export async function gridRows(page: Page): Promise<string[]> {
  return page.locator('table.grid tbody tr[data-index]').evaluateAll((trs) =>
    trs.map((tr) => {
      if (tr.classList.contains('group-head')) return '--sep--';
      const d = (tr.querySelector('.desc-input') as HTMLInputElement).value;
      const a = (tr.querySelector('.amt-input') as HTMLInputElement).value;
      return `${d}|${a}`;
    }),
  );
}

export async function waitSaved(page: Page) {
  await expect(page.locator('.save-state')).toHaveText('All changes saved', { timeout: 10_000 });
}

/** What the last window.print() call would have printed. */
export function printed(page: Page) {
  return page.locator('#printed');
}

/** On the "Move to the new format" screen: makes the copy in `dest` (an empty folder) and opens it. */
export async function migrateTo(page: Page, picker: FolderPicker, dest: string) {
  picker.next(dest);
  await page.getByRole('button', { name: /Make a (new )?copy/ }).click();
  const report = page.getByRole('dialog', { name: 'Copy made and checked' });
  await expect(report.locator('.report-ok')).toBeVisible();
  await report.getByRole('button', { name: 'Open the copy' }).click();
  await expect(page.locator('table.clients')).toBeVisible();
}

/** Utility ▸ Export for the desktop version, into `dest` (an empty folder). */
export async function exportTo(page: Page, picker: FolderPicker, dest: string) {
  await page.getByRole('button', { name: 'Utility…' }).click();
  await page.getByRole('button', { name: /Export for the desktop version/ }).click();
  picker.next(dest);
  await page.getByRole('button', { name: 'Choose a folder…' }).click();
  const report = page.getByRole('dialog', { name: 'Exported and checked' });
  await expect(report.locator('.report-ok')).toBeVisible();
  await report.locator('.modal-foot button').click();
}

// ---------- the same journeys in both formats ----------

export type Format = 'desktop' | 'web';
export const FORMATS: Format[] = ['desktop', 'web'];

/** Reads and writes test data in either format, by year, client, tab and bill name. */
export class Data {
  constructor(readonly dir: string, readonly format: Format) {}

  private records(year: string): { file: string; rec: ClientYear }[] {
    const y = join(this.dir, 'years', year);
    if (!existsSync(y)) return [];
    return readdirSync(y).map((f) => ({ file: join(y, f), rec: JSON.parse(readFileSync(join(y, f), 'utf8')) as ClientYear }));
  }

  private record(year: string, client: string): ClientYear | null {
    return this.records(year).find((r) => r.rec.name === client)?.rec ?? null;
  }

  hasClient(year: string, client: string): boolean {
    if (this.format === 'desktop') return existsSync(join(this.dir, 'data/bills', year, client));
    return this.record(year, client) !== null;
  }

  hasYear(year: string): boolean {
    return existsSync(join(this.dir, this.format === 'desktop' ? 'data/bills' : 'years', year));
  }

  /** A bill as desktop lines ("text,amount"; "New Name,New" between groups), null if there is none. */
  bill(year: string, client: string, type: string, name: string): string[] | null {
    if (this.format === 'desktop') {
      const p = join(this.dir, 'data/bills', year, client, type, `${name}.txt`);
      return existsSync(p) ? cipherLines(p) : null;
    }
    const b = this.record(year, client)?.bills.find((x) => x.type === type && x.name === name);
    return b ? linesFromGroups(b.groups) : null;
  }

  serial(year: string, client: string): string | null {
    if (this.format === 'desktop') return cipherValue(join(this.dir, 'data/bills', year, client, 'serialno.txt'));
    return this.record(year, client)?.serial ?? null;
  }

  billNo(year: string, client: string): string | null {
    if (this.format === 'desktop') return cipherValue(join(this.dir, 'data/bills', year, client, 'billfromto.txt'));
    return this.record(year, client)?.billNo ?? null;
  }

  private settings(): Settings {
    return JSON.parse(readFileSync(join(this.dir, 'utility-soft.json'), 'utf8'));
  }

  /** Tab titles of the bill types. */
  tabs(): string[] {
    if (this.format === 'desktop') return billTypesFromImpinfo(cipherLines(join(this.dir, 'impinfo.txt'))).map((t) => t.tab);
    return this.settings().billTypes.map((t) => t.tab);
  }

  /** Drop-down lists as ddown.txt lines ("Tab^entry^entry"). */
  dropdowns(): string[] {
    if (this.format === 'desktop') return readFileSync(join(this.dir, 'ddown.txt'), 'latin1').split('\r\n').filter((l) => l !== '');
    return dropdownLines(this.settings().dropdowns);
  }

  letterhead(): Letterhead | null {
    if (this.format === 'desktop') return letterheadFromImpinfo(cipherLines(join(this.dir, 'impinfo.txt')));
    return this.settings().letterhead;
  }

  /** Clients open right now, as "year,NAME". */
  locks(): string[] {
    if (this.format === 'desktop') {
      return readFileSync(join(this.dir, 'data/activelocation.txt'), 'latin1').split('\r\n').filter((l) => l !== '');
    }
    const d = join(this.dir, 'open');
    return existsSync(d) ? readdirSync(d).map((f) => f.replace(/\.lock$/, '').replace(' ', ',')).sort() : [];
  }

  /** As if another computer (or the desktop version) opened a client. */
  lockElsewhere(year: string, client: string) {
    if (this.format === 'desktop') writeFileSync(join(this.dir, 'data/activelocation.txt'), `${year},${client}\r\n`);
    else {
      mkdirSync(join(this.dir, 'open'), { recursive: true });
      writeFileSync(join(this.dir, 'open', `${year} ${client}.lock`), '{}');
    }
  }

  /** As if another computer added a client. */
  addClientElsewhere(year: string, client: string, serial: string, billNo = '') {
    if (this.format === 'desktop') {
      const c = join(this.dir, 'data/bills', year, client);
      mkdirSync(c);
      writeFileSync(join(c, 'serialno.txt'), encodeCipherValue(serial));
      writeFileSync(join(c, 'billfromto.txt'), encodeCipherValue(billNo));
    } else {
      const rec: ClientYear = { id: `other${serial}`, name: client, serial, billNo, bills: [] };
      writeFileSync(join(this.dir, 'years', year, `${rec.id}.json`), JSON.stringify(rec));
    }
  }

  /** As if another computer saved a bill. */
  writeBill(year: string, client: string, type: string, name: string, lines: string[]) {
    if (this.format === 'desktop') {
      writeFileSync(join(this.dir, 'data/bills', year, client, type, `${name}.txt`), encodeCipherLines(lines));
      return;
    }
    const r = this.records(year).find((x) => x.rec.name === client)!;
    const bills = r.rec.bills.filter((b) => !(b.type === type && b.name === name));
    writeFileSync(r.file, JSON.stringify({ ...r.rec, bills: [...bills, { type, name, groups: groupsFromLines(lines) }] }));
  }
}

/**
 * A copy of a desktop fixture (after `seed` changes it) in the given format:
 * for the web format it is migrated first, the way the app does it.
 */
export async function dataCopy(format: Format, seed?: (desktopDir: string) => void, fixture = 'java-sample'): Promise<Data> {
  const src = programCopy(fixture);
  seed?.(src);
  if (format === 'desktop') return new Data(src, 'desktop');
  const dest = mkdtempSync(join(tmpdir(), 'usw-e2e-web-'));
  const r = await migrateDesktop({ program: new NodeDir(src), data: new NodeDir(join(src, 'data')) }, new NodeDir(dest));
  if (!r.report.ok) throw new Error(`migration of the test data failed: ${JSON.stringify(r.report.differences)}`);
  return new Data(dest, 'web');
}
