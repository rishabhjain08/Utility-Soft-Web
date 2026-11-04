import { BillType } from '../core/config';
import { Client } from '../core/webstore';
import { dateString } from '../core/util';
import { Session } from './session';
import { PrintableBill, printJob } from './print';
import { busy, promptDialog, toast } from './ui';

/** Asks for the date printed on bills (Java: "Change Date"); null when cancelled. */
export function askPrintDate(): Promise<string | null> {
  return promptDialog({ title: 'Print bills', label: 'Date to be printed', value: dateString(new Date()), ok: 'Print…' });
}

/** Bills of the given clients (all bill types, or only `types`, or only one bill). */
export async function collectBills(
  s: Session,
  year: string,
  clients: Client[],
  only?: { types?: BillType[]; bill?: string },
): Promise<(PrintableBill & { client: string; folder: string })[]> {
  const out: (PrintableBill & { client: string; folder: string })[] = [];
  const types = only?.types ?? s.types;
  for (const c of clients) {
    for (const t of types) {
      const names = only?.bill !== undefined ? [only.bill] : await s.ws.bills(year, c.name, t.folder);
      for (const b of names) {
        const rows = await s.ws.readBill(year, c.name, t.folder, b);
        out.push({ billName: b, serial: c.serial, billNo: c.billNo, rows, client: c.name, folder: t.folder });
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
  if (bills.length === 0) return toast('There are no bills to print.', 'info');
  await printJob({ kind: 'bills', bills, letterhead: s.letterhead, date });
  // Kept for the payments page ("printed on").
  await s.ws.markPrinted(year, bills.map((b) => ({ client: b.client, folder: b.folder, bill: b.billName })), date).catch(() => undefined);
}

export async function printIndex(s: Session, year: string): Promise<void> {
  const clients = await busy('Preparing index…', () => s.ws.clients(year));
  if (!clients) return;
  const titles = (s.letterhead?.indexTitles ?? []).map((t) => t.split('##').join(year));
  if (clients.length === 0) return toast('There are no clients in this year to print.', 'info');
  await printJob({ kind: 'index', sheet: { titles, rows: clients.map((c) => ({ serial: c.serial, name: c.name, billNo: c.billNo })) } });
}
