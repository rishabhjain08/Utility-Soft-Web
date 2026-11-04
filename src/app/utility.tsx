import { useEffect, useState } from 'preact/hooks';
import { FsDir } from '../core/fs';
import { BinEntry, Client, WebBooks } from '../core/webstore';
import { backupFolderName } from '../core/util';
import { BackupEntry, checkBackup, insideBackups, isBackup, listBackups, makeBackup, openBackup, pruneBackups, restoreBackup } from '../core/backup';
import { compare, webSide } from '../core/verify';
import { Session, nameThisComputer, refreshSession, thisComputer } from './session';
import { ReportView, compareFlow, exportFlow } from './migrate';
import { RecoverySetup } from './recovery';
import { DropdownDialog } from './dialogs';
import { LetterheadForm } from './start';
import { Prefs, hasRememberedPath, loadPrefs, pickFolder, rememberPath, rememberedPath, savePrefs } from './folders';
import { printBills, printIndex } from './printing';
import { Modal, attempt, busy, confirmDialog, mountDialog, promptDialog, setBusyLabel, toast } from './ui';

type Sub = 'dropdowns' | 'letterhead' | 'password' | 'backup' | 'bin' | 'log' | 'recovery' | 'tabs' | null;

interface Props {
  s: Session;
  year: string | null;
  selection: Client[];
  onClose: () => void;
  onCopy: () => void;
  onNextYear: () => void;
  onSession: (s: Session) => void;
  onExit: () => void;
}

