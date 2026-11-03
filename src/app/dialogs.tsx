import { useEffect, useState } from 'preact/hooks';
import { Client, checkName, UserError } from '../core/workspace';
import { writeDropdowns } from '../core/config';
import { sameName } from '../core/sort';
import { InsertPlan, planInsert, planRename, samePlan } from '../core/serial';
import { Session } from './session';
import { Modal, attempt, busy, setBusyLabel, toast } from './ui';

function nameProblem(name: string): string | null {
  try {
    checkName(name);
    return null;
  } catch (e) {
    return e instanceof UserError ? e.message : 'Invalid name.';
  }
}

// ---------- S.No. of a new or renamed client ----------

/**
 * Java's "Late entry" checkbox, shown as its two outcomes: the alphabetical number
 * (renumbering the clients after it) or a lettered one that changes nobody else,
 * for when the year's index sheet or bills are already printed.
 */
function SerialChoice({ year, existing, renumber, keep, value, onChange }: {
  year: string; existing: Client[]; renumber: InsertPlan; keep: InsertPlan; value: boolean; onChange: (keep: boolean) => void;
}) {
  const changes = (p: InsertPlan) => {
    const moved = existing.filter((c) => p.updates.has(c.name)).map((c) => `${c.name} ${c.serial} → ${p.updates.get(c.name)}`);
    if (moved.length === 0) return 'No other client’s S.No. changes.';
    const shown = moved.slice(0, 3).join(', ');
    return `Also changes ${shown}${moved.length > 3 ? ` and ${moved.length - 3} more` : ''}.`;
  };
  if (!needsChoice(renumber, keep)) {
    return (
      <p class="serial-single">
        S.No. <b>{renumber.serial}</b> <span class="hint">{changes(renumber)}</span>
      </p>
    );
  }
  return (
    <fieldset class="serial-choice">
      <legend>S.No.</legend>
      <label class="check">
        <input type="radio" name="serial" checked={!value} onChange={() => onChange(false)} />
        <span>
          <b>{renumber.serial}</b>, in alphabetical order <span class="hint">{changes(renumber)}</span>
        </span>
      </label>
      <label class="check">
        <input type="radio" name="serial" checked={value} onChange={() => onChange(true)} />
        <span>
          <b>{keep.serial}</b>, keeping everyone else’s S.No.{' '}
          <span class="hint">For when the index sheet or bills of {year} are already printed. (The desktop version calls this “Late entry”.)</span>
        </span>
      </label>
    </fieldset>
  );
}

const entriesOf = (clients: Client[]) => clients.map((c) => ({ name: c.name, serial: c.serial }));

/** Only worth asking when the alphabetical number would change someone else's. */
const needsChoice = (renumber: InsertPlan, keep: InsertPlan) => renumber.updates.size > 0 && !samePlan(renumber, keep);

// ---------- Add client ----------

