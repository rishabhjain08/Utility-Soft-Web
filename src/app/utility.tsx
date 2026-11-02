import { useEffect, useState } from 'preact/hooks';
import { FsDir, ensureDir, walk } from '../core/fs';
import { isRelativePath, pathParts, readBackupPath, readPassword, writeBackupPath, writeDataPath, writePassword } from '../core/config';
import { Client, backupFolderName } from '../core/workspace';
import { Session, looksLikeData, openSession, prepareDataFolder, refreshSession } from './session';
import { DropdownDialog } from './dialogs';
import { LetterheadForm } from './start';
import { Prefs, hasRememberedPath, loadPrefs, pickFolder, rememberPath, rememberedPath, relativeTo, savePrefs } from './folders';
import { printBills, printIndex } from './printing';
import { Modal, attempt, busy, confirmDialog, promptDialog, setBusyLabel, toast } from './ui';

type Sub = 'dropdowns' | 'letterhead' | 'password' | 'backup' | 'data' | null;

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

  if (sub === 'dropdowns') return <DropdownDialog s={s} onClose={() => setSub(null)} onSaved={onClose} />;
  if (sub === 'letterhead')
    return (
      <Modal title="Letterhead" onClose={() => setSub(null)} wide>
        <LetterheadForm
          program={s.program}
          initial={s.letterhead}
          embedded
          onSkip={() => setSub(null)}
          onDone={() => attempt(async () => onSession(await refreshSession(s)))}
        />
      </Modal>
    );
  if (sub === 'password') return <ChangePasswordDialog program={s.program} onClose={() => setSub(null)} onDone={onClose} />;
  if (sub === 'backup') return <BackupDialog s={s} onClose={() => setSub(null)} />;
  if (sub === 'data') return <DataLocationDialog s={s} onClose={() => setSub(null)} onSession={onSession} />;

  const addTab = async () => {
    const name = await promptDialog({
      title: 'Add new bill tab',
      label: 'Tab name',
      hint: 'A new tab (bill type) is added for every client in every year.',
      validate: (v) => (s.types.some((t) => t.tab.toLowerCase() === v.trim().toLowerCase()) ? 'This tab name already exists.' : null),
    });
    if (!name) return;
    await busy('Adding tab…', async () => {
      await s.ws.addBillType(name);
      toast(`Added the tab ${name.trim()}.`, 'ok');
      onSession(await refreshSession(s));
    });
  };

  const checkAll = () =>
    busy('Checking bills…', async () => {
      const r = await s.ws.protectAll((p) => setBusyLabel(`Checking bills… ${p.checked}`));
      toast(
        r.fixed
          ? `Checked ${r.checked} bills; fixed ${r.fixed} so the desktop version can open them.`
          : `Checked ${r.checked} bills; the desktop version can open all of them.`,
        'ok',
      );
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
          <h3>Backup</h3>
          {item('Backup and auto-backup…', 'Back up now, or choose where to back up when exiting.', () => setSub('backup'))}
          {item('Data location…', `Currently: ${s.dataLabel}`, () => setSub('data'))}
          {item('Check bills for the desktop version', 'Fix bills the Java version could not open. Also runs each time you open Utility Soft.', checkAll)}
        </section>
        <section>
          <h3>Setup</h3>
          {item('Add new tab', 'Add a bill type (like Audit or Tax).', addTab)}
          {item('Edit drop-down lists', 'Entries offered when typing bill fields.', () => setSub('dropdowns'))}
          {item('Letterhead', 'Firm name, address and index-sheet title.', () => setSub('letterhead'))}
          {item('Change password', 'Password used to open Utility Soft.', () => setSub('password'))}
        </section>
      </div>
      <div class="row">
        <span class="grow" />
        <button onClick={onExit}>Exit Utility Soft</button>
      </div>
    </Modal>
  );
}