export function UtilityDialog({ s, year, selection, onClose, onCopy, onNextYear, onSession, onExit }: Props) {
  const [sub, setSub] = useState<Sub>(null);

  if (sub === 'dropdowns') return <DropdownDialog s={s} year={year} onClose={() => setSub(null)} onSaved={onClose} />;
  if (sub === 'letterhead')
    return (
      <Modal title="Letterhead" onClose={() => setSub(null)} class="letterhead-modal">
        <LetterheadForm
          save={(lh) => s.ws.saveLetterhead(lh)}
          initial={s.letterhead}
          year={year}
          embedded
          onSkip={() => setSub(null)}
          onDone={() => attempt(async () => onSession(await refreshSession(s)))}
        />
      </Modal>
    );
  if (sub === 'password') return <ChangePasswordDialog ws={s.ws} onClose={() => setSub(null)} onDone={(password) => onSession({ ...s, password })} />;
  if (sub === 'backup') return <BackupDialog s={s} onClose={() => setSub(null)} onRestored={() => attempt(async () => onSession(await refreshSession(s)))} />;
  if (sub === 'bin') return <BinDialog ws={s.ws} onClose={() => setSub(null)} />;
  if (sub === 'log') return <LogDialog ws={s.ws} onClose={() => setSub(null)} />;
  if (sub === 'tabs') return <TabsDialog s={s} onClose={(changed) => (changed ? attempt(async () => onSession(await refreshSession(s))) : setSub(null))} />;
  if (sub === 'recovery')
    return (
      <div class="backdrop full">
        <RecoverySetup ws={s.ws} folder={s.dataLabel} onDone={onClose} onCancel={() => setSub(null)} />
      </div>
    );

  // Someone at an unlocked computer must not be able to make a code of their own.
  const newCode = () =>
    attempt(async () => {
      const pw = await promptDialog({ title: 'New recovery code', label: 'Your password', password: true, ok: 'Continue', hint: 'The old recovery code stops working once the new one is saved.' });
      if (pw === null) return;
      if (!(await s.ws.checkPassword(pw))) return toast('Wrong password.', 'error');
      setSub('recovery');
    });

  const nameComputer = () =>
    attempt(async () => {
      const c = await thisComputer();
      const name = await promptDialog({
        title: 'This computer',
        label: 'Name of this computer',
        value: c.name,
        hint: 'Shown on other computers when a client is open here, for example “Office PC” or “Home laptop”.',
      });
      if (name === null) return;
      await nameThisComputer(name);
      toast('Saved. It is used from the next time Utility Soft is opened.', 'ok');
    });

  const item = (label: string, help: string, fn: () => void, disabled = false) => (
    <button class="util-item" onClick={fn} disabled={disabled}>
      <b>{label}</b>
      <span>{help}</span>
    </button>
  );

  return (
    <Modal title="Utility" onClose={onClose} wide>
      <div class="util-grid">
        <section>
          <h3>Years</h3>
          {item('Copy clients to another year', 'Bring clients and their bills forward to a new year.', onCopy, !year)}
          {item('Add next year', 'Add the year after the last one.', onNextYear)}
        </section>
        <section>
          <h3>Print</h3>
          {item(
            'Print the bills',
            selection.length ? `All bills of the ${selection.length} selected client${selection.length === 1 ? '' : 's'}.` : 'Select clients in the list first.',
            () => (onClose(), printBills(s, year!, selection)),
            !year || selection.length === 0,
          )}
          {item('Print the index sheet', 'List of clients with S.No. and Bill No.', () => (onClose(), printIndex(s, year!)), !year)}
        </section>
        <section>
          <h3>Safety</h3>
          {item('Backups…', 'Back up now, the automatic daily backups, and restoring one.', () => setSub('backup'))}
          {item('Deleted clients and bills…', 'Put back something deleted in the last 30 days.', () => setSub('bin'))}
          {item('Problem log', 'What went wrong and when, to send to whoever helps you.', () => setSub('log'))}
        </section>
        <section>
          <h3>Desktop version</h3>
          {item('Export for the desktop version…', 'Write everything into a new folder in the desktop (Java) format, and check it.', () => attempt(() => exportFlow(s)))}
          {item('Compare with a desktop folder…', 'List every difference between a desktop folder and this data.', () => attempt(() => compareFlow(s)))}
        </section>
        <section>
          <h3>Setup</h3>
          {item('Tabs…', 'Add, rename, reorder or hide the bill types (like Audit or Tax).', () => setSub('tabs'))}
          {item('Edit drop-down lists', 'Entries offered when typing bill fields.', () => setSub('dropdowns'))}
          {item('Letterhead', 'Firm name, address and index-sheet title.', () => setSub('letterhead'))}
        </section>
        <section>
          <h3>Security</h3>
          {item('Change password', 'Password used to open Utility Soft.', () => setSub('password'))}
          {item('New recovery code…', 'If the saved one is lost: make a new one and save it on your phone.', newCode)}
          {item('This computer’s name…', 'Shown to others when a client is open here.', nameComputer)}
        </section>
      </div>
      <div class="row">
        <span class="grow" />
        <button onClick={onExit}>Exit Utility Soft</button>
      </div>
    </Modal>
  );
}

function ChangePasswordDialog({ ws, onClose, onDone }: { ws: WebBooks; onClose: () => void; onDone: (password: string) => void }) {
  const [old, setOld] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    attempt(async () => {
      if (a === '') return setError('The new password cannot be empty.');
      if (a !== b) return setError('The two new passwords do not match.');
      const done = await busy('Changing…', async () => {
        if (!(await ws.checkPassword(old))) return false;
        await ws.setPassword(a);
        return true;
      });
      if (!done) return setError('The old password is wrong.');
      toast('Password changed.', 'ok');
      onDone(a);
    });
  const field = (label: string, v: string, set: (v: string) => void, auto = false) => (
    <label class="field">
      <span>{label}</span>
      <input type="password" autoFocus={auto} value={v} onInput={(e) => (set((e.target as HTMLInputElement).value), setError(null))} onKeyDown={(e) => e.key === 'Enter' && submit()} />
    </label>
  );
  return (
    <Modal
      title="Change password"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button class="primary" onClick={submit}>
            Change
          </button>
        </>
      }
    >
      {field('Old password', old, setOld, true)}
      {field('New password', a, setA)}
      {field('New password again', b, setB)}
      {error && <p class="warn">{error}</p>}
      <p class="hint">Backups made before keep opening with the old password (or the recovery code).</p>
    </Modal>
  );
}