export function AddClientDialog({ s, year, existing, onClose, onAdded }: {
  s: Session; year: string; existing: Client[]; onClose: () => void; onAdded: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [late, setLate] = useState(false);
  const duplicate = existing.some((c) => sameName(c.name, name.trim()));
  const problem = name.trim() === '' ? null : duplicate ? 'This name already exists.' : nameProblem(name);
  const can = name.trim() !== '' && !problem;
  const upper = name.trim().toUpperCase();
  const plans = can ? { renumber: planInsert(entriesOf(existing), upper, false), keep: planInsert(entriesOf(existing), upper, true) } : null;
  const submit = () => {
    if (!can) return;
    busy('Adding…', async () => {
      const c = await s.ws.addClient(year, name, late && !!plans && needsChoice(plans.renumber, plans.keep));
      toast(`${c.name} added with S.No. ${c.serial}.`, 'ok');
      onAdded(c.name);
    });
  };
  return (
    <Modal
      title={`Add new client — ${year}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button class="primary" disabled={!can} onClick={submit}>
            Add
          </button>
        </>
      }
    >
      <label class="field">
        <span>Name</span>
        <input class="upper" autoFocus value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
      {problem && <p class="warn">{problem}</p>}
      {plans && <SerialChoice year={year} existing={existing} {...plans} value={late} onChange={setLate} />}
      <p class="hint">Bills this client had in the previous years are brought in automatically.</p>
    </Modal>
  );
}

// ---------- Modify client ----------

export function ModifyClientDialog({ s, year, client, existing, onClose, onDone }: {
  s: Session; year: string; client: Client; existing: Client[]; onClose: () => void; onDone: (name: string) => void;
}) {
  const [name, setName] = useState(client.name);
  const [billNo, setBillNo] = useState(client.billNo);
  const [late, setLate] = useState(false);
  const renamed = name.trim().toUpperCase() !== client.name;
  const collides = renamed && existing.some((c) => c.name !== client.name && sameName(c.name, name.trim()));
  const problem = renamed ? nameProblem(name) : null;
  const upper = name.trim().toUpperCase();
  const plans =
    renamed && !collides && !problem
      ? { renumber: planRename(entriesOf(existing), client.name, upper, false), keep: planRename(entriesOf(existing), client.name, upper, true) }
      : null;
  const submit = () => {
    if (problem) return;
    busy('Saving…', async () => {
      const keep = late && !!plans && needsChoice(plans.renumber, plans.keep);
      const n = await s.ws.modifyClient(year, client.name, renamed ? name : client.name, billNo.trim().toUpperCase(), keep);
      toast(renamed ? `Renamed to ${n}.` : 'Saved.', 'ok');
      onDone(n);
    });
  };
  return (
    <Modal
      title={`Modify ${client.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button class="primary" disabled={!!problem} onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <label class="field">
        <span>Name</span>
        <input class="upper" autoFocus value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
      {problem && <p class="warn">{problem}</p>}
      {collides && (
        <p class="warn">
          A client with this name already exists. {client.name}'s bills will be moved into it (bills with the same name are overwritten) and {client.name} will be
          removed.
        </p>
      )}
      <label class="field">
        <span>Bill No.</span>
        <input class="upper" value={billNo} onInput={(e) => setBillNo((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
      {plans && <SerialChoice year={year} existing={existing} {...plans} value={late} onChange={setLate} />}
      <p class="hint">Renaming only changes {year}; earlier years keep the old name.</p>
    </Modal>
  );
}

// ---------- Delete clients ----------

export function DeleteClientsDialog({ s, year, clients, onClose, onDone }: {
  s: Session; year: string; clients: Client[]; onClose: () => void; onDone: () => void;
}) {
  const [picked, setPicked] = useState(() => new Set(clients.map((c) => c.name)));
  const submit = () =>
    busy('Deleting…', async () => {
      const names = clients.filter((c) => picked.has(c.name)).map((c) => c.name);
      await s.ws.deleteClients(year, names);
      toast(`Deleted ${names.length} client${names.length === 1 ? '' : 's'}.`, 'ok');
      onDone();
    });
  return (
    <Modal
      title="Delete clients?"
      onClose={onClose}
      footer={
        <>
          <button autoFocus onClick={onClose}>
            No
          </button>
          <button class="danger" disabled={picked.size === 0} onClick={submit}>
            Delete {picked.size}
          </button>
        </>
      }
    >
      <p>
        These clients and all their bills for <b>{year}</b> will be deleted. Other years are not affected.
      </p>
      <ClientChecklist clients={clients} picked={picked} setPicked={setPicked} />
    </Modal>
  );
}

function ClientChecklist({ clients, picked, setPicked }: { clients: Client[]; picked: Set<string>; setPicked: (s: Set<string>) => void }) {
  const toggle = (n: string) => {
    const p = new Set(picked);
    if (p.has(n)) p.delete(n);
    else p.add(n);
    setPicked(p);
  };
  const all = clients.length > 0 && clients.every((c) => picked.has(c.name));
  return (
    <div class="checklist">
      <table>
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={all}
                onChange={() => setPicked(all ? new Set() : new Set(clients.map((c) => c.name)))}
              />
            </th>
            <th>S.No.</th>
            <th>Name</th>
            <th>Bill No.</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.name} onClick={() => toggle(c.name)}>
              <td>
                <input type="checkbox" checked={picked.has(c.name)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(c.name)} />
              </td>
              <td class="num">{c.serial}</td>
              <td>{c.name}</td>
              <td>{c.billNo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Copy data between years ----------

export function CopyYearsDialog({ s, years, current, onClose, onDone }: {
  s: Session; years: string[]; current: string; onClose: () => void; onDone: (to: string) => void;
}) {
  const idx = years.indexOf(current);
  const [from, setFrom] = useState(current);
  const [to, setTo] = useState(years[idx + 1] ?? years[years.length - 1]);
  const [plan, setPlan] = useState<{ fresh: Client[]; collided: Client[] } | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPlan(null);
    if (from === to) return;
    let live = true;
    attempt(async () => {
      const p = await s.ws.planCopy(from, to);
      if (!live) return;
      setPlan(p);
      setFresh(new Set(p.fresh.map((c) => c.name)));
      setOver(new Set());
    });
    return () => {
      live = false;
    };
  }, [from, to]);

  const total = fresh.size + over.size;
  const submit = () =>
    busy('Copying…', async () => {
      const names = [...(plan?.fresh ?? []), ...(plan?.collided ?? [])].map((c) => c.name).filter((n) => fresh.has(n) || over.has(n));
      await s.ws.copyClients(from, to, names, (d) => setBusyLabel(`Copying… ${d} of ${names.length}`));
      toast(`Copied ${names.length} client${names.length === 1 ? '' : 's'} to ${to}.`, 'ok');
      onDone(to);
    });

  const yearSelect = (v: string, set: (v: string) => void, label: string) => (
    <label class="field inline">
      <span>{label}</span>
      <select value={v} onChange={(e) => set((e.target as HTMLSelectElement).value)}>
        {years.map((y) => (
          <option key={y}>{y}</option>
        ))}
      </select>
    </label>
  );

  return (
    <Modal
      title="Copy clients to another year"
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button class="primary" disabled={!plan || total === 0} onClick={submit}>
            Copy {total || ''}
          </button>
        </>
      }
    >
      <div class="row left">
        {yearSelect(from, setFrom, 'From')}
        {yearSelect(to, setTo, 'To')}
      </div>
      <p class="hint">
        Copies each client with its S.No., Bill No. and bills. Bills are rebuilt from the last three years with amounts set to 0; the earlier amounts
        show alongside when you open the bill.
      </p>
      {from === to && <p class="warn">Choose two different years.</p>}
      {plan && (
        <>
          <h3>Not yet in {to}</h3>
          {plan.fresh.length ? <ClientChecklist clients={plan.fresh} picked={fresh} setPicked={setFresh} /> : <p class="hint">None — every client is already in {to}.</p>}
          {plan.collided.length > 0 && (
            <>
              <h3>Already in {to}</h3>
              <p class="hint">Tick a client to replace its {to} bills with a fresh copy (its current {to} bills are deleted).</p>
              <ClientChecklist clients={plan.collided} picked={over} setPicked={setOver} />
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------- Drop-down lists ----------

export function DropdownDialog({ s, onClose, onSaved }: { s: Session; onClose: () => void; onSaved?: () => void }) {
  const [lists, setLists] = useState<Map<string, string[]> | null>(null);
  const [tab, setTab] = useState(s.types[0]?.tab ?? '');
  useEffect(() => {
    attempt(async () => {
      const m = new Map<string, string[]>();
      for (const t of s.types) m.set(t.tab, await s.ws.dropdown(t.tab, '##'));
      setLists(m);
    });
  }, []);
  const items = lists?.get(tab) ?? [];
  const set = (next: string[]) => setLists(new Map(lists!).set(tab, next));
  const save = () =>
    attempt(async () => {
      await writeDropdowns(s.program, s.types, lists!);
      toast('Drop-down lists saved.', 'ok');
      (onSaved ?? onClose)();
    });
  const move = (i: number, d: number) => {
    const n = [...items];
    const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    set(n);
  };
  return (
    <Modal
      title="Edit drop-down lists"
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button class="primary" disabled={!lists} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <p class="hint">These are offered while typing a bill's Field. Type ## where the year should appear.</p>
      <div class="tabs" role="tablist">
        {s.types.map((t) => (
          <button key={t.tab} role="tab" aria-selected={t.tab === tab} class={t.tab === tab ? 'tab active' : 'tab'} onClick={() => setTab(t.tab)}>
            {t.tab}
          </button>
        ))}
      </div>
      <div class="dd-list">
        {items.map((it, i) => (
          <div class="dd-row" key={`${tab}-${i}`}>
            <input
              value={it}
              aria-label={`Entry ${i + 1}`}
              onInput={(e) => {
                const n = [...items];
                n[i] = (e.target as HTMLInputElement).value;
                set(n);
              }}
            />
            <button class="icon-btn" title="Move up" aria-label="Move up" onClick={() => move(i, -1)}>
              ↑
            </button>
            <button class="icon-btn" title="Move down" aria-label="Move down" onClick={() => move(i, 1)}>
              ↓
            </button>
            <button class="icon-btn" title="Remove" aria-label="Remove" onClick={() => set(items.filter((_, k) => k !== i))}>
              ×
            </button>
          </div>
        ))}
        <button onClick={() => set([...items, ''])}>+ Add entry</button>
      </div>
    </Modal>
  );
}
