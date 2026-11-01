// Indian-style amount formatting used on printed bills: 1,23,456/-

/** Groups digits the Indian way: 12,34,567. */
export function groupIndian(n: number): string {
  const neg = n < 0;
  const s = String(Math.abs(Math.trunc(n)));
  let out = s;
  if (s.length > 3) {
    const head = s.slice(0, -3);
    const tail = s.slice(-3);
    const parts: string[] = [];
    let i = head.length;
    while (i > 0) {
      parts.unshift(head.slice(Math.max(0, i - 2), i));
      i -= 2;
    }
    out = `${parts.join(',')},${tail}`;
  }
  return (neg ? '-' : '') + out;
}

/** "1,23,456/-" for a stored amount string; '' for an empty amount. */
export function formatAmount(amount: string | number): string {
  if (typeof amount === 'number') return `${groupIndian(amount)}/-`;
  const t = amount.trim();
  if (t === '') return '';
  if (!/^[+-]?\d+$/.test(t)) return t;
  return `${groupIndian(Number(t))}/-`;
}

const ONES = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const TEENS = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n === 0) return '';
  const t = Math.floor(n / 10);
  const o = n % 10;
  if (t === 0) return ONES[o - 1];
  if (t === 1) return TEENS[o];
  return TENS[t - 2] + (o > 0 ? ` ${ONES[o - 1]}` : '');
}

/** Amount in words using the Indian system (Thousand, Lakh, Crore). */
export function amountInWords(num: number): string {
  num = Math.trunc(num);
  if (num === 0) return 'Zero';
  if (num < 0) return `Minus ${amountInWords(-num)}`;
  if (num >= 1e9) {
    // Crores beyond 99: say the crore count in words as well.
    const crores = Math.floor(num / 1e7);
    const rest = num % 1e7;
    return `${amountInWords(crores)} Crore${rest ? ` ${amountInWords(rest)}` : ''}`;
  }
  let resp = twoDigits(num % 100);
  num = Math.floor(num / 100);
  const hundreds = twoDigits(num % 10);
  resp = hundreds + (hundreds ? ' Hundred' : '') + (hundreds && resp ? ' and ' : '') + resp;
  num = Math.floor(num / 10);
  const units = ['Thousand', 'Lakh', 'Crore'];
  let idx = 0;
  while (num > 0) {
    let part = twoDigits(num % 100);
    part += part ? ` ${units[idx]}` : '';
    idx++;
    num = Math.floor(num / 100);
    resp = part + (part && resp ? ' ' : '') + resp;
  }
  return resp;
}
