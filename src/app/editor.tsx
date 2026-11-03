import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BillRow, HistoryColumn, SEPARATOR, billTotal, historyColumns, isSeparator, isValidAmount, rowNumbers } from '../core/bill';
import { BillType } from '../core/config';
import { groupIndian } from '../core/money';
import { Client } from '../core/workspace';
import { nextYear, previousYears } from '../core/years';
import { Session } from './session';
import { printBills } from './printing';
import { Modal, attempt, busy, confirmDialog, promptDialog, toast } from './ui';

interface Props {
  s: Session;
  year: string;
  client: Client;
  onDone: (year: string, name: string) => void;
  /** Moves the open-client lock; false if the user declined to open a locked client. */
  relock: (fromYear: string, toYear: string, name: string) => Promise<boolean>;
}

const blank = (): BillRow => ({ desc: '', amount: '' });

export function Editor({ s, year: initialYear, client, onDone, relock }: Props) {
  const [year, setYear] = useState(initialYear);
  const [years, setYears] = useState<string[]>([initialYear]);
  const [info, setInfo] = useState<Client>(client);
  const [exists, setExists] = useState(true);
  const [typeIdx, setTypeIdx] = useState(0);
  const [bills, setBills] = useState<string[]>([]);
  const [bill, setBill] = useState<string | null>(null);
  const [rows, setRows] = useState<BillRow[]>([]);
  // The bill whose rows are in `rows`: nothing is editable until the open bill has been read,
  // so typing while it opens cannot overwrite it (or another bill) with the rows on screen.
  const [loadedKey, setLoadedKey] = useState('');
  const [history, setHistory] = useState<{ year: string; lines: string[] | null }[]>([]);
  const [suggest, setSuggest] = useState<string[]>([]);
  const [focus, setFocus] = useState<{ row: number; col: 'desc' | 'amount' }>({ row: 0, col: 'desc' });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [showUtility, setShowUtility] = useState(false);
  const type: BillType | undefined = s.types[typeIdx];

  // ---------- saving ----------
  const pending = useRef<{ key: string; rows: BillRow[] } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const keyOf = (y: string, t: BillType | undefined, b: string | null) => (t && b ? JSON.stringify([y, info.name, t.folder, b]) : '');

  const flush = (): Promise<unknown> => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) {
      const [y, name, folder, b] = JSON.parse(p.key) as string[];
      setSaveState('saving');
      chain.current = chain.current
        .then(() => s.ws.writeBill(y, name, folder, b, p.rows))
        .then(() => setSaveState(pending.current ? 'saving' : 'saved'))
        .catch((e) => {
          console.error(e);
          setSaveState('error');
          toast(`Could not save the bill: ${e instanceof Error ? e.message : e}`, 'error');
        });
    }
    return chain.current;
  };

  const update = (next: BillRow[]) => {
    if (!ready) return;
    setRows(next);
    pending.current = { key: keyOf(year, type, bill), rows: next };
    setSaveState('saving');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 600);
  };

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current) {
        flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      flush();
    };
  }, []);

  // ---------- loading ----------
  useEffect(() => {
    attempt(async () => setYears(await s.ws.years()));
  }, []);

  useEffect(() => {
    attempt(async () => {
      const ex = await s.ws.clientExists(year, info.name);
      setExists(ex);
      if (ex) {
        const c = (await s.ws.clients(year)).find((x) => x.name === info.name);
        if (c) setInfo(c);
      }
    });
  }, [year]);

  const loadBills = async (prefer?: string | null) => {
    if (!type || !exists) {
      setBills([]);
      setBill(null);
      return;
    }
    const list = await s.ws.bills(year, info.name, type.folder);
    setBills(list);
    setBill(prefer && list.includes(prefer) ? prefer : (list[0] ?? null));
  };

  useEffect(() => {
    attempt(() => loadBills(bill));
  }, [year, typeIdx, exists]);

  useEffect(() => {
    setPicked(new Set());
    if (!type || !bill || !exists) {
      setRows([]);
      setHistory([]);
      return;
    }
    let live = true;
    attempt(async () => {
      const r = await s.ws.readBill(year, info.name, type.folder, bill);
      const h = await Promise.all(
        previousYears(year, 3).map(async (y) => ({ year: y, lines: await s.ws.readBillLines(y, info.name, type.folder, bill) })),
      );
      if (!live) return;
      setRows(r);
      setLoadedKey(keyOf(year, type, bill));
      setHistory(h);
      setFocus({ row: 0, col: 'desc' });
    });
    attempt(async () => {
      const items = await s.ws.dropdown(type.tab, year);
      if (live) setSuggest(items);
    });
    return () => {
      live = false;
    };
  }, [bill, year, typeIdx, exists]);

  const ready = bill !== null && loadedKey === keyOf(year, type, bill);
  const columns: HistoryColumn[] = useMemo(() => historyColumns(rows, year, history), [rows, history, year]);
  const numbers = useMemo(() => rowNumbers(rows), [rows]);
  const total = billTotal(rows);

  // ---------- navigation ----------
  const switchTo = async (fn: () => void) => {
    await flush();
    fn();
  };

  const changeYear = (y: string) =>
    attempt(async () => {
      if (y === year) return;
      await flush();
      if (!(await relock(year, y, info.name))) return;
      setYear(y);
    });

  const done = () =>
    attempt(async () => {
      await flush();
      onDone(year, info.name);
    });

  // ---------- row operations ----------
  const targetRows = (): number[] => {
    const p = [...picked].filter((i) => i < rows.length).sort((a, b) => a - b);
    if (p.length) return p;
    return focus.row < rows.length ? [focus.row] : [];
  };

  const setCell = (i: number, patch: Partial<BillRow>) => {
    const next = [...rows];
    while (next.length <= i) next.push(blank());
    next[i] = { ...next[i], ...patch };
    update(next);
  };

  const insertRow = (sep = false) => {
    if (!bill) return;
    const at = Math.min(focus.row, rows.length);
    const next = [...rows];
    next.splice(at, 0, sep ? { desc: SEPARATOR, amount: '' } : blank());
    update(next);
    setPicked(new Set());
    setFocus({ row: sep ? at + 1 : at, col: 'desc' });
    focusCell(sep ? at + 1 : at, 'desc');
  };

  const deleteRows = () => {
    const t = new Set(targetRows());
    if (!t.size) return;
    update(rows.filter((_, i) => !t.has(i)));
    setPicked(new Set());
    const row = Math.min(Math.min(...t), Math.max(0, rows.length - t.size));
    setFocus({ row, col: focus.col });
    focusCell(row, focus.col);
  };

  const move = (d: -1 | 1) => {
    const t = targetRows();
    if (!t.length) return;
    if (d === -1 && t[0] === 0) return;
    if (d === 1 && t[t.length - 1] >= rows.length - 1) return;
    const next = [...rows];
    const order = d === -1 ? t : [...t].reverse();
    for (const i of order) [next[i], next[i + d]] = [next[i + d], next[i]];
    update(next);
    const moved = new Set(t.map((i) => i + d));
    if (picked.size) setPicked(moved);
    setFocus({ row: focus.row + d, col: focus.col });
    focusCell(focus.row + d, focus.col);
  };

  // ---------- bill operations ----------
  const newBill = () =>
    attempt(async () => {
      if (!type || !exists) return;
      const name = await promptDialog({
        title: `New bill — ${type.tab}`,
        label: 'Bill name',
        upper: true,
        hint: 'Rows from this bill in the previous three years are filled in automatically.',
        validate: (v) => (bills.some((b) => b.toLowerCase() === v.trim().toLowerCase()) ? 'This bill name already exists.' : v.trim() === '' ? 'Enter a name.' : null),
      });
      if (!name) return;
      await flush();
      const created = await s.ws.createBill(year, info.name, type.folder, name);
      await loadBills(created);
    });

  const renameBill = () =>
    attempt(async () => {
      if (!type || !bill) return;
      const name = await promptDialog({
        title: 'Rename bill',
        label: 'New name',
        value: bill,
        upper: true,
        validate: (v) => (bills.some((b) => b !== bill && b.toLowerCase() === v.trim().toLowerCase()) ? 'This name already exists.' : v.trim() === '' ? 'Enter a name.' : null),
      });
      if (!name) return;
      await flush();
      const n = await s.ws.renameBill(year, info.name, type.folder, bill, name);
      setShowUtility(false);
      await loadBills(n);
    });

  const deleteBill = () =>
    attempt(async () => {
      if (!type || !bill) return;
      const ok = await confirmDialog({ title: 'Delete bill?', message: <p>Are you sure you want to delete the bill <b>{bill}</b>?</p>, ok: 'Delete', danger: true });
      if (!ok) return;
      pending.current = null;
      await chain.current;
      await s.ws.deleteBill(year, info.name, type.folder, bill);
      setShowUtility(false);
      toast(`Deleted ${bill}.`, 'ok');
      await loadBills(null);
    });

  const printThis = () =>
    attempt(async () => {
      if (!type || !bill) return;
      await flush();
      await printBills(s, year, [info], { types: [type], bill });
    });

  const printTab = () =>
    attempt(async () => {
      if (!type) return;
      await flush();
      setShowUtility(false);
      await printBills(s, year, [info], { types: [type] });
    });

  // ---------- keyboard ----------
  // Shortcuts work wherever the focus is on this screen (dialogs stop their own key events).
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const onKey = (e: KeyboardEvent) => {
    if (document.querySelector('.backdrop')) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k.toLowerCase() === 'p') {
      e.preventDefault();
      printThis();
    } else if (ctrl && k.toLowerCase() === 'i') {
      e.preventDefault();
      insertRow();
    } else if (ctrl && k.toLowerCase() === 'b') {
      e.preventDefault();
      insertRow(true);
    } else if (ctrl && k === 'Delete') {
      e.preventDefault();
      deleteRows();
    } else if (e.altKey && k === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.altKey && k === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.altKey && k === 'ArrowLeft') {
      e.preventDefault();
      done();
    } else if (e.altKey && k === 'ArrowRight') {
      e.preventDefault();
      const n = nextYear(year);
      if (n && years.includes(n)) changeYear(n);
    } else if (e.altKey && k.toLowerCase() === 'n') {
      e.preventDefault();
      newBill();
    } else if (e.altKey && k.toLowerCase() === 'u') {
      e.preventDefault();
      setShowUtility(true);
    } else if (k === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      // Esc first leaves the cell being typed in; Esc again goes back to the list.
      const t = e.target as HTMLElement;
      if (t.closest('.grid') && (t instanceof HTMLInputElement || t.classList.contains('sep-label'))) t.blur();
      else done();
    }
  };

  keyRef.current = onKey;
  const yIdx = years.indexOf(year);
  const hist = columns.length ? columns : previousYears(year, 3).map((y) => ({ year: y, values: rows.map(() => '--'), total: 0 }));
  const shown = ready ? [...rows, blank()] : [];

  return (
    <div class="screen editor">
      <header class="topbar">
        <button onClick={done} title="Done — back to the list (Esc or Alt+←)">
          ← Done
        </button>
        <div class="client-title">
          <b>{info.name}</b>
          <span>
            S.No. {info.serial || '—'} · Bill No. {info.billNo || '—'}
          </span>
        </div>
        <div class="year-picker">
          <button class="icon-btn" aria-label="Previous year" title="Previous year" disabled={yIdx <= 0} onClick={() => changeYear(years[yIdx - 1])}>
            ‹
          </button>
          <select aria-label="Year" value={year} onChange={(e) => changeYear((e.target as HTMLSelectElement).value)}>
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
          <button
            class="icon-btn"
            aria-label="Next year"
            title="Next year (Alt+→)"
            disabled={yIdx < 0 || yIdx >= years.length - 1}
            onClick={() => changeYear(years[yIdx + 1])}
          >
            ›
          </button>
        </div>
        <div class="spacer" />
        <span class={`save-state ${saveState}`} aria-live="polite">
          {saveState === 'saved' ? 'All changes saved' : saveState === 'saving' ? 'Saving…' : 'Not saved!'}
        </span>
        <button onClick={printThis} disabled={!bill} title="Print this bill (Ctrl+P)">
          Print
        </button>
        <button onClick={() => setShowUtility(true)} disabled={!exists} title="Bill utility (Alt+U)">
          Bill utility…
        </button>
      </header>

      {!exists ? (
        <div class="empty">
          <p>
            {info.name} is not in {year}.
          </p>
          <button onClick={() => changeYear(initialYear)}>Back to {initialYear}</button>
        </div>
      ) : (
        <>
          <div class="tabs types" role="tablist" aria-label="Bill types">
            {s.types.map((t, i) => (
              <button key={t.folder} role="tab" aria-selected={i === typeIdx} class={i === typeIdx ? 'tab active' : 'tab'} onClick={() => switchTo(() => setTypeIdx(i))}>
                {t.tab}
              </button>
            ))}
          </div>
          <div class="tabs bills" role="tablist" aria-label="Bills">
            {bills.map((b) => (
              <button key={b} role="tab" aria-selected={b === bill} class={b === bill ? 'tab active' : 'tab'} onClick={() => switchTo(() => setBill(b))}>
                {b}
              </button>
            ))}
            <button class="tab add" onClick={newBill} title="New bill (Alt+N)">
              + New bill
            </button>
          </div>

          {!bill ? (
            <div class="empty">
              <p>No bills in {type?.tab ?? 'this tab'} yet.</p>
              <button class="primary" onClick={newBill}>
                New bill…
              </button>
            </div>
          ) : (
            <>
              <div class="toolbar">
                <button onClick={() => insertRow()} title="Insert a row above the current one (Ctrl+I)">
                  Insert row
                </button>
                <button onClick={deleteRows} title="Delete the current or ticked rows (Ctrl+Delete)">
                  Delete row
                </button>
                <button onClick={() => move(-1)} title="Move up (Alt+↑)">
                  Move up
                </button>
                <button onClick={() => move(1)} title="Move down (Alt+↓)">
                  Move down
                </button>
                <button onClick={() => insertRow(true)} title="Start a new name: rows below are a separate group with its own subtotal (Ctrl+B)">
                  New name
                </button>
                <span class="hint grow">Type in Field to see the drop-down list (Ctrl+Space shows all).</span>
              </div>
              <div class="grid-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th class="pick" />
                      <th class="sno">S.No.</th>
                      <th class="desc">Field</th>
                      <th class="amt">Amount</th>
                      {hist.map((h) => (
                        <th key={h.year} class="amt hist">
                          {h.year}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r, i) => {
                      const sep = isSeparator(r);
                      const extra = i === rows.length;
                      return (
                        <tr key={i} class={`${sep ? 'sep' : ''} ${picked.has(i) ? 'picked' : ''} ${focus.row === i ? 'current' : ''} ${extra ? 'extra' : ''}`}>
                          <td class="pick">
                            {!extra && (
                              <input
                                type="checkbox"
                                tabIndex={-1}
                                aria-label={`Select row ${i + 1}`}
                                checked={picked.has(i)}
                                onChange={() => {
                                  const p = new Set(picked);
                                  if (p.has(i)) p.delete(i);
                                  else p.add(i);
                                  setPicked(p);
                                }}
                              />
                            )}
                          </td>
                          <td class="sno">{extra ? '' : numbers[i]}</td>
                          {sep ? (
                            <td class="desc sep-cell" colSpan={2}>
                              <span
                                tabIndex={0}
                                class="sep-label"
                                data-row={i}
                                data-col="desc"
                                onFocus={() => setFocus({ row: i, col: 'desc' })}
                                onKeyDown={(e) => gridNav(e, i, 'desc')}
                              >
                                New name — rows below form a separate group
                              </span>
                            </td>
                          ) : (
                            <>
                              <td class="desc">
                                <FieldInput
                                  row={i}
                                  placeholder={extra ? 'Type here to add a row' : undefined}
                                  value={r.desc}
                                  items={suggest}
                                  onFocus={() => setFocus({ row: i, col: 'desc' })}
                                  onChange={(v) => setCell(i, { desc: v })}
                                  onNav={(e) => gridNav(e, i, 'desc')}
                                  onPicked={() => focusCell(i, 'amount')}
                                />
                              </td>
                              <td class="amt">
                                <input
                                  class={`amt-input ${isValidAmount(r.amount) ? '' : 'invalid'}`}
                                  inputMode="numeric"
                                  aria-label={`Amount row ${i + 1}`}
                                  data-row={i}
                                  data-col="amount"
                                  value={r.amount}
                                  onFocus={() => setFocus({ row: i, col: 'amount' })}
                                  onInput={(e) => {
                                    const el = e.target as HTMLInputElement;
                                    const v = el.value.replace(/[,\s]/g, '');
                                    if (!/^[+-]?\d*$/.test(v) || !isValidAmount(v === '+' || v === '-' ? '' : v)) {
                                      el.value = r.amount;
                                      return;
                                    }
                                    setCell(i, { amount: v });
                                  }}
                                  onKeyDown={(e) => gridNav(e, i, 'amount')}
                                />
                              </td>
                            </>
                          )}
                          {hist.map((h) => (
                            <td key={h.year} class="amt hist">
                              {extra || sep ? '' : h.values[i]}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td />
                      <td />
                      <td class="desc">Total</td>
                      <td class="amt">{groupIndian(total)}/-</td>
                      {hist.map((h) => (
                        <td key={h.year} class="amt hist">
                          {groupIndian(h.total)}/-
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {showUtility && (
        <Modal title={`Bill utility — ${type?.tab ?? ''}`} onClose={() => setShowUtility(false)} footer={<button onClick={() => setShowUtility(false)}>Close</button>}>
          <div class="util-list">
            <button class="util-item" disabled={!bill} onClick={renameBill}>
              <b>Rename the bill</b>
              <span>{bill ?? 'No bill selected'}</span>
            </button>
            <button class="util-item" disabled={!bill} onClick={deleteBill}>
              <b>Delete the bill</b>
              <span>{bill ?? 'No bill selected'}</span>
            </button>
            <button class="util-item" disabled={!bills.length} onClick={printTab}>
              <b>Print the bills</b>
              <span>
                All {bills.length} bill{bills.length === 1 ? '' : 's'} in {type?.tab}
              </span>
            </button>
          </div>
        </Modal>
      )}
    </div>
  );

  function focusCell(row: number, c: 'desc' | 'amount') {
    // Focus at once so fast typing is not lost; if the row is only created by
    // this change, try again after the next render.
    const attemptFocus = () => {
      const r = Math.max(0, Math.min(rows.length + 1, row));
      const el =
        document.querySelector<HTMLElement>(`.grid [data-row="${r}"][data-col="${c}"]`) ??
        document.querySelector<HTMLElement>(`.grid [data-row="${r}"][data-col="desc"]`);
      if (!el) return false;
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
      return true;
    };
    const exact = () => document.querySelector(`.grid [data-row="${row}"][data-col="${c}"]`);
    const found = exact();
    attemptFocus();
    if (!found) requestAnimationFrame(() => exact() && attemptFocus());
  }

  function gridNav(e: KeyboardEvent, i: number, col: 'desc' | 'amount') {
    const go = focusCell;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(i + 1, col);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      go(i - 1, col);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (col === 'desc') go(i, 'amount');
      else go(i + 1, 'desc');
    }
  }
}

function FieldInput({ row, placeholder, value, items, onFocus, onChange, onNav, onPicked }: {
  row: number;
  placeholder?: string;
  value: string;
  items: string[];
  onFocus: () => void;
  onChange: (v: string) => void;
  onNav: (e: KeyboardEvent) => void;
  onPicked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const matches = useMemo(() => {
    if (all) return items;
    const v = value.toLowerCase();
    return items.filter((it) => it.toLowerCase().startsWith(v) && it !== value);
  }, [items, value, all]);
  const visible = open && matches.length > 0;

  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView({ block: 'nearest' });
  }, [hi, visible]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setAll(false);
  };

  return (
    <div class="field-cell">
      <input
        class="desc-input"
        aria-label={`Field row ${row + 1}`}
        data-row={row}
        data-col="desc"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => {
          onFocus();
          setOpen(value === '');
          setHi(0);
        }}
        onBlur={() => setTimeout(() => (setOpen(false), setAll(false)), 150)}
        onInput={(e) => {
          onChange((e.target as HTMLInputElement).value);
          setOpen(true);
          setAll(false);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey && e.key === ' ') || e.key === 'F4') {
            e.preventDefault();
            e.stopPropagation();
            setAll(true);
            setOpen(true);
            setHi(0);
            return;
          }
          if (visible) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHi((h) => Math.min(matches.length - 1, h + 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (hi === 0) setOpen(false);
              else setHi((h) => h - 1);
              return;
            }
            if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey && value !== '')) {
              pick(matches[hi]);
              if (e.key === 'Enter') {
                e.preventDefault();
                onPicked();
              }
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              setAll(false);
              return;
            }
          }
          onNav(e);
        }}
      />
      {visible && (
        <ul class="suggest" ref={listRef} role="listbox">
          {matches.map((m, k) => (
            <li
              key={m}
              role="option"
              aria-selected={k === hi}
              class={k === hi ? 'hi' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
            >
              {m}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export async function confirmNextYearCopy(s: Session, year: string, name: string): Promise<void> {
  const years = await s.ws.years();
  const next = nextYear(year);
  if (!next || year === years[years.length - 1] || !years.includes(next)) return;
  if (await s.ws.clientExists(next, name)) return;
  const ok = await confirmDialog({
    title: 'Update the bill',
    message: (
      <p>
        Update bill for <b>{name}</b> to next year <b>{next}</b>?
      </p>
    ),
    ok: 'Yes',
    cancel: 'No',
  });
  if (!ok) return;
  await busy('Copying to next year…', async () => {
    await s.ws.copyClientToNextYear(year, name);
    toast(`${name} copied to ${next}.`, 'ok');
  });
}
