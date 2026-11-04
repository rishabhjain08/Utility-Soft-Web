import { describe, expect, it } from 'vitest';
import {
  decodeCipherLines, decodeCipherValue, decodeBytes, encodeCipherLines, encodeCipherValue, encodePlain, sanitize, splitLines,
} from '../src/core/codec';
import { letterheadFromImpinfo, parseBillTypes, dropdownItems, isRelativePath } from '../src/core/config';
import { planInsert, planRemove, planRename, samePlan, SerialEntry } from '../src/core/serial';
import { historyColumns, linesFromRows, mergeHistory, protectForJava, rowsFromLines, isValidAmount, rowNumbers } from '../src/core/bill';
import { amountInWords, formatAmount, groupIndian } from '../src/core/money';
import { compareIgnoreCase, sortStrings } from '../src/core/sort';
import { financialYearOf, nextYear, previousYear, previousYears } from '../src/core/years';
import { backupFolderName } from '../src/core/util';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('codec', () => {
  it('decodes the sample files shipped with the Java program', () => {
    expect(decodeCipherValue(bytes('fk`W'))).toBe('puja');
    expect(decodeCipherValue(bytes('90%Ki[hi%Y_%:[iajef'))).toBe('C:/Users/ci/Desktop');
    // Lines may end with LF only.
    expect(decodeCipherLines(bytes('fee`W"(&\n'))).toEqual(['pooja,20']);
  });

  it('round-trips lines with CRLF terminators', () => {
    const lines = ['Fee for IT Return for the Assessment Year ##,1500', 'Expenses,', 'New Name,New'];
    const enc = encodeCipherLines(lines);
    expect(new TextDecoder().decode(enc).endsWith('\r\n')).toBe(true);
    expect(decodeCipherLines(enc)).toEqual(lines);
  });

  it('writes single values without a terminator', () => {
    expect(new TextDecoder().decode(encodeCipherValue('12A'))).toBe("'(7");
  });

  it('splits lines like java.util.Scanner', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\r\n')).toEqual(['a']);
    expect(splitLines('a\r\n\r\n')).toEqual(['a', '']);
    expect(splitLines('a\rb\nc\u2028d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('falls back to windows-1252 for bytes that are not UTF-8', () => {
    expect(decodeBytes(new Uint8Array([0x41, 0xe9]))).toBe('Aé');
    expect(Array.from(encodePlain('Aé'))).toEqual([0x41, 0xe9]);
    expect(Array.from(encodePlain('A€'))).toEqual([0x41, 0x80]);
  });

  it('removes characters Java cannot store', () => {
    expect(sanitize('a\tb\nc\u0001d\u2032')).toBe("a b cd'");
    expect(sanitize('x😀y')).toBe('xy');
  });
});

describe('config', () => {
  it('parses impinfo.txt', () => {
    expect(parseBillTypes('(Audit^Audit)(Vat^Vat)(Tax^Tax)(Others^Others)')).toEqual([
      { folder: 'Audit', tab: 'Audit' }, { folder: 'Vat', tab: 'Vat' }, { folder: 'Tax', tab: 'Tax' }, { folder: 'Others', tab: 'Others' },
    ]);
    const lh = letterheadFromImpinfo(['(A^A)', '~For X%~CA%', '~Road%', '%$T1 ##%$%$T3%$'])!;
    expect(lh.firmName).toEqual(['For X', 'CA']);
    expect(lh.firmAddress).toEqual(['Road']);
    expect(lh.indexTitles).toEqual(['T1 ##', '', 'T3']);
    expect(letterheadFromImpinfo(['(A^A)'])).toBeNull();
  });

  it('reads drop-down lists case-insensitively', () => {
    const lines = ['Audit^Income tax for the Assessment Year ##', 'Vat^a^b^^c'];
    expect(dropdownItems(lines, 'AUDIT')).toEqual(['Income tax for the Assessment Year ##']);
    expect(dropdownItems(lines, 'Vat')).toEqual(['a', 'b', 'c']);
    expect(dropdownItems(lines, 'Tax')).toEqual([]);
  });

  it('recognises paths Java resolves relative to the program folder', () => {
    expect(isRelativePath('data2')).toBe(true);
    expect(isRelativePath('C:\\data')).toBe(false);
    expect(isRelativePath('\\\\server\\share')).toBe(false);
    expect(isRelativePath('/home/x')).toBe(false);
  });
});

describe('years', () => {
  it('steps years with two-digit padding', () => {
    expect(nextYear('06-07')).toBe('07-08');
    expect(nextYear('09-10')).toBe('10-11');
    expect(previousYear('00-01')).toBeNull();
    expect(previousYears('06-07', 3)).toEqual(['05-06', '04-05', '03-04']);
    expect(previousYears('01-02', 3)).toEqual(['00-01']);
    expect(financialYearOf(new Date(2026, 2, 31))).toBe('25-26');
    expect(financialYearOf(new Date(2026, 3, 1))).toBe('26-27');
  });
});

describe('sorting', () => {
  it('matches Java compareToIgnoreCase', () => {
    expect(compareIgnoreCase('PREM', 'PREM CHAND')).toBeLessThan(0);
    expect(compareIgnoreCase('abc', 'ABD')).toBeLessThan(0);
    expect(compareIgnoreCase('A_B', 'AB')).toBeLessThan(0); // '_' < 'b' after lower-casing, as in Java
    expect(sortStrings(['b', 'A', 'a b', 'C'])).toEqual(['A', 'a b', 'b', 'C']);
  });
});

describe('serial numbers', () => {
  const e = (pairs: [string, string][]): SerialEntry[] => pairs.map(([name, serial]) => ({ name, serial }));
  const base = e([['A', '1'], ['C', '2'], ['E', '3']]);

  it('normal entry shifts the following clients', () => {
    const p = planInsert(base, 'D', false);
    expect(p.serial).toBe('3');
    expect([...p.updates]).toEqual([['E', '4']]);
  });

  it('first position gets 1 and shifts everyone', () => {
    const p = planInsert(base, '0', false);
    expect(p.serial).toBe('1');
    expect([...p.updates]).toEqual([['A', '2'], ['C', '3'], ['E', '4']]);
  });

  it('late entry takes a letter and changes nobody', () => {
    const p = planInsert(base, 'B', true);
    expect(p.serial).toBe('1A');
    expect(p.updates.size).toBe(0);
    const withLetters = e([['A', '1'], ['B', '1A'], ['BB', '1B'], ['C', '2']]);
    expect(planInsert(withLetters, 'BA', true).serial).toBe('1C');
    expect(planInsert(withLetters, 'BC', true).serial).toBe('1C');
  });

  it('normal entry after a lettered one', () => {
    const l = e([['A', '1'], ['B', '1A'], ['C', '2']]);
    const p = planInsert(l, 'BB', false);
    expect(p.serial).toBe('2');
    expect([...p.updates]).toEqual([['C', '3']]);
  });

  it('removing a numbered client renumbers the rest, including lettered ones', () => {
    const l = e([['A', '1'], ['B', '2'], ['B2', '2A'], ['C', '3']]);
    expect([...planRemove(l, 'B')]).toEqual([['B2', '1A'], ['C', '2']]);
    expect(planRemove(l, 'B2').size).toBe(0);
    expect(planRemove(e([['A', '']]), 'A').size).toBe(0);
  });

  it('renaming in place changes nothing either way', () => {
    const l = e([['A', '1'], ['C', '2'], ['E', '3']]);
    for (const keep of [false, true]) {
      const p = planRename(l, 'C', 'D', keep);
      expect(p.serial).toBe('2');
      expect(p.updates.size).toBe(0);
    }
  });

  it('renaming to another place: renumber, or keep everyone else (no shift at the old place)', () => {
    const l = e([['A', '1'], ['C', '2'], ['E', '3'], ['G', '4']]);
    const renumber = planRename(l, 'C', 'F', false);
    expect(renumber.serial).toBe('3');
    expect([...renumber.updates]).toEqual([['E', '2']]);
    const keep = planRename(l, 'C', 'F', true);
    expect(keep.serial).toBe('3A');
    expect(keep.updates.size).toBe(0);
    expect(samePlan(renumber, keep)).toBe(false);
  });

  it('renaming a lettered client in place keeps its letter when keeping numbers', () => {
    const l = e([['A', '1'], ['B', '1A'], ['C', '2']]);
    expect(planRename(l, 'B', 'BB', true)).toEqual({ serial: '1A', updates: new Map() });
    const renumber = planRename(l, 'B', 'BB', false);
    expect(renumber.serial).toBe('2');
    expect([...renumber.updates]).toEqual([['C', '3']]);
  });
});

describe('bills', () => {
  it('stores the year as ## and restores it', () => {
    const rows = rowsFromLines(['Fee for AY ##,100', 'Expenses,'], '06-07');
    expect(rows[0].desc).toBe('Fee for AY 06-07');
    expect(linesFromRows(rows, '06-07')).toEqual(['Fee for AY ##,100', 'Expenses,']);
  });

  it('saves separators as "New Name,New" and drops empty rows', () => {
    const lines = linesFromRows([{ desc: 'A', amount: '1' }, { desc: 'New Name', amount: '' }, { desc: '', amount: '' }], '06-07');
    expect(lines).toEqual(['A,1', 'New Name,New']);
    expect(rowNumbers(rowsFromLines(['A,1', 'New Name,', 'B,2'], '06-07'))).toEqual(['1', '', '2']);
  });

  it('keeps commas inside descriptions', () => {
    const rows = rowsFromLines(['Fee for deed dated 1,2,2006,500'], '06-07');
    expect(rows[0]).toEqual({ desc: 'Fee for deed dated 1,2,2006', amount: '500' });
  });

  it('validates amounts like Integer.parseInt', () => {
    expect(isValidAmount('')).toBe(true);
    expect(isValidAmount('-200')).toBe(true);
    expect(isValidAmount('12.5')).toBe(false);
    expect(isValidAmount('2147483648')).toBe(false);
  });

  it('merges earlier years into a new bill', () => {
    const y1 = ['SHRI A,', 'Fee AY ##,1000', 'Expenses,50', 'New Name,New', 'SMT B,', 'Expenses,20'];
    const y2 = ['Fee AY ##,900', 'Audit fee,300', 'New Name,New'];
    const y3 = ['audit FEE,1', 'Old item 04-05,5'];
    expect(mergeHistory([y1, y2, y3])).toEqual([
      'SHRI A,0', 'Fee AY ##,0', 'Expenses,0', 'New Name,New', 'SMT B,0', 'Expenses,0', 'Audit fee,0', 'Old item 04-05,0',
    ]);
    // Older literal years match ignoring the year.
    expect(mergeHistory([['Item 05-06,1'], ['Item 04-05,2']])).toEqual(['Item 05-06,0']);
  });

  it('shows earlier years for matching rows', () => {
    const rows = rowsFromLines(['Fee AY ##,100', 'Expenses,10', 'Expenses,5', 'New Name,New'], '06-07');
    const cols = historyColumns(rows, '06-07', [
      { year: '05-06', lines: ['fee ay ##,90', 'Expenses,7', 'Expenses,3'] },
      { year: '04-05', lines: null },
    ]);
    expect(cols[0].values).toEqual(['90', '7,3', '7,3', '--']);
    expect(cols[0].total).toBe(100);
    expect(cols[1].values).toEqual(['--', '--', '--', '--']);
  });
});

describe('keeping bills openable by the Java program', () => {
  it('pads rows whose only earlier amount is blank or not a number', () => {
    const prev = ['SMT. KAMLA,', 'Expenses,500', 'New Name,New', 'Fee,'];
    expect(protectForJava(['SMT. KAMLA,600', 'expenses,0', 'new name,1', 'New Name,New', 'Fee,10', 'Other,'], [prev])).toEqual([
      'SMT. KAMLA ,600', 'expenses,0', 'new name ,1', 'New Name,New', 'Fee ,10', 'Other,',
    ]);
  });

  it('is safe when a later blank follows a number, and checks all three years', () => {
    expect(protectForJava(['A,1'], [['A,5', 'A,']])).toEqual(['A,1']); // "5" only
    expect(protectForJava(['A,1'], [['A,', 'A,5']])).toEqual(['A,1']); // ",5" is parsed safely by Java
    expect(protectForJava(['A,1'], [null, ['B,2'], ['a,']])).toEqual(['A ,1']);
  });

  it('adds more spaces when needed, and removes padding that is no longer needed', () => {
    expect(protectForJava(['A,1'], [['A,'], ['A ,']])).toEqual(['A  ,1']);
    expect(protectForJava(['A ,1'], [['A,3']])).toEqual(['A,1']);
    expect(rowsFromLines(['A  ,1'], '06-07')).toEqual([{ desc: 'A', amount: '1' }]);
  });

  it('matches earlier years ignoring the padding', () => {
    const cols = historyColumns(rowsFromLines(['A ,1'], '06-07'), '06-07', [{ year: '05-06', lines: ['a,7'] }]);
    expect(cols[0].values).toEqual(['7']);
  });

  it('saves amounts without a leading plus', () => {
    expect(linesFromRows([{ desc: 'A', amount: '+500' }], '06-07')).toEqual(['A,500']);
  });
});

describe('money', () => {
  it('groups digits the Indian way', () => {
    expect(groupIndian(0)).toBe('0');
    expect(groupIndian(999)).toBe('999');
    expect(groupIndian(1000)).toBe('1,000');
    expect(groupIndian(123456)).toBe('1,23,456');
    expect(groupIndian(12345678)).toBe('1,23,45,678');
    expect(groupIndian(-1200)).toBe('-1,200');
    expect(formatAmount('')).toBe('');
    expect(formatAmount('19550')).toBe('19,550/-');
  });

  it('writes amounts in words', () => {
    expect(amountInWords(19550)).toBe('Nineteen Thousand Five Hundred and Fifty');
    expect(amountInWords(100)).toBe('One Hundred');
    expect(amountInWords(1234567)).toBe('Twelve Lakh Thirty Four Thousand Five Hundred and Sixty Seven');
    expect(amountInWords(-90)).toBe('Minus Ninety');
    expect(amountInWords(1500000000)).toBe('One Hundred and Fifty Crore');
  });
});

describe('backup folder name', () => {
  it('matches the Java format', () => {
    expect(backupFolderName(new Date(2026, 10, 1, 15, 5, 9))).toBe('01.11.2026+3.5.9PM');
    expect(backupFolderName(new Date(2026, 10, 1, 0, 0, 0))).toBe('01.11.2026+12.0.0AM');
  });
});