// ---------- backups ----------

/** The folder for the backup on exit, asking to select it on a computer that does not know it yet. */
async function backupFolder(path: string): Promise<FsDir | null> {
  if (!path) return null;
  const remembered = await rememberedPath('backup', path, true);
  if (remembered) return remembered;
  const ok = await confirmDialog({
    title: 'Select the backup folder',
    message: (
      <p>
        Backups go to <b class="path">{path}</b>. Select that folder so the browser can use it.
      </p>
    ),
    ok: 'Select folder…',
  });
  if (!ok) return null;
  const dir = await pickFolder('utility-soft-backup');
  if (dir) await rememberPath('backup', path, dir);
  return dir;
}

/** Backup into <backup folder>\<date+time>, as the desktop version names them (on exit). Returns false if cancelled. */
export async function autoBackup(s: Session): Promise<boolean> {
  const path = await s.ws.backupPath();
  if (!path) return true;
  const dir = await backupFolder(path);
  if (!dir) return false;
  const r = await busy('Backing up…', async () => {
    const dest = await dir.dir(backupFolderName(new Date()), true);
    let n = 0;
    await makeBackup(s.ws, dest, { onFile: () => setBusyLabel(`Backing up… ${++n} files`) });
    await pruneBackups(dir);
    toast(`Backed up to ${path}\\${dest.name}.`, 'ok');
    return true;
  });
  return r === true;
}

const when = (t: number) => new Date(t).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Shows how a backup differs from now, and restores it if asked. */
async function compareAndRestore(s: Session, dir: FsDir, label: string, onRestored: () => void): Promise<void> {
  const broken = await checkBackup(dir);
  if (broken.length) {
    toast(`This backup is damaged (${broken.length} file${broken.length === 1 ? '' : 's'}). Choose another one.`, 'error');
    return;
  }
  const report = await busy('Comparing…', () => compare(webSide(openBackup(s.ws, dir)), webSide(s.ws), { onProgress: setBusyLabel, ignoreAutoBackup: true }));
  if (!report) return;
  const go = await mountDialog<boolean>((done) => (
    <Modal
      title={`Backup of ${label}`}
      wide
      onClose={() => done(false)}
      footer={
        <>
          <button onClick={() => done(false)}>Close</button>
          <button class="danger" disabled={report.ok} onClick={() => done(true)}>
            Restore this backup…
          </button>
        </>
      }
    >
      <p>{report.ok ? 'This backup is the same as the data now.' : 'Differences between the backup and the data now:'}</p>
      <ReportView report={report} desktopLabel="In the backup" webLabel="Now" />
    </Modal>
  ));
  if (!go) return;
  const sure = await confirmDialog({
    title: 'Restore this backup?',
    message: (
      <>
        <p>
          All bills and clients go back to how they were on <b>{label}</b>.
        </p>
        <p class="hint">The data as it is now is backed up first, so this can be undone. The password stays as it is.</p>
      </>
    ),
    ok: 'Restore',
    danger: true,
  });
  if (!sure) return;
  const ok = await busy('Restoring…', async () => {
    await restoreBackup(s.ws, dir);
    return true;
  });
  if (ok) {
    toast(`Restored the backup of ${label}.`, 'ok');
    onRestored();
  }
}

