// Print preview and printing (A4) of bills and of the index sheet.
// Each bill is printed twice (original + duplicate): on the same page when two
// copies fit, otherwise on separate pages — as the Java program did.

import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { BillRow, isSeparator } from '../core/bill';
import { Letterhead } from '../core/config';
import { amountInWords, formatAmount, groupIndian } from '../core/money';
import { amountValue } from '../core/bill';

export interface PrintableBill {
  billName: string;
  serial: string;
  billNo: string;
  rows: BillRow[];
}

export interface IndexSheet {
  titles: string[];
  rows: { serial: string; name: string; billNo: string }[];
}

interface Group {
  rows: BillRow[];
  total: number;
}

function groups(rows: BillRow[]): { groups: Group[]; total: number } {
  const out: Group[] = [{ rows: [], total: 0 }];
  let total = 0;
  for (const r of rows) {
    if (isSeparator(r)) {
      out.push({ rows: [], total: 0 });
      continue;
    }
    if (r.desc.trim() === '' && r.amount.trim() === '') continue;
    const g = out[out.length - 1];
    g.rows.push(r);
    g.total += amountValue(r.amount);
    total += amountValue(r.amount);
  }
  return { groups: out, total };
}

function BillCopy({ bill, letterhead, date }: { bill: PrintableBill; letterhead: Letterhead | null; date: string }) {
  const { groups: gs, total } = groups(bill.rows);
  const grouped = gs.length > 1;
  const name = letterhead?.firmName ?? [];
  const address = letterhead?.firmAddress ?? [];
  return (
    <div class="bill-copy">
      <div class="bc-meta">
        <div>S.No.: {bill.serial}</div>
        <div>Bill No.: {bill.billNo}</div>
      </div>
      <div class="bc-title">{bill.billName}</div>
      <div class="bc-bill">Bill</div>
      <table class={`bc-rows ${grouped ? 'grouped' : ''}`}>
        <tbody>
          {gs.map((g, gi) => [
            ...g.rows.map((r, ri) => (
              <tr key={`${gi}-${ri}`} class={grouped && ri === g.rows.length - 1 ? 'last-in-group' : ''}>
                <td class="bc-desc">{r.desc}</td>
                <td class="bc-amt">{formatAmount(r.amount)}</td>
                {grouped && <td class="bc-sub">{ri === g.rows.length - 1 ? formatAmount(g.total) : ''}</td>}
              </tr>
            )),
            grouped && gi < gs.length - 1 ? (
              <tr key={`${gi}-gap`} class="gap">
                <td colSpan={3} />
              </tr>
            ) : null,
          ])}
        </tbody>
      </table>
      <div class="bc-total">
        <span class="bc-words">(Rs. {amountInWords(total)} only.)</span>
        <span class="bc-sum">{groupIndian(total)}/-</span>
      </div>
      <div class="bc-foot">
        <div class="bc-address">
          {address.map((l, i) => (
            <div key={i}>{l || ' '}</div>
          ))}
          <div>Date : {date}</div>
        </div>
        <div class="bc-firm">
          <div class="bc-sign" />
          {name.map((l, i) => (
            <div key={i}>{l || ' '}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function IndexSheetView({ sheet }: { sheet: IndexSheet }) {
  return (
    <div class="index-sheet">
      {sheet.titles
        .filter((t) => t.trim() !== '')
        .map((t, i) => (
          <div key={i} class="ix-title">
            {t}
          </div>
        ))}
      <table class="ix-table">
        <thead>
          <tr>
            <th class="ix-sno">S.No.</th>
            <th>Name of Client</th>
            <th class="ix-billno">Bill No.</th>
            <th class="ix-remarks">Remarks</th>
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((r, i) => (
            <tr key={i}>
              <td class="ix-sno">{r.serial}</td>
              <td>{r.name}</td>
              <td class="ix-billno">{r.billNo}</td>
              <td class="ix-remarks" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A4 printable area at 96 px/inch with the @page margins in styles.css (12mm x 15mm).
const MM = 96 / 25.4;
const PAGE_CONTENT_HEIGHT = (297 - 24) * MM;

/** Lays out bill copies on pages: two per page when they fit. */
function BillPages({ bills, letterhead, date, onReady }: { bills: PrintableBill[]; letterhead: Letterhead | null; date: string; onReady: () => void }) {
  const measure = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<number[] | null>(null);
  useLayoutEffect(() => {
    const el = measure.current;
    if (!el) return;
    setHeights(Array.from(el.children).map((c) => (c as HTMLElement).getBoundingClientRect().height));
  }, [bills]);
  useLayoutEffect(() => {
    if (heights) onReady();
  }, [heights]);

  if (!heights) {
    return (
      <div class="print-measure" ref={measure}>
        {bills.map((b, i) => (
          <BillCopy key={i} bill={b} letterhead={letterhead} date={date} />
        ))}
      </div>
    );
  }
  const gapForTwo = 12 * MM;
  return (
    <>
      {bills.map((b, i) => {
        const fitsTwo = heights[i] * 2 + gapForTwo <= PAGE_CONTENT_HEIGHT;
        return fitsTwo ? (
          <div key={i} class="page two-up">
            <BillCopy bill={b} letterhead={letterhead} date={date} />
            <div class="cut-line" />
            <BillCopy bill={b} letterhead={letterhead} date={date} />
          </div>
        ) : (
          [0, 1].map((k) => (
            <div key={`${i}-${k}`} class="page">
              <BillCopy bill={b} letterhead={letterhead} date={date} />
            </div>
          ))
        );
      })}
    </>
  );
}

export type PrintJob = { kind: 'bills'; bills: PrintableBill[]; letterhead: Letterhead | null; date: string } | { kind: 'index'; sheet: IndexSheet };

/** Lays the pages out off screen (bills need measuring) and reports when ready. */
function PrintStage({ job, onReady }: { job: PrintJob; onReady: () => void }) {
  useLayoutEffect(() => {
    if (job.kind === 'index') onReady();
  }, []);
  return (
    <div class="print-pages">
      {job.kind === 'bills' ? (
        <BillPages bills={job.bills} letterhead={job.letterhead} date={job.date} onReady={onReady} />
      ) : (
        <div class="page flow">
          <IndexSheetView sheet={job.sheet} />
        </div>
      )}
    </div>
  );
}

/**
 * Prints through Chrome's own print dialog (with its preview, printer choice and
 * "Save as PDF"). Only the prepared pages are printed.
 */
export function printJob(job: PrintJob): Promise<void> {
  return new Promise((resolve) => {
    const stage = document.createElement('div');
    stage.className = 'print-stage';
    document.body.appendChild(stage);
    let started = false;
    const ready = () => {
      if (started) return;
      started = true;
      // Wait one frame so the measured layout is in the DOM.
      requestAnimationFrame(() => {
        const root = document.getElementById('print-root')!;
        const pages = stage.querySelector('.print-pages');
        root.innerHTML = '';
        if (pages) root.appendChild(pages.cloneNode(true));
        render(null, stage);
        stage.remove();
        document.body.classList.add('printing');
        try {
          window.print();
        } finally {
          document.body.classList.remove('printing');
          root.innerHTML = '';
          resolve();
        }
      });
    };
    render(<PrintStage job={job} onReady={ready} />, stage);
  });
}
