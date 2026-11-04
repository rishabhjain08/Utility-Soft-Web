import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BillRow, HistoryColumn, SEPARATOR, billTotal, historyColumns, isValidAmount, rowGroups, rowNumbers, rowsFromLines } from '../core/bill';
import { BillType } from '../core/config';
import { groupIndian } from '../core/money';
import { BillConflict, Client, ClientDetails, Payment } from '../core/webstore';
import { collapseYear } from '../core/bill';
import { dateString } from '../core/util';
import { billPdf, pdfName } from './pdf';
import { PaymentStrip } from './payments';
import { nextYear, previousYears } from '../core/years';
import { Session } from './session';
import { printBills } from './printing';
import { Modal, attempt, busy, confirmDialog, mountDialog, promptDialog, toast } from './ui';

interface Props {
  s: Session;
  year: string;
  client: Client;
  onDone: (year: string, name: string) => void;
  /** Moves the open-client lock; false if the user declined to open a locked client. */
  relock: (fromYear: string, toYear: string, name: string) => Promise<boolean>;
  /** The tab and bill to show first. */
  at?: { folder?: string; bill?: string };
}

const blank = (): BillRow => ({ desc: '', amount: '' });

export function Editor({ s, year: initialYear, client, onDone, relock, at }: Props) {
  const [year, setYear] = useState(initialYear);
  const [years, setYears] = useState<string[]>([initialYear]);
  const [info, setInfo] = useState<Client>(client);
  const [exists, setExists] = useState(true);
  const [typeIdx, setTypeIdx] = useState(Math.max(0, s.types.findIndex((t) => t.folder === at?.folder)));
  const [bills, setBills] = useState<string[]>([]);
  const [bill, setBill] = useState<string | null>(at?.bill ?? null);
  const [details, setDetails] = useState<ClientDetails>({});
  useEffect(() => {
    s.ws.clientDetails(initialYear, client.name).then(setDetails, () => undefined);
  }, []);
  // Tabs with bills this year (hidden tabs are shown only then).
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [money, setMoney] = useState<{ payments: Payment[]; sums: { billed: number; received: number; reduced: number; due: number }; printed?: string } | null>(null);
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
  // Each bill as it was last read or saved here: a save refuses if it was changed elsewhere since.
  const base = useRef(new Map<string, string[] | null>());
  const shownKey = useRef('');

  /** The bill was changed on another computer while open here: keep which version? */
  const resolveConflict = async (key: string, rows: BillRow[], current: string[] | null): Promise<void> => {
    const [y, name, folder, b] = JSON.parse(key) as string[];
    const mine = await confirmDialog({
      title: 'Changed on another computer',
      message: (
        <>
          <p>
            The bill <b>{b}</b> was {current ? 'changed' : 'deleted'} on another computer while it was open here.
          </p>
          <p class="hint">Keep the version on this screen (the other one is kept as an earlier version), or show the other one.</p>
        </>
      ),
      ok: 'Keep mine',
      cancel: current ? 'Show the other version' : 'Leave it deleted',
    });
    if (mine) {
      base.current.set(key, await s.ws.writeBill(y, name, folder, b, rows, current));
      return;
    }
    base.current.set(key, current);
    if (pending.current?.key === key) pending.current = null;
    if (shownKey.current === key) {
      const r = rowsFromLines(current ?? [], y);
      setRows(r);
      undo.current = { past: [], future: [], at: 0 };
    }
  };

  const flush = (): Promise<unknown> => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) {
      const [y, name, folder, b] = JSON.parse(p.key) as string[];
      setSaveState('saving');
      chain.current = chain.current
        .then(async () => {
          try {
            base.current.set(p.key, await s.ws.writeBill(y, name, folder, b, p.rows, base.current.get(p.key)));
          } catch (e) {
            if (e instanceof BillConflict) await resolveConflict(p.key, p.rows, e.current);
            else throw e;
          }
        })
        .then(() => setSaveState(pending.current ? 'saving' : 'saved'))
        .catch((e) => {
          console.error(e);
          setSaveState('error');
          toast(`Could not save the bill: ${e instanceof Error ? e.message : e}`, 'error');
        });
    }
    return chain.current;
  };

  // Undo and redo of changes to the open bill (typing in one cell counts as one change).
  const undo = useRef<{ past: BillRow[][]; future: BillRow[][]; at: number; cell?: string }>({ past: [], future: [], at: 0 });
  const [, setUndoTick] = useState(0);

  const save = (next: BillRow[]) => {
    setRows(next);
    pending.current = { key: keyOf(year, type, bill), rows: next };
    setSaveState('saving');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 600);
  };

  const update = (next: BillRow[], cell?: string) => {
    if (!ready) return;
    const u = undo.current;
    const now = Date.now();
    if (!(cell && u.cell === cell && now - u.at < 1500 && u.past.length)) u.past.push(rows);
    if (u.past.length > 200) u.past.shift();
    u.future = [];
    u.at = now;
    u.cell = cell;
    setUndoTick((t) => t + 1);
    save(next);
  };

  const undoRedo = (back: boolean) => {
    if (!ready) return;
    const u = undo.current;
    const from = back ? u.past : u.future;
    const to = back ? u.future : u.past;
    const r = from.pop();
    if (!r) return;
    to.push(rows);
    u.cell = undefined;
    setUndoTick((t) => t + 1);
    save(r);
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
        const u = new Set<string>();
        for (const t of s.types) if ((await s.ws.bills(year, info.name, t.folder)).length) u.add(t.folder);
        setUsed(u);
        if (s.types[typeIdx]?.hidden && !u.has(s.types[typeIdx].folder)) setTypeIdx(Math.max(0, s.types.findIndex((t) => !t.hidden)));
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
      const key = keyOf(year, type, bill);
      const lines = await s.ws.readBillLines(year, info.name, type.folder, bill);
      const r = rowsFromLines(lines ?? [], year);
      const h = await s.ws.historyLines(year, info.name, type.folder, bill);
      if (!live) return;
      if (pending.current?.key !== key) base.current.set(key, lines);
      setMoney(await s.ws.payments(year, info.name, type.folder, bill));
      shownKey.current = key;
      undo.current = { past: [], future: [], at: 0 };
      setRows(r);
      setLoadedKey(key);
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
    update(next, `${i}:${Object.keys(patch).join()}`);
  };

  const insertAt = (at: number, sep = false) => {
    if (!bill) return;
    const next = [...rows];
    next.splice(at, 0, sep ? { desc: SEPARATOR, amount: '' } : blank());
    update(next);
    setPicked(new Set());
    setFocus({ row: sep ? at + 1 : at, col: 'desc' });
    focusCell(sep ? at + 1 : at, 'desc');
  };
  const insertRow = (sep = false) => insertAt(Math.min(focus.row, rows.length), sep);

  /** Starts a new, empty group at the end of the bill and puts the cursor in it. */
  const addGroup = () => {
    if (!bill) return;
    const next = [...rows, { desc: SEPARATOR, amount: '' }];
    update(next);
    setPicked(new Set());
    setFocus({ row: next.length, col: 'desc' });
    focusCell(next.length, 'desc');
  };

  const deleteRows = (which?: number[]) => {
    const t = new Set(which ?? targetRows());
    if (!t.size) return;
    update(rows.filter((_, i) => !t.has(i)));
    setPicked(new Set());
    const row = Math.min(Math.min(...t), Math.max(0, rows.length - t.size));
    setFocus({ row, col: focus.col });
    focusCell(row, focus.col);
  };

  /** Moves rows (in their order) so they start where row `at` is now. */
  const moveRowsTo = (moving: number[], at: number) => {
    const set = new Set(moving);
    const rest = rows.filter((_, i) => !set.has(i));
    const ins = at - moving.filter((i) => i < at).length;
    const next = [...rest.slice(0, ins), ...moving.map((i) => rows[i]), ...rest.slice(ins)];
    if (next.every((r, i) => r === rows[i])) return;
    update(next);
    setPicked(moving.length > 1 ? new Set(moving.map((_, k) => ins + k)) : new Set());
    setFocus({ row: ins, col: focus.col });
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

  // Selecting rows: click the row number; Ctrl adds or removes one, Shift a range.
  const anchor = useRef<number | null>(null);
  const pickRow = (e: MouseEvent, i: number) => {
    e.preventDefault();
    let next: Set<number>;
    if (e.shiftKey && anchor.current !== null) {
      next = new Set();
      for (let k = Math.min(anchor.current, i); k <= Math.max(anchor.current, i); k++) next.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      next = new Set(picked);
      if (next.has(i)) next.delete(i);
      else next.add(i);
    } else {
      next = picked.size === 1 && picked.has(i) ? new Set() : new Set([i]);
    }
    anchor.current = i;
    setPicked(next);
  };

  // Dragging rows by their handle (several when the dragged row is selected).
  const [drag, setDrag] = useState<{ rows: number[]; at: number } | null>(null);
  const startDrag = (e: PointerEvent, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const moving = picked.has(i) ? [...picked].filter((x) => x < rows.length).sort((a, b) => a - b) : [i];
    const table = (e.currentTarget as HTMLElement).closest('table')!;
    const wrap = table.closest<HTMLElement>('.grid-wrap');
    let at = i;
    setDrag({ rows: moving, at });
    const onMove = (ev: PointerEvent) => {
      at = rows.length;
      for (const tr of table.querySelectorAll<HTMLElement>('tr[data-index]')) {
        const r = tr.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          at = Number(tr.dataset.index);
          break;
        }
      }
      setDrag({ rows: moving, at });
      if (wrap) {
        const w = wrap.getBoundingClientRect();
        if (ev.clientY < w.top + 40) wrap.scrollTop -= 12;
        else if (ev.clientY > w.bottom - 40) wrap.scrollTop += 12;
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDrag(null);
      moveRowsTo(moving, at);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const [menu, setMenu] = useState<number | null>(null);

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

  const showVersions = () =>
    attempt(async () => {
      if (!type || !bill) return;
      await flush();
      const versions = await s.ws.billVersions(year, info.name, type.folder, bill);
      const chosen = await mountDialog<string[] | null>((done) => (
        <Modal title={`Earlier versions — ${bill}`} wide onClose={() => done(null)} footer={<button onClick={() => done(null)}>Close</button>}>
          {versions.length === 0 ? (
            <p>There are no earlier versions of this bill yet. A version is kept at most every 10 minutes while a bill is being changed.</p>
          ) : (
            <ul class="version-list">
              {versions.map((v) => {
                const r = rowsFromLines(v.lines, year);
                return (
                  <li key={v.at}>
                    <div>
                      <b>{new Date(v.at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>
                      <span class="hint">
                        {' '}
                        · {r.filter((x) => x.desc !== SEPARATOR).length} rows · total {groupIndian(billTotal(r))}/-
                      </span>
                      <div class="hint">{r.filter((x) => x.desc !== SEPARATOR).slice(0, 3).map((x) => x.desc).join(' · ')}</div>
                    </div>
                    <button onClick={() => done(v.lines)}>Use this version</button>
                  </li>
                );
              })}
            </ul>
          )}
        </Modal>
      ));
      if (chosen) {
        update(rowsFromLines(chosen, year));
        toast('The earlier version is back. Ctrl+Z undoes this.', 'ok');
      }
    });

  const addToList = (desc: string) =>
    attempt(async () => {
      if (!type) return;
      const items = await s.ws.dropdown(type.tab, '##');
      await s.ws.saveDropdowns(s.types, new Map([[type.tab, [...items, collapseYear(desc.trim(), year)]]]));
      setSuggest(await s.ws.dropdown(type.tab, year));
      toast(`Added to the ${type.tab} drop-down list.`, 'ok');
    });

  /** The open bill as a PDF: saved to Downloads, or shared (Windows share, WhatsApp, email…). */
  const makePdf = (share: boolean) =>
    attempt(async () => {
      if (!type || !bill) return;
      await flush();
      const date = dateString(new Date());
      const { bytes, missing } = await billPdf({ billName: bill, serial: info.serial, billNo: info.billNo, rows: await s.ws.readBill(year, info.name, type.folder, bill) }, s.letterhead, date);
      const name = pdfName(info.name, bill, info.billNo);
      const file = new File([bytes as BlobPart], name, { type: 'application/pdf' });
      if (share && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name });
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') return;
          throw e;
        }
      } else {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        toast(`Saved ${name} (in Downloads).`, 'ok');
      }
      if (missing.length) toast(`Some characters cannot be shown in the PDF and became “?”: ${missing.join(' ')}`, 'info');
      await s.ws.markPrinted(year, [{ client: info.name, folder: type.folder, bill }], date);
    });
  const canShare = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';

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
    if (ctrl && (k.toLowerCase() === 'z' || k.toLowerCase() === 'y')) {
      e.preventDefault();
      undoRedo(k.toLowerCase() === 'z' && !e.shiftKey);
    } else if (ctrl && k.toLowerCase() === 'p') {
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
      if (t.closest('.grid') && (t instanceof HTMLInputElement || t.classList.contains('group-label'))) t.blur();
      else done();
    }
  };

  keyRef.current = onKey;
  const yIdx = years.indexOf(year);
  const hist: HistoryColumn[] = columns.length
    ? columns
    : previousYears(year, 3).map((y) => ({ year: y, values: rows.map(() => '--'), counted: rows.map(() => 0), total: 0 }));
  const groups = ready ? rowGroups(rows) : [];
  const grouped = groups.length > 1;
  const dropClass = (i: number) => (drag && drag.at === i ? 'drop-before' : '');

  const rowView = (i: number) => {
    const extra = i === rows.length;
    const r = extra ? blank() : rows[i];
    const cls = [picked.has(i) ? 'picked' : '', focus.row === i ? 'current' : '', extra ? 'extra' : '', drag?.rows.includes(i) ? 'moving' : '', dropClass(i)];
    return (
      <tr key={`r${i}`} data-index={extra ? undefined : i} class={cls.join(' ')}>
        <td class="grip">{!extra && <GripButton label={`Drag row ${numbers[i]}`} onPointerDown={(e) => startDrag(e, i)} />}</td>
        <td class="sno" onMouseDown={extra ? undefined : (e) => pickRow(e, i)} title={extra ? undefined : 'Click to select (Ctrl or Shift for more)'}>
          {extra ? '' : numbers[i]}
        </td>
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
            title={isValidAmount(r.amount) ? undefined : 'Not a whole number, so it is not counted in the total. Type the amount again to correct it.'}
            inputMode="numeric"
            aria-label={`Amount row ${i + 1}`}
            data-row={i}
            data-col="amount"
            value={withCommas(r.amount)}
            onFocus={() => setFocus({ row: i, col: 'amount' })}
            onInput={(e) => {
              const el = e.target as HTMLInputElement;
              const v = el.value.replace(/[,\s]/g, '');
              if (!/^[+-]?\d*$/.test(v) || !isValidAmount(v === '+' || v === '-' ? '' : v)) {
                el.value = withCommas(r.amount);
                return;
              }
              // Keep the cursor after the same digit once the commas move.
              const digits = el.value.slice(0, el.selectionStart ?? el.value.length).replace(/[^\d+-]/g, '').length;
              setCell(i, { amount: v });
              requestAnimationFrame(() => {
                let at = 0;
                for (let k = 0; k < digits && at < el.value.length; at++) if (/[\d+-]/.test(el.value[at])) k++;
                el.setSelectionRange(at, at);
              });
            }}
            onKeyDown={(e) => gridNav(e, i, 'amount')}
          />
        </td>
        <td class="act">
          {!extra && (
            <RowMenu
              label={`Row ${numbers[i]} actions`}
              open={menu === i}
              onOpen={(o) => setMenu(o ? i : null)}
              items={[
                { label: 'Insert a row above', run: () => insertAt(i) },
                { label: 'Insert a row below', run: () => insertAt(i + 1) },
                { label: 'Start a new group from this row', run: () => insertAt(i, true) },
                ...(r.desc.trim() && !suggest.includes(r.desc.trim()) ? [{ label: 'Add this text to the drop-down list', run: () => addToList(r.desc) }] : []),
                picked.has(i) && picked.size > 1
                  ? { label: `Delete the ${picked.size} selected rows`, run: () => deleteRows(), danger: true }
                  : { label: 'Delete this row', run: () => deleteRows([i]), danger: true },
              ]}
            />
          )}
        </td>
        {hist.map((h) => (
          <td key={h.year} class="amt hist">
            {extra ? '' : h.values[i]}
          </td>
        ))}
      </tr>
    );
  };

  /** The heading of a group: the separator row it starts with (none for the first group). */
  const groupHead = (i: number | null, gi: number) => (
    <tr key={`h${gi}`} data-index={i ?? undefined} class={`group-head ${i !== null ? dropClass(i) : ''} ${i !== null && drag?.rows.includes(i) ? 'moving' : ''} ${i !== null && picked.has(i) ? 'picked' : ''}`}>
      <td class="grip">{i !== null && <GripButton label={`Drag group ${gi + 1}`} onPointerDown={(e) => startDrag(e, i)} />}</td>
      <td class="sno" />
      <td class="desc" colSpan={2}>
        <span
          class="group-label"
          tabIndex={i === null ? undefined : 0}
          data-row={i ?? undefined}
          data-col={i === null ? undefined : 'desc'}
          onFocus={i === null ? undefined : () => setFocus({ row: i, col: 'desc' })}
          onKeyDown={i === null ? undefined : (e) => gridNav(e, i, 'desc')}
        >
          Group {gi + 1}
        </span>
      </td>
      <td class="act">
        {i !== null && (
          <RowMenu
            label={`Group ${gi + 1} actions`}
            open={menu === i}
            onOpen={(o) => setMenu(o ? i : null)}
            items={[
              { label: 'Insert a row above (end of the group before)', run: () => insertAt(i) },
              { label: `Join with group ${gi}`, run: () => deleteRows([i]), danger: true },
            ]}
          />
        )}
      </td>
      {hist.map((h) => (
        <td key={h.year} class="hist" />
      ))}
    </tr>
  );

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
            {details.pan && ` · PAN ${details.pan}`}
            {details.gstin && ` · GSTIN ${details.gstin}`}
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
        <button onClick={() => makePdf(false)} disabled={!bill} title="Save this bill as a PDF file (in Downloads), to email or send">
          PDF
        </button>
        {canShare && (
          <button onClick={() => makePdf(true)} disabled={!bill} title="Send this bill as a PDF (WhatsApp, email…)">
            Share…
          </button>
        )}
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
            {s.types.map((t, i) =>
              t.hidden && !used.has(t.folder) && i !== typeIdx ? null : (
                <button
                  key={t.folder}
                  role="tab"
                  aria-selected={i === typeIdx}
                  class={`${i === typeIdx ? 'tab active' : 'tab'} ${t.hidden ? 'hidden-tab' : ''}`}
                  title={t.hidden ? 'A hidden tab, shown because this client has bills in it' : undefined}
                  onClick={() => switchTo(() => setTypeIdx(i))}
                >
                  {t.tab}
                </button>
              ),
            )}
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
                <button onClick={addGroup} title="Start a new group of rows with its own subtotal, e.g. for another person on this bill (Ctrl+B starts one at the current row)">
                  + Add group
                </button>
                <button class="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!undo.current.past.length} onClick={() => undoRedo(true)}>
                  ↶
                </button>
                <button class="icon-btn" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!undo.current.future.length} onClick={() => undoRedo(false)}>
                  ↷
                </button>
                <span class="hint grow">
                  Drag <Grip /> to reorder rows, click a row number to select it (Ctrl or Shift for more), ⋯ for more. Ctrl+Space shows the drop-down list.
                </span>
              </div>
              <div class="grid-wrap">
                <table class={`grid ${drag ? 'dragging' : ''}`}>
                  <thead>
                    <tr>
                      <th class="grip" />
                      <th class="sno">S.No.</th>
                      <th class="desc">Field</th>
                      <th class="amt">Amount</th>
                      <th class="act" />
                      {hist.map((h) => (
                        <th key={h.year} class="amt hist">
                          {h.year}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  {groups.map((g, gi) => (
                    <tbody key={gi} class={grouped ? 'group' : ''}>
                      {grouped && gi > 0 && (
                        <tr class="gap" aria-hidden="true">
                          <td colSpan={5 + hist.length} />
                        </tr>
                      )}
                      {grouped && groupHead(g.start, gi)}
                      {/* One keyed list, so the typing row keeps its inputs when it becomes a real row. */}
                      {(gi === groups.length - 1 ? [...g.rows, rows.length] : g.rows).map((i) => rowView(i))}
                      {grouped && (
                        <tr class="subtotal">
                          <td class="grip" />
                          <td class="sno" />
                          <td class="desc">Subtotal, group {gi + 1}</td>
                          <td class="amt">{groupIndian(billTotal(g.rows.map((i) => rows[i])))}/-</td>
                          <td class="act" />
                          {hist.map((h) => (
                            <td key={h.year} class="amt hist">
                              {groupIndian(g.rows.reduce((t, i) => t + h.counted[i], 0))}/-
                            </td>
                          ))}
                        </tr>
                      )}
                    </tbody>
                  ))}
                  <tfoot>
                    <tr>
                      <td />
                      <td />
                      <td class="desc">{grouped ? `Total of all ${groups.length} groups` : 'Total'}</td>
                      <td class="amt">{groupIndian(total)}/-</td>
                      <td />
                      {hist.map((h) => (
                        <td key={h.year} class="amt hist">
                          {groupIndian(h.total)}/-
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
              {money && (
                <PaymentStrip
                  s={s}
                  year={year}
                  client={info.name}
                  folder={type!.folder}
                  bill={bill}
                  billed={total}
                  payments={money.payments}
                  onChanged={() => attempt(async () => setMoney(await s.ws.payments(year, info.name, type!.folder, bill)))}
                />
              )}
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
            <button class="util-item" disabled={!bill} onClick={() => (setShowUtility(false), showVersions())}>
              <b>Earlier versions of the bill…</b>
              <span>Go back to how {bill ?? 'the bill'} was earlier (kept every 10 minutes of work).</span>
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

/** Six dots: the usual sign that something can be dragged. */
function Grip() {
  return (
    <svg class="grip-dots" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true">
      {[2, 7, 12].map((y) => [<circle key={`a${y}`} cx="2" cy={y} r="1.3" />, <circle key={`b${y}`} cx="6" cy={y} r="1.3" />])}
    </svg>
  );
}

function GripButton({ label, onPointerDown }: { label: string; onPointerDown: (e: PointerEvent) => void }) {
  return (
    <span class="grip-btn" role="button" aria-label={label} title="Drag to move" onPointerDown={onPointerDown}>
      <Grip />
    </span>
  );
}

interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
}

/** The ⋯ button of a row and its menu. */
function RowMenu({ label, open, onOpen, items }: { label: string; open: boolean; onOpen: (open: boolean) => void; items: MenuItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Open upwards when there is no room below (rows near the bottom of the window).
    const scroller = ref.current?.closest('.grid-wrap') ?? document.documentElement;
    setUp(ref.current!.getBoundingClientRect().bottom + 200 > scroller.getBoundingClientRect().bottom);
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onOpen(false);
    window.addEventListener('pointerdown', outside);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => window.removeEventListener('pointerdown', outside);
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onOpen(false);
      ref.current?.querySelector<HTMLElement>('.menu-btn')?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
    }
  };
  return (
    <div class={`row-menu ${up ? 'up' : ''}`} ref={ref} onKeyDown={onKey}>
      <button type="button" class="menu-btn" tabIndex={-1} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div class="menu" role="menu" aria-label={label}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              class={it.danger ? 'danger' : ''}
              onClick={() => {
                onOpen(false);
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** An amount as shown while typing: whole numbers with Indian commas (25,000; 1,25,000). */
function withCommas(a: string): string {
  return /^-?\d+$/.test(a) && String(Number(a)) === a ? groupIndian(Number(a)) : a;
}
