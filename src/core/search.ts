// Searching every year: client names, bill names and the text of bill rows.

import { expandYear } from './bill';
import { WebBooks, amountText } from './webstore';

export interface Hit {
  year: string;
  client: string;
  /** Set when the hit is in a bill. */
  folder?: string;
  tab?: string;
  bill?: string;
  /** What matched: the client's name, the bill's name, or a row of the bill. */
  what: 'client' | 'bill' | 'row';
  text: string;
}

/** Up to `limit` hits, newest year first. */
export async function searchAll(web: WebBooks, query: string, limit = 200): Promise<{ hits: Hit[]; more: boolean }> {
  const q = query.trim().toLowerCase();
  const hits: Hit[] = [];
  if (q.length < 2) return { hits, more: false };
  const types = await web.billTypes();
  const tab = (folder: string) => types.find((t) => t.folder === folder)?.tab ?? folder;
  for (const year of (await web.years()).reverse()) {
    for (const r of await web.records(year)) {
      if (r.name.toLowerCase().includes(q)) hits.push({ year, client: r.name, what: 'client', text: r.name });
      for (const b of r.bills) {
        const where = { year, client: r.name, folder: b.type, tab: tab(b.type), bill: b.name };
        if (b.name.toLowerCase().includes(q)) hits.push({ ...where, what: 'bill', text: b.name });
        for (const g of b.groups) {
          for (const row of g.rows) {
            const text = expandYear(row.text, year);
            if (text.toLowerCase().includes(q)) hits.push({ ...where, what: 'row', text: `${text}${amountText(row) ? ` — ${amountText(row)}` : ''}` });
          }
        }
      }
      if (hits.length > limit) return { hits: hits.slice(0, limit), more: true };
    }
  }
  return { hits, more: false };
}