function ChangePasswordDialog({ program, onClose, onDone }: { program: FsDir; onClose: () => void; onDone: () => void }) {
  const [old, setOld] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    attempt(async () => {
      if ((await readPassword(program)) !== old) return setError('The old password is wrong.');
      if (a === '') return setError('The new password cannot be empty.');
      if (a !== b) return setError('The two new passwords do not match.');
      await writePassword(program, a);
      toast('Password changed.', 'ok');
      onDone();
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
    </Modal>
  );
}

// ---------- folders that the Java program knows by path ----------

const ABSOLUTE = /^([a-zA-Z]:[\\/]|\\\\|\/)/;

/**
 * Turns a chosen folder into the path text stored for the Java program:
 * relative when inside the program folder, otherwise typed by the user.
 */
async function pathForJava(s: Session, dir: FsDir, what: string, current: string): Promise<string | null> {
  const rel = await relativeTo(s.program, dir);
  if (rel !== null) return rel;
  return promptDialog({
    title: `Full path of the ${what}`,
    label: `Full path of “${dir.name}” on this computer`,
    value: current && !isRelativePath(current) && current.toLowerCase().endsWith(dir.name.toLowerCase()) ? current : '',
    hint: (
      <>
        The browser cannot see full folder paths. The desktop (Java) version needs it, for example <code>D:\Accounts\{dir.name}</code> or{' '}
        <code>\\OFFICE-PC\Share\{dir.name}</code>. Copy it from the address bar of File Explorer.
      </>
    ),
    validate: (v) => (ABSOLUTE.test(v.trim()) ? null : 'Enter a full path, starting with a drive letter like D:\\ or with \\\\.'),
  }).then((v) => (v === null ? null : v.trim()));
}

/** The folder for a path stored by the Java program, asking for it if needed. */
async function folderForPath(s: Session, kind: 'data' | 'backup', path: string): Promise<FsDir | null> {
  if (!path) return null;
  if (isRelativePath(path)) {
    const parts = pathParts(path);
    let d: FsDir | null = s.program;
    for (const p of parts) d = d ? await ensureDir(d, p) : null;
    return d;
  }
  const remembered = await rememberedPath(kind, path, true);
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
  const dir = await pickFolder('utility-soft-backup', s.program);
  if (dir) await rememberPath(kind, path, dir);
  return dir;
}

/** Automatic backup into <backup folder>\<date+time> (on exit). Returns false if cancelled. */
export async function autoBackup(s: Session): Promise<boolean> {
  const path = await readBackupPath(s.program);
  if (!path) return true;
  const dir = await folderForPath(s, 'backup', path);
  if (!dir) return false;
  const r = await busy('Backing up…', async () => {
    const dest = await ensureDir(dir, backupFolderName(new Date()));
    let n = 0;
    await s.ws.backupTo(dest, () => setBusyLabel(`Backing up… ${++n} files`));
    toast(`Backed up to ${path}\\${dest.name}.`, 'ok');
    return true;
  });
  return r === true;
}

function BackupDialog({ s, onClose }: { s: Session; onClose: () => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [linked, setLinked] = useState(false);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const load = () =>
    attempt(async () => {
      const p = await readBackupPath(s.program);
      setPath(p);
      setLinked(isRelativePath(p) || (await hasRememberedPath('backup', p)));
      setPrefs(await loadPrefs());
    });
  useEffect(() => {
    load();
  }, []);

  const backupNow = () =>
    attempt(async () => {
      const dir = await pickFolder('utility-soft-backup-now', s.program);
      if (!dir) return;
      await busy('Backing up…', async () => {
        let n = 0;
        await s.ws.backupTo(dir, () => setBusyLabel(`Backing up… ${++n} files`));
        toast(`Backed up ${n} files to ${dir.name}.`, 'ok');
      });
    });

  const chooseAuto = () =>
    attempt(async () => {
      const dir = await pickFolder('utility-soft-backup', s.program);
      if (!dir) return;
      const text = await pathForJava(s, dir, 'backup folder', path ?? '');
      if (text === null) return;
      if (!isRelativePath(text)) await rememberPath('backup', text, dir);
      await writeBackupPath(s.program, text);
      toast('Auto-backup folder saved.', 'ok');
      load();
    });

  return (
    <Modal title="Backup" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <h3>Back up now</h3>
      <p class="hint">Copies all bills of every year into a folder you choose.</p>
      <button class="primary" onClick={backupNow}>
        Back up now…
      </button>
      <h3>Auto-backup when exiting</h3>
      {path === null ? (
        <p>Loading…</p>
      ) : (
        <>
          <p>
            Folder: <b class="path">{path || 'not set'}</b>
            {path && !linked && <span class="hint"> (you will be asked to select it the first time)</span>}
          </p>
          <p class="hint">Each backup goes into a new folder named with the date and time, as in the desktop version.</p>
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
    </Modal>
  );
}

function DataLocationDialog({ s, onClose, onSession }: { s: Session; onClose: () => void; onSession: (s: Session) => void }) {
  const change = () =>
    attempt(async () => {
      const dir = await pickFolder('utility-soft-data', s.program);
      if (!dir) return;
      if (!(await looksLikeData(dir))) {
        const ok = await confirmDialog({
          title: 'No bills in this folder',
          message: (
            <p>
              <b>{dir.name}</b> has no <code>bills</code> folder. Use it anyway and start with no bills there?
            </p>
          ),
          ok: 'Use this folder',
        });
        if (!ok) return;
      }
      const text = await pathForJava(s, dir, 'data folder', '');
      if (text === null) return;
      await prepareDataFolder(dir);
      if (isRelativePath(text)) {
        await writeDataPath(s.program, text.toLowerCase() === 'data' ? '' : text);
      } else {
        await rememberPath('data', text, dir);
        await writeDataPath(s.program, text);
      }
      const label = isRelativePath(text) ? `${s.program.name}\\${text}` : text;
      toast(`Data is now loaded from ${label}.`, 'ok');
      onSession(await openSession(s.program, dir, label));
    });
  const useDefault = () =>
    attempt(async () => {
      const dir = await walk(s.program, ['data']);
      const data = dir ?? (await ensureDir(s.program, 'data'));
      await prepareDataFolder(data);
      await writeDataPath(s.program, '');
      const label = `${s.program.name}\\data`;
      toast(`Data is now loaded from ${label}.`, 'ok');
      onSession(await openSession(s.program, data, label));
    });
  return (
    <Modal title="Data location" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <p>
        Bills are loaded from <b class="path">{s.dataLabel}</b>.
      </p>
      <p class="hint">
        Choose another folder to work on bills kept elsewhere, for example a shared folder on the office computer. The desktop version uses the same
        setting.
      </p>
      <div class="row left">
        <button class="primary" onClick={change}>
          Choose data folder…
        </button>
        <button onClick={useDefault}>Use the “data” folder inside {s.program.name}</button>
      </div>
    </Modal>
  );
}
