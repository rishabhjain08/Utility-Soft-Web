import { BillType } from '../core/config';
import { Client, dateString } from '../core/workspace';
import { Session } from './session';
import { PrintableBill, showPrintPreview } from './print';
import { busy, promptDialog } from './ui';

/** Asks for the date printed on bills (Java: "Change Date"); null when cancelled. */
export function askPrintDate(): Promise<string | null> {
  return promptDialog({ title: 'Print bills', label: 'Date to be printed', value: dateString(new Date()), ok: 'Preview' });
}

/** Bills of the given clients (all bill types, or only `types`, or only one bill). */
export async function collectBills(
  s: Session,
  year: string,
  clients: Client[],
  only?: { types?: BillType[]; bill?: string },
): Promise<PrintableBill[]> {
  const out: PrintableBill[] = [];
  const types = only?.types ?? s.types;
  for (const c of clients) {
    for (const t of types) {
      const names = only?.bill !== undefined ? [only.bill] : await s.ws.bills(year, c.name, t.folder);
      for (const b of names) {
        const rows = await s.ws.readBill(year, c.name, t.folder, b);
        out.push({ billName: b, serial: c.serial, billNo: c.billNo, rows });
      }
    }
  }
  return out;
}

export async function printBills(s: Session, year: string, clients: Client[], only?: { types?: BillType[]; bill?: string }): Promise<void> {
  const date = await askPrintDate();
  if (date === null) return;
  const bills = await busy('Preparing bills…', () => collectBills(s, year, clients, only));
  if (!bills) return;
  await showPrintPreview({ kind: 'bills', bills, letterhead: s.letterhead, date });
}

export async function printIndex(s: Session, year: string): Promise<void> {
  const clients = await busy('Preparing index…', () => s.ws.clients(year));
  if (!clients) return;
  const titles = (s.letterhead?.indexTitles ?? []).map((t) => t.split('##').join(year));
  await showPrintPreview({ kind: 'index', sheet: { titles, rows: clients.map((c) => ({ serial: c.serial, name: c.name, billNo: c.billNo })) } });
}
