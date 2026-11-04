import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Client, Problem } from '../core/webstore';
import { financialYearOf, nextYear } from '../core/years';
import { Session } from './session';
import { AddClientDialog, CopyYearsDialog, DeleteClientsDialog, ModifyClientDialog } from './dialogs';
import { UtilityDialog } from './utility';
import { printBills, printIndex } from './printing';
import { groupIndian } from '../core/money';
import { billNoClashes } from '../core/billno';
import { KeysDialog, OpenAt, SearchDialog } from './search';
import { attempt, busy, confirmDialog, promptDialog, toast } from './ui';

type Dialog =
  | { kind: 'add' }
  | { kind: 'modify'; client: Client }
  | { kind: 'delete'; clients: Client[] }
  | { kind: 'utility' }
  | { kind: 'copy' }
  | { kind: 'search' }
  | { kind: 'keys' }
  | null;

interface Props {
  s: Session;
  year: string | null;
  setYear: (y: string | null) => void;
  onOpen: (client: Client) => void;
  /** Opens a client of any year, at a bill (from search or the payments page). */
  onOpenAt: (at: OpenAt) => void;
  onPayments: () => void;
  onExit: () => void;
  onSession: (s: Session) => void;
  focusName?: string | null;
}

export function Main({ s, year, setYear, onOpen, onOpenAt, onPayments, onExit, onSession, focusName }: Props) {
  const [years, setYears] = useState<string[] | null>(null);
  const [clients, setClients] = useState<Client[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const tableRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<Dialog>(null);
  dialogRef.current = dialog;

  const loadYears = async () => {
    const ys = await s.ws.years();
    setYears(ys);
    if (!year || !ys.includes(year)) setYear(ys.length ? ys[ys.length - 1] : null);
    return ys;
  };

  const loadClients = async (keep?: string[]) => {
    // The year may have just disappeared (e.g. after switching the data folder).
    if (!year || !(await s.ws.years()).includes(year)) {
      setClients([]);
      return;
    }
    const list = await s.ws.clients(year);
    setClients((old) => (old && JSON.stringify(old) === JSON.stringify(list) ? old : list));
    const p = s.ws.problems().filter((x) => x.year === year);
    setProblems((old) => (JSON.stringify(old) === JSON.stringify(p) ? old : p));
    if (keep) {
      const names = new Set(keep);
      setSelected(names);
      const i = list.findIndex((c) => names.has(c.name));
      if (i >= 0) {
        setCursor(i);
        setAnchor(i);
      }
    }
  };

  useEffect(() => {
    attempt(loadYears);
  }, [s]);

  useEffect(() => {
    setClients(null);
    setSelected(new Set());
    setCursor(0);
    attempt(() => loadClients(focusName ? [focusName] : undefined));
  }, [year, s]);

  // Pick up changes made by other computers (or the Java program).
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible' || dialogRef.current || editing) return;
      loadYears().then(() => loadClients()).catch(() => undefined);
    };
    const id = window.setInterval(tick, 5000);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
    };
  }, [year, s, editing]);

  useEffect(() => {
    if (!dialog) tableRef.current?.focus();
  }, [dialog, clients === null]);

  // Keep the cursor row visible.
  useEffect(() => {
    tableRef.current?.querySelector(`[data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor, clients]);

  const list = clients ?? [];
  const clashes = useMemo(() => billNoClashes(list), [list]);
  const current = list[cursor] as Client | undefined;
  const chosen = useMemo(() => list.filter((c) => selected.has(c.name)), [list, selected]);
  const targets = chosen.length ? chosen : current ? [current] : [];

  const select = (i: number, mode: 'one' | 'toggle' | 'range') => {
    if (!list.length) return;
    i = Math.max(0, Math.min(list.length - 1, i));
    setCursor(i);
    if (mode === 'one') {
      setSelected(new Set([list[i].name]));
      setAnchor(i);
    } else if (mode === 'toggle') {
      const n = new Set(selected);
      if (n.has(list[i].name)) n.delete(list[i].name);
      else n.add(list[i].name);
      setSelected(n);
      setAnchor(i);
    } else {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      setSelected(new Set(list.slice(a, b + 1).map((c) => c.name)));
    }
  };

  const after = (keep?: string[]) => {
    setDialog(null);
    attempt(() => loadClients(keep));
  };

  const addFirstYear = () =>
    attempt(async () => {
      const y = await promptDialog({
        title: 'Add the first year',
        label: 'Year (like 26-27)',
        value: financialYearOf(new Date()),
        validate: (v) => (/^\d{2}-\d{2}$/.test(v.trim()) ? null : 'Write the year like 26-27.'),
      });
      if (!y) return;
      await s.ws.addYear(y.trim());
      setYear(y.trim());
      await loadYears();
    });

  const addNextYear = async () => {
    const last = years?.[years.length - 1];
    if (!last) return addFirstYear();
    const next = nextYear(last);
    if (!next) return toast('Cannot add a year after 99.', 'error');
    const ok = await confirmDialog({ title: 'Add next year', message: <p>Add the year <b>{next}</b> to the list?</p>, ok: `Add ${next}` });
    if (!ok) return;
    await busy('Adding year…', async () => {
      await s.ws.addNextYear();
      await loadYears();
      toast(`Added year ${next}. Use “Copy clients to another year” to bring clients forward.`, 'ok');
    });
  };

  const saveBillNo = (c: Client, value: string) =>
    attempt(async () => {
      setEditing(null);
      if (value === c.billNo) return;
      await s.ws.setBillNo(year!, c.name, value);
      await loadClients();
    });

  const onKey = (e: KeyboardEvent) => {
    if (editing) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      select(cursor + (k === 'ArrowDown' ? 1 : -1), e.shiftKey ? 'range' : 'one');
    } else if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault();
      select(cursor + (k === 'PageDown' ? 15 : -15), e.shiftKey ? 'range' : 'one');
    } else if (k === 'Home' || k === 'End') {
      e.preventDefault();
      select(k === 'Home' ? 0 : list.length - 1, e.shiftKey ? 'range' : 'one');
    } else if (k === 'Enter') {
      e.preventDefault();
      if (current) onOpen(current);
    } else if (k === 'Insert' || (e.altKey && k.toLowerCase() === 'n')) {
      e.preventDefault();
      if (year) setDialog({ kind: 'add' });
    } else if (k === 'F2' || (e.altKey && k.toLowerCase() === 'm')) {
      e.preventDefault();
      if (current) setDialog({ kind: 'modify', client: current });
    } else if (k === 'Delete') {
      e.preventDefault();
      if (targets.length) setDialog({ kind: 'delete', clients: targets });
    } else if (ctrl && k.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(list.map((c) => c.name)));
    } else if (ctrl && k.toLowerCase() === 'p') {
      e.preventDefault();
      if (targets.length && year) printBills(s, year, targets);
    } else if (e.altKey && k.toLowerCase() === 'u') {
      e.preventDefault();
      setDialog({ kind: 'utility' });
    } else if (e.altKey && k.toLowerCase() === 'p') {
      e.preventDefault();
      onPayments();
    } else if (ctrl && e.shiftKey && k.toLowerCase() === 'f') {
      e.preventDefault();
      setDialog({ kind: 'search' });
    } else if (k === '?') {
      e.preventDefault();
      setDialog({ kind: 'keys' });
    } else if (e.altKey && k.toLowerCase() === 'q') {
      e.preventDefault();
      onExit();
    } else if (!ctrl && !e.altKey && k.length === 1 && /[\p{L}\p{N}]/u.test(k)) {
      e.preventDefault();
      setQuery(k);
      searchRef.current?.focus();
      jumpTo(k);
    }
  };

  // Shortcuts also work when the list itself does not have the focus
  // (but not while typing in a box, or when a dialog is open).
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (document.querySelector('.backdrop')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('.table-wrap') || t.closest('input, textarea, select'))) return;
      keyRef.current(e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const jumpTo = (q: string) => {
    const t = q.trim().toLowerCase();
    if (!t) return;
    const i = list.findIndex((c) => c.name.toLowerCase().includes(t));
    if (i >= 0) select(i, 'one');
  };

  if (years === null) return <div class="loading">Loading…</div>;

  return (
    <div class="screen">
      <header class="topbar">
        <div class="brand">Utility Soft</div>
        {years.length > 0 && (
          <div class="year-picker">
            <button class="icon-btn" title="Previous year" aria-label="Previous year" disabled={years.indexOf(year!) <= 0} onClick={() => setYear(years[years.indexOf(year!) - 1])}>
              ‹
            </button>
            <select aria-label="Year" value={year ?? ''} onChange={(e) => setYear((e.target as HTMLSelectElement).value)}>
              {years.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
            <button
              class="icon-btn"
              title="Next year"
              aria-label="Next year"
              disabled={years.indexOf(year!) >= years.length - 1}
              onClick={() => setYear(years[years.indexOf(year!) + 1])}
            >
              ›
            </button>
          </div>
        )}
        <div class="search">
          <input
            ref={searchRef}
            type="search"
            placeholder="Quick search (just start typing)"
            aria-label="Quick search"
            value={query}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              setQuery(v);
              jumpTo(v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (current) onOpen(current);
              } else if (e.key === 'Escape' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setQuery('');
                tableRef.current?.focus();
              }
            }}
          />
        </div>
        <button onClick={() => setDialog({ kind: 'search' })} title="Search all years (Ctrl+Shift+F)">
          Search all years…
        </button>
        <div class="spacer" />
        <button class="icon-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setDialog({ kind: 'keys' })}>
          ?
        </button>
        <button onClick={() => setDialog({ kind: 'utility' })} title="Utility (Alt+U)">
          Utility…
        </button>
        <button onClick={onExit} title="Exit (Alt+Q)">
          Exit
        </button>
      </header>

      {problems.length > 0 && (
        <div class="problems" role="alert">
          {problems.map((p) => (
            <p key={p.path}>
              {p.name ? (
                <>
                  The file of <b>{p.name}</b> ({p.year}) cannot be read: it is damaged or was changed outside Utility Soft, so the client is not in the
                  list.
                </>
              ) : (
                <>A client file of {p.year} cannot be read (it is damaged), so that client is not in the list.</>
              )}{' '}
              {p.restorable ? (
                <button
                  onClick={() =>
                    attempt(async () => {
                      const n = await s.ws.restoreDamaged(p);
                      toast(`${n} is back, as last saved before the damage.`, 'ok');
                      await loadClients([n]);
                    })
                  }
                >
                  Put back its last good version
                </button>
              ) : (
                <span>Restore a backup (Utility ▸ Backups) to get it back.</span>
              )}
            </p>
          ))}
        </div>
      )}
      {years.length === 0 ? (
        <div class="empty">
          <p>There are no years yet.</p>
          <button class="primary" onClick={addFirstYear}>
            Add the first year…
          </button>
        </div>
      ) : (
        <>
          <div class="toolbar">
            <button class="primary" disabled={!current} onClick={() => current && onOpen(current)} title="Open bills (Enter)">
              Open
            </button>
            <button onClick={() => setDialog({ kind: 'add' })} title="Add new client (Insert or Alt+N)">
              Add new
            </button>
            <button disabled={!current} onClick={() => current && setDialog({ kind: 'modify', client: current })} title="Rename or change Bill No. (F2 or Alt+M)">
              Modify
            </button>
            <button disabled={!targets.length} onClick={() => setDialog({ kind: 'delete', clients: targets })} title="Delete selected clients (Delete)">
              Delete
            </button>
            <span class="sep" />
            <button disabled={!targets.length} onClick={() => printBills(s, year!, targets)} title="Print all bills of the selected clients (Ctrl+P)">
              Print bills
            </button>
            <button onClick={() => printIndex(s, year!)} title="Print the index sheet of this year">
              Print index
            </button>
            <span class="sep" />
            <button onClick={() => onPayments()} title="Who has paid, and what is due (Alt+P)">
              Payments
            </button>
          </div>
          <div class="table-wrap" tabIndex={0} ref={tableRef} onKeyDown={onKey} aria-label="Clients" role="grid">
            <table class="clients">
              <thead>
                <tr>
                  <th class="sno">S.No.</th>
                  <th>Name</th>
                  <th class="billno">Bill No.</th>
                  <th class="money">Billed</th>
                  <th class="money">Due</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c, i) => (
                  <tr
                    key={c.name}
                    data-row={i}
                    class={`${selected.has(c.name) ? 'selected' : ''} ${i === cursor ? 'cursor' : ''}`}
                    aria-selected={selected.has(c.name)}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      select(i, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'one');
                    }}
                    onDblClick={(e) => {
                      if ((e.target as HTMLElement).closest('.billno')) setEditing(c.name);
                      else onOpen(c);
                    }}
                  >
                    <td class="sno">{c.serial}</td>
                    <td class="name">{c.name}</td>
                    <td
                      class={`billno ${clashes.has(c.name) ? 'clash' : ''}`}
                      title={clashes.has(c.name) ? `Same Bill No. as ${clashes.get(c.name)!.join(', ')}. Double-click to edit.` : 'Double-click to edit'}
                    >
                      {editing === c.name ? (
                        <BillNoInput value={c.billNo} onDone={(v) => (v === null ? setEditing(null) : saveBillNo(c, v))} />
                      ) : (
                        c.billNo
                      )}
                    </td>
                    <td class="money">{c.billed ? groupIndian(c.billed) : ''}</td>
                    <td class={`money ${c.due && c.due > 0 ? 'due' : ''}`}>{c.billed ? (c.due! > 0 ? groupIndian(c.due!) : c.due! < 0 ? `${groupIndian(-c.due!)} extra` : 'Paid') : ''}</td>
                  </tr>
                ))}
              </tbody>
              {list.length > 0 && (
                <tfoot>
                  <tr>
                    <td />
                    <td>Total</td>
                    <td />
                    <td class="money">{groupIndian(list.reduce((t, c) => t + (c.billed ?? 0), 0))}</td>
                    <td class="money">{groupIndian(list.reduce((t, c) => t + Math.max(0, c.due ?? 0), 0))}</td>
                  </tr>
                </tfoot>
              )}
            </table>
            {clients !== null && list.length === 0 && (
              <div class="empty">
                <p>No clients in {year} yet.</p>
                <div class="row">
                  <button class="primary" onClick={() => setDialog({ kind: 'add' })}>
                    Add new client
                  </button>
                  {years.length > 1 && <button onClick={() => setDialog({ kind: 'copy' })}>Copy clients from another year…</button>}
                </div>
              </div>
            )}
          </div>
        </>
      )}
      <footer class="statusbar">
        <span>
          {list.length} client{list.length === 1 ? '' : 's'}
          {selected.size > 1 ? ` · ${selected.size} selected` : ''}
        </span>
        <span class="grow" />
        <span title="Data folder">Data: {s.dataLabel}</span>
      </footer>

      {dialog?.kind === 'add' && year && (
        <AddClientDialog s={s} year={year} existing={list} onClose={() => setDialog(null)} onAdded={(n) => after([n])} />
      )}
      {dialog?.kind === 'modify' && year && (
        <ModifyClientDialog s={s} year={year} client={dialog.client} existing={list} onClose={() => setDialog(null)} onDone={(n) => after([n])} />
      )}
      {dialog?.kind === 'delete' && year && (
        <DeleteClientsDialog s={s} year={year} clients={dialog.clients} onClose={() => setDialog(null)} onDone={() => after([])} />
      )}
      {dialog?.kind === 'copy' && year && years && (
        <CopyYearsDialog
          s={s}
          years={years}
          current={year}
          onClose={() => setDialog(null)}
          onDone={(to) => {
            setDialog(null);
            setYear(to);
          }}
        />
      )}
      {dialog?.kind === 'search' && <SearchDialog s={s} onClose={() => setDialog(null)} onOpen={(h) => (setDialog(null), onOpenAt(h))} />}
      {dialog?.kind === 'keys' && <KeysDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'utility' && (
        <UtilityDialog
          s={s}
          year={year}
          selection={targets}
          onClose={() => after()}
          onCopy={() => setDialog({ kind: 'copy' })}
          onNextYear={() => {
            setDialog(null);
            addNextYear();
          }}
          onSession={(ns) => {
            setDialog(null);
            onSession(ns);
          }}
          onExit={() => {
            setDialog(null);
            onExit();
          }}
        />
      )}
    </div>
  );
}

function BillNoInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (r: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(r);
  };
  return (
    <input
      class="cell-input"
      autoFocus
      aria-label="Bill No."
      value={v}
      onInput={(e) => setV((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(v);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(v)}
      onMouseDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
    />
  );
}
