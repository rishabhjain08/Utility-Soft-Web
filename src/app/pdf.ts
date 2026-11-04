// A bill as a PDF file (A4, one copy), laid out like the printed bill (print.tsx),
// in Times like the printout. For emailing or sending; printing still goes
// through Chrome's print dialog.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { BillRow, amountValue, isSeparator } from '../core/bill';
import { Letterhead } from '../core/config';
import { amountInWords, formatAmount, groupIndian } from '../core/money';
import { PrintableBill } from './print';

const MM = 72 / 25.4;
const PAGE: [number, number] = [210 * MM, 297 * MM];
const LEFT = 15 * MM;
const WIDTH = 180 * MM;
const TOP = 297 * MM - 15 * MM;
const BOTTOM = 15 * MM;
const BLACK = rgb(0, 0, 0);

/** Characters Times can show in a PDF (WinAnsi); others become "?", and are reported. */
function printable(text: string, font: PDFFont, missing: Set<string>): string {
  let out = '';
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      missing.add(ch);
      out += '?';
    }
  }
  return out;
}

/** Splits text into lines no wider than `width`. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line + w;
    if (font.widthOfTextAtSize(next.trimEnd(), size) <= width || line.trim() === '') line = next;
    else {
      lines.push(line.trimEnd());
      line = w.trimStart();
    }
  }
  lines.push(line.trimEnd());
  return lines;
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
    out[out.length - 1].rows.push(r);
    out[out.length - 1].total += amountValue(r.amount);
    total += amountValue(r.amount);
  }
  return { groups: out, total };
}

export async function billPdf(bill: PrintableBill, letterhead: Letterhead | null, date: string): Promise<{ bytes: Uint8Array; missing: string[] }> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${bill.billName} — Bill`);
  doc.setCreator('Utility Soft');
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const missing = new Set<string>();
  let page: PDFPage = doc.addPage(PAGE);
  let y = TOP;

  const room = (h: number) => {
    if (y - h < BOTTOM) {
      page = doc.addPage(PAGE);
      y = TOP;
    }
  };
  const text = (s: string, x: number, size: number, font: PDFFont, align: 'left' | 'right' | 'center' = 'left') => {
    const t = printable(s, font, missing);
    const w = font.widthOfTextAtSize(t, size);
    const at = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    page.drawText(t, { x: at, y, size, font, color: BLACK });
    return w;
  };
  const line = (x1: number, x2: number, at: number, dash = false) =>
    page.drawLine({ start: { x: x1, y: at }, end: { x: x2, y: at }, thickness: 0.7, color: BLACK, ...(dash ? { dashArray: [4, 3] } : {}) });

  // S.No. and Bill No., top right.
  y -= 12;
  text(`S.No.: ${bill.serial}`, LEFT + WIDTH, 12, regular, 'right');
  y -= 15;
  text(`Bill No.: ${bill.billNo}`, LEFT + WIDTH, 12, regular, 'right');

  // Title and "Bill".
  y -= 30;
  for (const l of wrap(printable(bill.billName, bold, missing), bold, 18, WIDTH)) {
    text(l, LEFT + WIDTH / 2, 18, bold, 'center');
    y -= 22;
  }
  const w = text('Bill', LEFT + WIDTH / 2, 18, bold, 'center');
  line(LEFT + WIDTH / 2 - w / 2, LEFT + WIDTH / 2 + w / 2, y - 4, true);
  y -= 30;

  // Rows: with groups, each group's total stands beside its last row.
  const { groups: gs, total } = groups(bill.rows);
  const grouped = gs.length > 1;
  const descWidth = WIDTH * (grouped ? 0.62 : 0.75) - 16;
  const amtRight = LEFT + WIDTH * (grouped ? 0.8 : 1);
  const subRight = LEFT + WIDTH;
  gs.forEach((g, gi) => {
    g.rows.forEach((r, ri) => {
      const lines = wrap(printable(r.desc, regular, missing), regular, 12, descWidth);
      room(lines.length * 15.6);
      lines.forEach((l, li) => {
        text(l, LEFT, 12, regular);
        if (li < lines.length - 1) y -= 15.6;
      });
      const amt = formatAmount(r.amount);
      const aw = text(amt, amtRight, 12, regular, 'right');
      const last = ri === g.rows.length - 1;
      if (grouped && last) {
        line(amtRight - aw, amtRight, y - 2);
        text(formatAmount(g.total), subRight, 12, regular, 'right');
      }
      y -= 15.6;
    });
    if (grouped && gi < gs.length - 1) y -= 12;
  });

  // Total, in words and figures.
  y -= 22;
  room(30);
  const sum = `${groupIndian(total)}/-`;
  const sw = bold.widthOfTextAtSize(sum, 12);
  const words = wrap(`(Rs. ${amountInWords(total)} only.)`, bold, 12, WIDTH - sw - 40);
  text(sum, LEFT + WIDTH, 12, bold, 'right');
  line(LEFT + WIDTH - sw - 30, LEFT + WIDTH, y + 13);
  line(LEFT + WIDTH - sw - 30, LEFT + WIDTH, y - 4);
  for (const l of words) {
    text(l, LEFT, 12, bold);
    y -= 15.6;
  }

  // Address and date on the left, firm and signature on the right.
  const address = [...(letterhead?.firmAddress ?? []), `Date : ${date}`];
  const firm = letterhead?.firmName ?? [];
  y -= 30;
  room(Math.max(address.length, firm.length + 1) * 18);
  const start = y;
  for (const l of address) {
    text(l, LEFT, 14, bold);
    y -= 18;
  }
  y = start;
  line(LEFT + WIDTH * 0.55, LEFT + WIDTH, y + 14);
  for (const l of firm) {
    text(l, LEFT + WIDTH, 14, bold, 'right');
    y -= 18;
  }

  return { bytes: await doc.save(), missing: [...missing] };
}

/** A file name for the bill's PDF. */
export function pdfName(client: string, bill: string, billNo: string): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim();
  return `${safe(client)} - ${safe(bill)}${billNo ? ` - Bill ${safe(billNo)}` : ''}.pdf`;
}
