import { Page, expect } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderPicker } from './fs-shim';
import { decodeCipherLines, decodeCipherValue } from '../src/core/codec';
import { ClientYear, WebBooks, dropdownLines, encodeRecord, recordPath } from '../src/core/webstore';
import { Letterhead } from '../src/core/config';
import { rowsFromLines } from '../src/core/bill';
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
 * Opens a folder and enters its password. A web data folder then opens; a
 * desktop (Java) folder shows "Move to the new format".
 */
export async function login(page: Page, picker: FolderPicker, dir: string, password = 'puja') {
  picker.next(dir);
  await page.getByRole('button', { name: /Open Utility Soft folder|Open a different folder/ }).click();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'OK' }).click();
}

/** Rows of the client list as "serial|name|billno". */
/** Rows of the client list as "serial|name|billno" (the Billed and Due columns left out). */
export async function clientRows(page: Page): Promise<string[]> {
  return page.locator('table.clients tbody tr').evaluateAll((trs) =>
    trs.map((tr) =>
      Array.from(tr.querySelectorAll('td'))
        .slice(0, 3)
        .map((td) => (td.querySelector('input') as HTMLInputElement | null)?.value ?? td.textContent?.trim())
        .join('|'),
    ),
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
      // Amounts are shown with Indian commas.
      const a = (tr.querySelector('.amt-input') as HTMLInputElement).value.replace(/,/g, '');
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

/** On the "Move to the new format" screen: makes the copy in `dest` (an empty folder), opens it and saves the recovery code. */
export async function migrateTo(page: Page, picker: FolderPicker, dest: string): Promise<string> {
  picker.next(dest);
  await page.getByRole('button', { name: /Make a (new )?copy/ }).click();
  const report = page.getByRole('dialog', { name: 'Copy made and checked' });
  await expect(report.locator('.report-ok')).toBeVisible({ timeout: 30_000 });
  await report.getByRole('button', { name: 'Open the copy' }).click();
  const code = await saveRecoveryCode(page);
  await expect(page.locator('table.clients')).toBeVisible();
  return code;
}

/** The recovery code screen: shows the code as text and types back the group asked for. Returns the code. */
export async function saveRecoveryCode(page: Page): Promise<string> {
  await expect(page.getByRole('heading', { name: 'Save your recovery code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByRole('button', { name: "Can't scan? Show the code to write down" }).click();
  const code = (await page.getByLabel('Recovery code', { exact: true }).textContent())!.trim();
  const label = (await page.locator('.check-code span').textContent())!;
  const n = Number(/Group (\d)/.exec(label)![1]);
  await page.locator('.check-code input').fill(code.split('-')[n - 1].toLowerCase());
  await page.getByRole('button', { name: 'Continue' }).click();
  return code;
}

/** Utility ▸ Export for the desktop version, into `dest` (an empty folder). */
export async function exportTo(page: Page, picker: FolderPicker, dest: string) {
  await expect(page.locator('table.clients')).toBeVisible();
  await page.getByRole('button', { name: 'Utility…', exact: true }).click();
  await page.getByRole('button', { name: /Export for the desktop version/ }).click();
  picker.next(dest);
  await page.getByRole('button', { name: 'Choose a folder…' }).click();
  const report = page.getByRole('dialog', { name: 'Exported and checked' });
  await expect(report.locator('.report-ok')).toBeVisible({ timeout: 30_000 });
  await report.locator('.modal-foot button').click();
}

// ---------- test data in the web format ----------

/** Few PBKDF2 rounds, so tests are quick. */
const FAST = { iterations: 1000 };
const ELSEWHERE = { id: 'office', name: 'Office PC' };

/** Reads and changes web-format test data (decrypting it), by year, client, tab and bill name. */
export class Data {
  constructor(
    readonly dir: string,
    private books: WebBooks,
    readonly recoveryCode: string,
  ) {}

  /** As the app on another computer sees it now. */
  private get ws(): WebBooks {
    return this.books.as({ computer: ELSEWHERE });
  }

  async hasClient(year: string, client: string): Promise<boolean> {
    return this.ws.clientExists(year, client);
  }

  async hasYear(year: string): Promise<boolean> {
    return (await this.ws.years()).includes(year);
  }

  /** A bill as desktop lines ("text,amount"; "New Name,New" between groups), null if there is none. */
  async bill(year: string, client: string, type: string, name: string): Promise<string[] | null> {
    return this.ws.readBillLines(year, client, type, name);
  }

  async serial(year: string, client: string): Promise<string | null> {
    return (await this.ws.clients(year)).find((c) => c.name === client)?.serial ?? null;
  }

  async billNo(year: string, client: string): Promise<string | null> {
    return (await this.ws.clients(year)).find((c) => c.name === client)?.billNo ?? null;
  }

  async tabs(): Promise<string[]> {
    return (await this.ws.billTypes()).map((t) => t.tab);
  }

  /** Drop-down lists as ddown.txt lines ("Tab^entry^entry", ## for the year). */
  async dropdowns(): Promise<string[]> {
    return dropdownLines((await this.ws.settings()).dropdowns);
  }

  async letterhead(): Promise<Letterhead | null> {
    return this.ws.letterhead();
  }

  /** Clients open right now, as "year,NAME". */
  async locks(): Promise<string[]> {
    return (await this.ws.openClients()).map(([y, n]) => `${y},${n}`).sort();
  }

  /** As if another computer opened a client. */
  async lockElsewhere(year: string, client: string) {
    await this.ws.lock(year, client);
  }

  /** As if another computer added a client. */
  async addClientElsewhere(year: string, client: string, serial: string, billNo = '') {
    const rec: ClientYear = { v: 1, id: `other${serial}`, name: client, serial, billNo, bills: [] };
    await this.ws.vault.write(recordPath(year, rec.id), encodeRecord(rec));
  }

  /** As if another computer saved a bill. */
  async writeBill(year: string, client: string, type: string, name: string, lines: string[]) {
    await this.ws.writeBill(year, client, type, name, rowsFromLines(lines, year));
  }

  /** Everything on disk (names and contents), to check nothing is readable. */
  everything(): string {
    const parts: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        parts.push(e.name);
        if (e.isDirectory()) walk(p);
        else parts.push(readFileSync(p).toString('latin1'), readFileSync(p).toString('utf8'));
      }
    };
    walk(this.dir);
    return parts.join('\n');
  }
}

/**
 * A copy of a desktop fixture (after `seed` changes it), moved to the web format
 * the way the app does it, with the recovery code saved. Password: puja.
 */
export async function dataCopy(seed?: (desktopDir: string) => void, fixture = 'java-sample'): Promise<Data> {
  const src = programCopy(fixture);
  seed?.(src);
  const dest = mkdtempSync(join(tmpdir(), 'usw-e2e-web-'));
  const r = await migrateDesktop({ program: new NodeDir(src), data: new NodeDir(join(src, 'data')) }, new NodeDir(dest), FAST);
  if (!r.report.ok) throw new Error(`migration of the test data failed: ${JSON.stringify(r.report.differences)}`);
  await r.books.setRecoveryCode(r.recoveryCode);
  return new Data(dest, r.books, r.recoveryCode);
}

/** The same data as another computer saw it at `minutesAgo` (to make earlier versions). */
export function earlier(data: Data, minutesAgo: number): WebBooks {
  return (data as unknown as { books: WebBooks }).books.as({ computer: { id: 'office', name: 'Office PC' }, now: () => Date.now() - minutesAgo * 60_000 });
}
