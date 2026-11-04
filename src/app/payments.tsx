// Payments: what each bill was billed, what was received and what was agreed off
// it, and what is still due — for one bill (in the editor) and across clients.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { LedgerRow, Payment } from '../core/webstore';
import { groupIndian } from '../core/money';
import { compareIgnoreCase } from '../core/sort';
import { Session } from './session';
import { OpenAt } from './search';
import { Modal, attempt, busy, mountDialog, toast } from './ui';

const rs = (n: number) => `${groupIndian(n)}/-`;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const showDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
};

export interface Sums {
  billed: number;
  received: number;
  reduced: number;
  due: number;
}

type Status = 'nothing' | 'due' | 'part' | 'paid';

export function statusOf(x: Sums): Status {
  if (x.billed <= 0) return 'nothing';
  if (x.due <= 0) return 'paid';
  return x.received + x.reduced > 0 ? 'part' : 'due';
}

const STATUS_TEXT: Record<Status, string> = { nothing: 'Nothing billed', due: 'Not paid', part: 'Part paid', paid: 'Paid' };

function StatusBadge({ x }: { x: Sums }) {
  const st = statusOf(x);
  return <span class={`status ${st}`}>{x.due < 0 ? `Paid, ${groupIndian(-x.due)} extra` : STATUS_TEXT[st]}</span>;
}

/** Asks for money received, or for the amount agreed with the client. Resolves when saved. */
export function paymentDialog(o: { kind: Payment['kind']; bill: string; sums: Sums; save: (p: Omit<Payment, 'id'>) => Promise<void> }): Promise<boolean> {
  return mountDialog<boolean>((done) => <PaymentBody o={o} done={done} />);
}