function BackupDialog({ s, onClose, onRestored }: { s: Session; onClose: () => void; onRestored: () => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [linked, setLinked] = useState(false);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [daily, setDaily] = useState<BackupEntry[] | null>(null);
  const load = () =>
    attempt(async () => {
      const p = await s.ws.backupPath();
      setPath(p);
      setLinked(await hasRememberedPath('backup', p));
      setPrefs(await loadPrefs());
      setDaily(await listBackups(await insideBackups(s.ws)));
    });
  useEffect(() => {
    load();
  }, []);

  const backupNow = () =>
    attempt(async () => {
      const dir = await pickFolder('utility-soft-backup-now');
      if (!dir) return;
      await busy('Backing up…', async () => {
        const dest = (await dir.list()).length === 0 ? dir : await dir.dir(backupFolderName(new Date()), true);
        let n = 0;
        await makeBackup(s.ws, dest, { onFile: () => setBusyLabel(`Backing up… ${++n} files`) });
        toast(`Backed up and checked ${n} files in ${dest.name}.`, 'ok');
      });
    });

  const chooseAuto = () =>
    attempt(async () => {
      const dir = await pickFolder('utility-soft-backup');
      if (!dir) return;
      await rememberPath('backup', dir.name, dir);
      await s.ws.setBackupPath(dir.name);
      toast('Auto-backup folder saved.', 'ok');
      load();
    });

  const restoreFrom = () =>
    attempt(async () => {
      const dir = await pickFolder('utility-soft-restore');
      if (!dir) return;
      if (!(await isBackup(dir))) return toast(`“${dir.name}” is not a Utility Soft backup.`, 'error');
      await compareAndRestore(s, dir, dir.name, () => (onRestored(), onClose()));
    });

  return (
    <Modal title="Backups" onClose={onClose} wide footer={<button onClick={onClose}>Close</button>}>
      <div class="backup-cols">
        <section>
          <h3>Back up now</h3>
          <p class="hint">Copies everything into a folder you choose, for example on a USB stick, and checks the copy. It stays encrypted.</p>
          <button class="primary" onClick={backupNow}>
            Back up now…
          </button>
          <h3>Backup when exiting</h3>
          {path === null ? (
            <p>Loading…</p>
          ) : (
            <>
              <p>
                Folder: <b class="path">{path || 'not set'}</b>
                {path && !linked && <span class="hint"> (you will be asked to select it on this computer)</span>}
              </p>
              <div class="row left">
                <button onClick={chooseAuto}>{path ? 'Change folder…' : 'Choose folder…'}</button>
                {prefs && (
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={prefs.askBackupOnExit}
                      onChange={(e) => {
                        const p = { ...prefs, askBackupOnExit: (e.target as HTMLInputElement).checked };
                        setPrefs(p);
                        savePrefs(p);
                      }}
                    />
                    <span>Ask to back up when I exit (in this browser)</span>
                  </label>
                )}
              </div>
            </>
          )}
        </section>
        <section>
          <h3>Automatic backups</h3>
          <p class="hint">One a day, kept inside the data folder: the last 7 days, 4 weeks and 12 months.</p>
          {daily === null ? (
            <p>Loading…</p>
          ) : daily.length === 0 ? (
            <p class="hint">None yet.</p>
          ) : (
            <ul class="backup-list">
              {daily.map((b) => (
                <li key={b.dir.name}>
                  <span>{when(b.at)}</span>
                  <button onClick={() => attempt(() => compareAndRestore(s, b.dir, when(b.at), () => (onRestored(), onClose())))}>Compare or restore…</button>
                </li>
              ))}
            </ul>
          )}
          <button onClick={restoreFrom}>Restore from a backup folder…</button>
        </section>
      </div>
    </Modal>
  );
}

// ---------- the bin ----------

function BinDialog({ ws, onClose }: { ws: WebBooks; onClose: () => void }) {
  const [list, setList] = useState<BinEntry[] | null>(null);
  const load = () => attempt(async () => setList(await ws.bin()));
  useEffect(() => {
    load();
  }, []);
  const restore = (e: BinEntry) =>
    attempt(async () => {
      toast(await ws.restore(e), 'ok');
      load();
    });
  return (
    <Modal title="Deleted clients and bills" onClose={onClose} wide footer={<button onClick={onClose}>Close</button>}>
      <p class="hint">Kept for 30 days after they were deleted (also when replaced by copying from another year).</p>
      {list === null ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p>Nothing was deleted in the last 30 days.</p>
      ) : (
        <ul class="bin-list">
          {list.map((e) => (
            <li key={e.file}>
              <span>
                {e.kind === 'client' ? (
                  <>
                    Client <b>{e.record.name}</b> ({e.year}), {e.record.bills.length} bill{e.record.bills.length === 1 ? '' : 's'}
                  </>
                ) : (
                  <>
                    Bill <b>{e.bill.name}</b> of {e.clientName} ({e.year}, {e.bill.type})
                  </>
                )}
                <span class="hint"> · deleted {when(e.at)}</span>
              </span>
              <button onClick={() => restore(e)}>Restore</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// ---------- problem log ----------

function LogDialog({ ws, onClose }: { ws: WebBooks; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    attempt(async () => setText(await ws.logText()));
  }, []);
  const copy = () =>
    attempt(async () => {
      await navigator.clipboard.writeText(text ?? '');
      toast('Copied. Paste it into an email or message.', 'ok');
    });
  return (
    <Modal
      title="Problem log"
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={copy} disabled={!text}>
            Copy
          </button>
          <button class="primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p class="hint">Problems on every computer using this data, newest last. It is kept encrypted with the rest.</p>
      {text === null ? <p>Loading…</p> : text === '' ? <p>No problems so far.</p> : <pre class="log">{text}</pre>}
    </Modal>
  );
}

// ---------- tabs ----------

function TabsDialog({ s, onClose }: { s: Session; onClose: (changed: boolean) => void }) {
  const [types, setTypes] = useState(s.types);
  const [changed, setChanged] = useState(false);
  const refresh = async () => {
    setTypes(await s.ws.billTypes());
    setChanged(true);
  };
  const add = () =>
    attempt(async () => {
      const name = await promptDialog({
        title: 'Add new tab',
        label: 'Tab name',
        hint: 'A new tab (bill type) for every client in every year.',
        validate: (v) => (types.some((t) => t.tab.toLowerCase() === v.trim().toLowerCase()) ? 'This tab name already exists.' : null),
      });
      if (!name) return;
      await s.ws.addBillType(name);
      toast(`Added the tab ${name.trim()}.`, 'ok');
      await refresh();
    });
  const rename = (folder: string, tab: string) =>
    attempt(async () => {
      const name = await promptDialog({
        title: `Rename the tab ${tab}`,
        label: 'New name',
        value: tab,
        hint: 'Only the title changes; its bills and drop-down list stay with it. The desktop version shows the new title too.',
        validate: (v) => (types.some((t) => t.folder !== folder && t.tab.toLowerCase() === v.trim().toLowerCase()) ? 'This tab name already exists.' : null),
      });
      if (!name || name.trim() === tab) return;
      await s.ws.renameBillType(folder, name);
      await refresh();
    });
  const move = (i: number, d: number) =>
    attempt(async () => {
      const order = types.map((t) => t.folder);
      const j = i + d;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      await s.ws.setBillTypeOrder(order);
      await refresh();
    });
  const hide = (folder: string, hidden: boolean) =>
    attempt(async () => {
      await s.ws.setBillTypeHidden(folder, hidden);
      await refresh();
    });
  return (
    <Modal title="Tabs" onClose={() => onClose(changed)} footer={<button onClick={() => onClose(changed)}>Close</button>}>
      <p class="hint">The bill types shown for every client. A hidden tab still shows for a client that has bills in it.</p>
      <ul class="tab-list">
        {types.map((t, i) => (
          <li key={t.folder} class={t.hidden ? 'hidden-tab' : ''}>
            <b>{t.tab}</b>
            {t.hidden && <span class="hint">hidden</span>}
            <span class="grow" />
            <button class="icon-btn" aria-label={`Move ${t.tab} up`} title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button class="icon-btn" aria-label={`Move ${t.tab} down`} title="Move down" disabled={i === types.length - 1} onClick={() => move(i, 1)}>
              ↓
            </button>
            <button onClick={() => rename(t.folder, t.tab)}>Rename…</button>
            <button onClick={() => hide(t.folder, !t.hidden)}>{t.hidden ? 'Show' : 'Hide'}</button>
          </li>
        ))}
      </ul>
      <button onClick={add}>+ Add new tab…</button>
    </Modal>
  );
}
