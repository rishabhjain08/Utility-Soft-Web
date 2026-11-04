// Searching every year, and the list of keyboard shortcuts.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Hit, searchAll } from '../core/search';
import { Session } from './session';
import { Modal, attempt } from './ui';

/** Where to open: a client of a year, at a bill if given. */
export interface OpenAt {
  year: string;
  client: string;
  folder?: string;
  bill?: string;
}

export function SearchDialog({ s, onClose, onOpen }: { s: Session; onClose: () => void; onOpen: (at: OpenAt) => void }) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<{ hits: Hit[]; more: boolean } | null>(null);
  const [hi, setHi] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const t = window.setTimeout(
      () =>
        attempt(async () => {
          const r = await searchAll(s.ws, q);
          if (n === seq.current) {
            setResult(r);
            setHi(0);
          }
        }),
      200,
    );
    return () => window.clearTimeout(t);
  }, [q]);
  const hits = result?.hits ?? [];
  const open = (h: Hit) => onOpen({ year: h.year, client: h.client, folder: h.folder, bill: h.bill });
  return (
    <Modal title="Search all years" wide onClose={onClose}>
      <label class="field">
        <span>Client name, bill name or any text in a bill</span>
        <input
          autoFocus
          type="search"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(hits.length - 1, h + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
            else if (e.key === 'Enter' && hits[hi]) open(hits[hi]);
          }}
        />
      </label>
      {q.trim().length >= 2 && result && (
        <>
          <p class="hint">{hits.length === 0 ? 'Nothing found.' : `${hits.length}${result.more ? '+' : ''} found. Enter or click to open.`}</p>
          <ul class="search-hits" role="listbox" aria-label="Found">
            {hits.map((h, i) => (
              <li key={i} role="option" aria-selected={i === hi} class={i === hi ? 'hi' : ''} onMouseEnter={() => setHi(i)} onClick={() => open(h)}>
                <span class="sh-year">{h.year}</span>
                <span class="sh-where">
                  <b>{h.client}</b>
                  {h.bill && (
                    <>
                      {' '}
                      › {h.tab} › {h.bill}
                    </>
                  )}
                </span>
                {h.what === 'row' && <span class="sh-text">{h.text}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

const KEYS: [string, [string, string][]][] = [
  [
    'Client list',
    [
      ['Open client', 'Enter or double-click'],
      ['Add new client', 'Insert or Alt+N'],
      ['Modify (name, Bill No., details)', 'F2 or Alt+M'],
      ['Delete', 'Delete'],
      ['Select several', 'Ctrl+click, Shift+click, Shift+↑↓'],
      ['Quick search', 'Start typing'],
      ['Search all years', 'Ctrl+Shift+F'],
      ['Print bills of the selected clients', 'Ctrl+P'],
      ['Payments', 'Alt+P'],
      ['Utility', 'Alt+U'],
      ['Exit', 'Alt+Q'],
    ],
  ],
  [
    'Bill',
    [
      ['Next cell', 'Enter, ↑ ↓'],
      ['All drop-down entries', 'Ctrl+Space'],
      ['Undo / redo', 'Ctrl+Z / Ctrl+Y'],
      ['Insert row / delete row', 'Ctrl+I / Ctrl+Delete'],
      ['Move row up / down', 'Alt+↑ / Alt+↓'],
      ['New group at this row', 'Ctrl+B'],
      ['New bill / Bill utility', 'Alt+N / Alt+U'],
      ['Print this bill', 'Ctrl+P'],
      ['Next year', 'Alt+→'],
      ['Done', 'Alt+← or Esc'],
    ],
  ],
];

export function KeysDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" wide onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <div class="keys">
        {KEYS.map(([title, rows]) => (
          <section key={title}>
            <h3>{title}</h3>
            <table>
              <tbody>
                {rows.map(([what, keys]) => (
                  <tr key={what}>
                    <td>{what}</td>
                    <td>
                      <kbd>{keys}</kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Modal>
  );
}