function PaymentBody({ o, done }: { o: Parameters<typeof paymentDialog>[0]; done: (v: boolean) => void }) {
  const received = o.kind === 'received';
  const [date, setDate] = useState(today());
  // Money received: how much. Agreed lower amount: the new price of the whole bill.
  const [amount, setAmount] = useState(String(Math.max(0, received ? o.sums.due : o.sums.billed - o.sums.reduced)));
  const [note, setNote] = useState('');
  const n = Number(amount.replace(/[,\s]/g, ''));
  const valid = /^\d+$/.test(amount.replace(/[,\s]/g, '')) && (received ? n > 0 : n >= 0 && n < o.sums.billed - o.sums.reduced);
  const reduction = o.sums.billed - o.sums.reduced - n;
  const submit = () =>
    valid &&
    busy('Saving…', async () => {
      await o.save({ date, amount: received ? n : reduction, kind: o.kind, note });
      toast(received ? `Recorded ${rs(n)} received.` : `The bill now comes to ${rs(n)} (${rs(reduction)} less).`, 'ok');
      done(true);
    });
  return (
    <Modal
      title={received ? `Money received — ${o.bill}` : `Agreed a lower amount — ${o.bill}`}
      onClose={() => done(false)}
      footer={
        <>
          <button onClick={() => done(false)}>Cancel</button>
          <button class="primary" disabled={!valid} onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <p class="hint">
        Billed {rs(o.sums.billed)}
        {o.sums.reduced > 0 && `, already reduced by ${rs(o.sums.reduced)}`}
        {o.sums.received > 0 && `, received ${rs(o.sums.received)}`}. Due {rs(o.sums.due)}.
      </p>
      <label class="field">
        <span>Date</span>
        <input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
      </label>
      <label class="field">
        <span>{received ? 'Amount received' : 'Amount agreed for the whole bill'}</span>
        <input autoFocus inputMode="numeric" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
      {!received && valid && <p class="hint">Takes {rs(reduction)} off the bill. The bill itself, and its printout, stay as they are.</p>}
      {!valid && amount !== '' && <p class="warn">{received ? 'Type the amount in rupees.' : `Type an amount below ${rs(o.sums.billed - o.sums.reduced)}.`}</p>}
      <label class="field">
        <span>Note (optional)</span>
        <input value={note} placeholder={received ? 'e.g. cheque 123456, cash, UPI' : 'e.g. discount agreed on the phone'} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
      </label>
    </Modal>
  );
}

/** Under the bill in the editor: what is billed, received and due, and buttons to record payments. */
export function PaymentStrip({ s, year, client, folder, bill, billed, payments, onChanged }: {
  s: Session; year: string; client: string; folder: string; bill: string; billed: number; payments: Payment[]; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const received = payments.filter((p) => p.kind === 'received').reduce((t, p) => t + p.amount, 0);
  const reduced = payments.filter((p) => p.kind === 'reduced').reduce((t, p) => t + p.amount, 0);
  const sums = { billed, received, reduced, due: billed - received - reduced };
  const record = (kind: Payment['kind']) =>
    attempt(async () => {
      if (await paymentDialog({ kind, bill, sums, save: (p) => s.ws.addPayment(year, client, folder, bill, p) })) onChanged();
    });
  const remove = (p: Payment) =>
    attempt(async () => {
      await s.ws.removePayment(year, client, folder, bill, p.id);
      toast('Removed.', 'ok');
      onChanged();
    });
  return (
    <div class="pay-strip">
      <span>
        Billed <b>{rs(billed)}</b>
      </span>
      {received > 0 && (
        <span>
          Received <b>{rs(received)}</b>
        </span>
      )}
      {reduced > 0 && (
        <span>
          Reduced <b>{rs(reduced)}</b>
        </span>
      )}
      <span>
        Due <b class={sums.due > 0 ? 'due' : ''}>{rs(Math.max(0, sums.due))}</b>
      </span>
      <StatusBadge x={sums} />
      <span class="grow" />
      {payments.length > 0 && (
        <button class="link" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'} {payments.length} entr{payments.length === 1 ? 'y' : 'ies'}
        </button>
      )}
      <button onClick={() => record('received')} disabled={billed <= 0}>
        Money received…
      </button>
      <button onClick={() => record('reduced')} disabled={billed <= 0 || sums.due <= 0}>
        Agreed a lower amount…
      </button>
      {open && (
        <ul class="pay-list">
          {payments.map((p) => (
            <li key={p.id}>
              <span>{showDate(p.date)}</span>
              <span>{p.kind === 'received' ? 'Received' : 'Reduced by'}</span>
              <b>{rs(p.amount)}</b>
              <span class="hint">{p.note}</span>
              <button class="icon-btn" aria-label={`Remove ${p.kind === 'received' ? 'payment' : 'reduction'} of ${showDate(p.date)}`} title="Remove" onClick={() => remove(p)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- the payments page ----------

type Filter = 'all' | 'due' | 'paid';
type Sort = 'client' | 'due' | 'billed' | 'lastPaid';

export function PaymentsPage({ s, year: initialYear, onOpenAt, onBack }: { s: Session; year: string | null; onOpenAt: (at: OpenAt) => void; onBack: () => void }) {
  const [years, setYears] = useState<string[]>([]);
  const [year, setYear] = useState<string>(initialYear ?? 'all');
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [filter, setFilter] = useState<Filter>('due');
  const [sort, setSort] = useState<Sort>('client');
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    attempt(async () => setYears(await s.ws.years()));
  }, []);
  useEffect(() => {
    attempt(async () => {
      const ys = year === 'all' ? await s.ws.years() : [year];
      const all: LedgerRow[] = [];
      for (const y of ys) all.push(...(await s.ws.ledger(y)));
      setRows(all);
    });
  }, [year, tick]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (document.querySelector('.backdrop')) return;
      if (e.key === 'Escape' || (e.altKey && e.key === 'ArrowLeft')) {
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    let list = (rows ?? []).filter((r) => r.billed > 0 || r.received > 0);
    if (t) list = list.filter((r) => r.client.toLowerCase().includes(t) || r.bill.toLowerCase().includes(t) || r.billNo.toLowerCase().includes(t));
    if (filter === 'due') list = list.filter((r) => r.due > 0);
    if (filter === 'paid') list = list.filter((r) => r.due <= 0);
    const by: Record<Sort, (a: LedgerRow, b: LedgerRow) => number> = {
      client: (a, b) => a.year.localeCompare(b.year) || compareIgnoreCase(a.client, b.client) || compareIgnoreCase(a.bill, b.bill),
      due: (a, b) => b.due - a.due,
      billed: (a, b) => b.billed - a.billed,
      lastPaid: (a, b) => (b.lastPaid ?? '').localeCompare(a.lastPaid ?? ''),
    };
    return [...list].sort(by[sort]);
  }, [rows, filter, sort, q]);

  const all = (rows ?? []).filter((r) => r.billed > 0 || r.received > 0);
  const sum = (k: 'billed' | 'received' | 'reduced') => all.reduce((t, r) => t + r[k], 0);
  const due = all.reduce((t, r) => t + Math.max(0, r.due), 0);
  const dueBills = all.filter((r) => r.due > 0);
  const dueClients = new Set(dueBills.map((r) => `${r.year} ${r.client}`)).size;

  const record = (r: LedgerRow) =>
    attempt(async () => {
      if (await paymentDialog({ kind: 'received', bill: `${r.client} › ${r.bill}`, sums: r, save: (p) => s.ws.addPayment(r.year, r.client, r.folder, r.bill, p) })) setTick((t) => t + 1);
    });

  const head = (label: string, key: Sort, cls = '') => (
    <th class={`${cls} sortable ${sort === key ? 'sorted' : ''}`} aria-sort={sort === key ? 'descending' : 'none'}>
      <button class="link" onClick={() => setSort(key)}>
        {label}
      </button>
    </th>
  );

  return (
    <div class="screen payments">
      <header class="topbar">
        <button onClick={onBack} title="Back to the clients (Esc)">
          ← Back
        </button>
        <div class="brand">Payments</div>
        <select aria-label="Year" value={year} onChange={(e) => setYear((e.target as HTMLSelectElement).value)}>
          <option value="all">All years</option>
          {years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
        <div class="search">
          <input type="search" placeholder="Client, bill or Bill No." aria-label="Search payments" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        <div class="seg" role="tablist" aria-label="Show">
          {(
            [
              ['due', 'Due'],
              ['paid', 'Paid'],
              ['all', 'All'],
            ] as [Filter, string][]
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} class={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <div class="tiles" aria-label="Summary">
        <div class="tile">
          <span>Billed</span>
          <b>{rs(sum('billed'))}</b>
          <small>{all.length} bills</small>
        </div>
        <div class="tile">
          <span>Received</span>
          <b>{rs(sum('received'))}</b>
        </div>
        <div class="tile">
          <span>Reduced by agreement</span>
          <b>{rs(sum('reduced'))}</b>
        </div>
        <div class="tile due">
          <span>Due</span>
          <b>{rs(due)}</b>
          <small>
            {dueBills.length} bill{dueBills.length === 1 ? '' : 's'} of {dueClients} client{dueClients === 1 ? '' : 's'}
          </small>
        </div>
      </div>

      <div class="table-wrap">
        {rows === null ? (
          <div class="loading">Loading…</div>
        ) : shown.length === 0 ? (
          <div class="empty">
            <p>{filter === 'due' ? 'Nothing is due.' : 'No bills here.'}</p>
          </div>
        ) : (
          <table class="ledger">
            <thead>
              <tr>
                {year === 'all' && <th>Year</th>}
                <th class="sno">S.No.</th>
                {head('Client', 'client')}
                <th>Bill</th>
                <th>Bill No.</th>
                {head('Billed', 'billed', 'money')}
                <th class="money">Received</th>
                <th class="money">Reduced</th>
                {head('Due', 'due', 'money')}
                {head('Last paid', 'lastPaid')}
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.year}|${r.client}|${r.folder}|${r.bill}`}>
                  {year === 'all' && <td>{r.year}</td>}
                  <td class="sno">{r.serial}</td>
                  <td>
                    <button class="link" title="Open the client" onClick={() => onOpenAt({ year: r.year, client: r.client })}>
                      {r.client}
                    </button>
                  </td>
                  <td>
                    <button class="link" title="Open this bill" onClick={() => onOpenAt({ year: r.year, client: r.client, folder: r.folder, bill: r.bill })}>
                      {r.tab} › {r.bill}
                    </button>
                  </td>
                  <td>{r.billNo}</td>
                  <td class="money">{groupIndian(r.billed)}</td>
                  <td class="money">{r.received ? groupIndian(r.received) : ''}</td>
                  <td class="money">{r.reduced ? groupIndian(r.reduced) : ''}</td>
                  <td class={`money ${r.due > 0 ? 'due' : ''}`}>{r.due > 0 ? groupIndian(r.due) : ''}</td>
                  <td>{r.lastPaid ? showDate(r.lastPaid) : ''}</td>
                  <td>
                    <StatusBadge x={r} />
                  </td>
                  <td>
                    {r.due > 0 && (
                      <button class="small" onClick={() => record(r)}>
                        Received…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={year === 'all' ? 5 : 4}>
                  {shown.length} bill{shown.length === 1 ? '' : 's'} shown
                </td>
                <td class="money">{groupIndian(shown.reduce((t, r) => t + r.billed, 0))}</td>
                <td class="money">{groupIndian(shown.reduce((t, r) => t + r.received, 0))}</td>
                <td class="money">{groupIndian(shown.reduce((t, r) => t + r.reduced, 0))}</td>
                <td class="money">{groupIndian(shown.reduce((t, r) => t + Math.max(0, r.due), 0))}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
