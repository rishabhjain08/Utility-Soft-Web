// Live preview of the letterhead on a sample bill and index sheet, with made-up content.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Letterhead } from '../core/config';
import { dateString } from '../core/util';
import { financialYearOf } from '../core/years';
import { BillCopy, IndexSheetView, PrintableBill } from './print';

export type LetterheadPart = 'address' | 'firm' | 'titles';

/** Shown in grey where a block is still empty, so it is clear where it goes. */
export const SAMPLE = {
  address: ['12, Station Road', 'Jaipur 302001', 'Phone 0141 2345678'],
  firm: ['For Sharma & Associates', '', 'Chartered Accountants'],
  titles: ['Index of Bills', 'Financial Year ##'],
  // (## stands for the year shown.)
};

const YEAR = financialYearOf(new Date());

const SAMPLE_BILL: PrintableBill = {
  billName: 'RAMESH KUMAR',
  serial: '12',
  billNo: '145',
  rows: [
    { desc: `Fee for Tax Audit for the Assessment Year ${YEAR}`, amount: '25000' },
    { desc: `Fee for IT Return for the Assessment Year ${YEAR}`, amount: '3500' },
    { desc: 'Expenses', amount: '500' },
  ],
};

const SAMPLE_CLIENTS = [
  { serial: '1', name: 'AGARWAL TRADERS', billNo: '134' },
  { serial: '2', name: 'GUPTA & SONS', billNo: '135' },
  { serial: '3', name: 'MEHTA BROTHERS', billNo: '' },
  { serial: '3A', name: 'RAMESH KUMAR', billNo: '145' },
];

// A4 width at 96 px/inch.
const PAGE_WIDTH = (210 / 25.4) * 96;

export function LetterheadPreview({ letterhead, focus, year = YEAR }: { letterhead: Letterhead; focus: LetterheadPart | null; year?: string }) {
  const [view, setView] = useState<'bill' | 'index'>('bill');
  const [shownFor, setShownFor] = useState<LetterheadPart | null>(null);
  // Follow the field being typed in: the titles are on the index sheet, the rest on bills.
  if (focus !== shownFor) {
    setShownFor(focus);
    if (focus) setView(focus === 'titles' ? 'index' : 'bill');
  }

  const box = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.5);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setZoom(Math.min(1, inner / PAGE_WIDTH));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const empty = (l: string[]) => l.every((x) => x.trim() === '');
  const ph = { address: empty(letterhead.firmAddress), firm: empty(letterhead.firmName), titles: empty(letterhead.indexTitles) };
  const shown: Letterhead = {
    firmAddress: ph.address ? SAMPLE.address : letterhead.firmAddress,
    firmName: ph.firm ? SAMPLE.firm : letterhead.firmName,
    indexTitles: letterhead.indexTitles,
  };
  const titles = (ph.titles ? SAMPLE.titles : letterhead.indexTitles).map((t) => t.split('##').join(year));
  const cls = [
    'lp',
    focus ? `hl-${focus}` : '',
    ph.address ? 'ph-address' : '',
    ph.firm ? 'ph-firm' : '',
    ph.titles ? 'ph-titles' : '',
  ].join(' ');

  return (
    <section class="lp-wrap" aria-label="Preview">
      <div class="lp-head">
        <span class="lp-label">Preview</span>
        <div class="seg" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'bill'} class={view === 'bill' ? 'active' : ''} onClick={() => setView('bill')}>
            Bill
          </button>
          <button type="button" role="tab" aria-selected={view === 'index'} class={view === 'index' ? 'active' : ''} onClick={() => setView('index')}>
            Index sheet
          </button>
        </div>
      </div>
      <div class="lp-box" ref={box}>
        <div class={cls} style={{ zoom }} aria-hidden="true">
          <div class="page lp-page">
            {view === 'bill' ? (
              <BillCopy bill={SAMPLE_BILL} letterhead={shown} date={dateString(new Date())} />
            ) : (
              <IndexSheetView sheet={{ titles, rows: SAMPLE_CLIENTS }} />
            )}
          </div>
        </div>
      </div>
      <p class="hint">
        {view === 'bill'
          ? 'Sample bill with made-up content. Each bill is printed twice (original and duplicate).'
          : 'Sample index sheet with made-up clients.'}
        {(ph.address || ph.firm || ph.titles) && ' Grey text shows where your lines will go.'}
      </p>
    </section>
  );
}
