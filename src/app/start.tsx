import { useEffect, useState } from 'preact/hooks';
import { FsaDir } from '../core/fsa';
import { FsDir } from '../core/fs';
import { Letterhead } from '../core/config';
import { collapseYear, expandYear } from '../core/bill';
import { financialYearOf } from '../core/years';
import { WebBooks, createStore } from '../core/webstore';
import { ensurePermission, pickFolder, rememberProgram, rememberedProgram, supportsFolders } from './folders';
import { checkDesktopPassword, inspectProgram, thisComputer, unlock } from './session';
import { Modal, attempt, busy, confirmDialog, mountDialog, toast } from './ui';
import { DriveState, askClientId, driveState, googleDrive } from './google-setup';
import { fromDrive, fromFile } from '../core/backup';
import { DriveBackup } from '../core/drive';
import { MemDir, writeOut } from '../core/pack';
import { chooseNewFolder } from './migrate';
import { LetterheadPart, LetterheadPreview, SAMPLE } from './letterhead-preview';

// ---------- Welcome: choose the folder ----------

export type OpenedKind = 'desktop' | 'web' | 'new';

export function Welcome({ onOpened }: { onOpened: (dir: FsDir, kind: OpenedKind, hasPassword: boolean) => void }) {
  const [remembered, setRemembered] = useState<FileSystemDirectoryHandle | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    rememberedProgram().then((h) => h && setRemembered(h));
  }, []);

  const use = async (dir: FsaDir) => {
    const info = await inspectProgram(dir);
    if (info.kind === 'program' || info.kind === 'web') {
      await rememberProgram(dir);
      onOpened(dir, info.kind === 'web' ? 'web' : 'desktop', info.hasPassword);
      return;
    }
    if (info.kind === 'new') {
      const ok = await confirmDialog({
        title: 'Start a new Utility Soft?',
        message: (
          <>
            <p>
              The folder <b>{dir.name}</b> is empty. Set up a new Utility Soft here?
            </p>
            <p class="hint">To use your existing bills, choose the folder that has them instead.</p>
          </>
        ),
        ok: 'Set up here',
      });
      if (ok) {
        await rememberProgram(dir);
        onOpened(dir, 'new', false);
      }
      return;
    }
    setMessage(
      `"${dir.name}" does not look like a Utility Soft folder. Choose the folder with your Utility Soft data, or the desktop program folder (the one with billing.jar, pass.txt and impinfo.txt), or use “Start a new Utility Soft”.`,
    );
  };

  const choose = () =>
    attempt(async () => {
      setMessage(null);
      const dir = await pickFolder('utility-soft-program');
      if (dir) await use(dir);
    });

  // A new installation: in the chosen folder when it is empty, otherwise in a new folder inside it.
  const startNew = () =>
    attempt(async () => {
      setMessage(null);
      const dir = await chooseNewFolder({
        id: 'utility-soft-new',
        title: 'Start a new Utility Soft',
        suggestion: 'Utility Soft Files',
        check: async (place) => {
          const info = await inspectProgram(place);
          if (info.kind === 'new') return place;
          if (info.kind === 'not-program') return undefined;
          const open = await confirmDialog({
            title: 'Utility Soft is already here',
            message: (
              <p>
                The folder <b>{place.name}</b> already has a Utility Soft. Open it?
              </p>
            ),
            ok: 'Open it',
          });
          if (open) await use(place);
          return null;
        },
      });
      if (!dir) return;
      await rememberProgram(dir);
      onOpened(dir, 'new', false);
    });

  // A lost or new computer: a backup from Google Drive, written into a new folder.
  const [drive, setDrive] = useState<DriveState | null>(null);
  useEffect(() => {
    driveState().then(setDrive, () => undefined);
  }, []);
  const restoreDrive = () =>
    attempt(async () => {
      setMessage(null);
      if (!(await driveState()).ok && !(await askClientId())) return;
      const list = await busy('Looking in Google Drive…', () => googleDrive().list());
      if (!list) return;
      if (list.length === 0) return setMessage('There are no Utility Soft backups in this Google account’s Drive.');
      const b = await mountDialog<DriveBackup | null>((done) => (
        <Modal title="Restore from Google Drive" wide onClose={() => done(null)} footer={<button onClick={() => done(null)}>Cancel</button>}>
          <p class="hint">Backups of Utility Soft data in your Google Drive, newest first. The restored data opens with the password it had then, or the recovery code.</p>
          <ul class="backup-list">
            {list.map((x) => (
              <li key={x.id}>
                <span>
                  <b>{x.label || 'Utility Soft data'}</b> · {new Date(x.at).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <button onClick={() => done(x)}>Restore this…</button>
              </li>
            ))}
          </ul>
        </Modal>
      ));
      if (!b) return;
      const mem = await busy('Downloading from Google Drive…', () => fromDrive(googleDrive(), b));
      if (mem) await restoreInto(mem, b.label);
    });

  /** A backup file downloaded earlier (from Drive, or kept on a USB stick). */
  const restoreFile = (f: File) =>
    attempt(async () => {
      setMessage(null);
      const mem = await busy('Opening the backup…', async () => fromFile(new Uint8Array(await f.arrayBuffer())));
      if (mem) await restoreInto(mem, f.name.replace(/^Utility Soft backup - /, '').replace(/ - \d{4}-.*$/, '').replace(/\.usbackup$/, ''));
    });

  const restoreInto = (mem: MemDir, label: string) =>
    attempt(async () => {
      const dir = await chooseNewFolder({ id: 'utility-soft-restore', title: 'Where should the restored data go?', suggestion: label || 'Utility Soft Data' });
      if (!dir) return;
      if ((await dir.list()).length) return setMessage(`${dir.name} is not empty.`);
      const ok = await busy('Restoring…', async () => (await writeOut(mem, dir), true));
      if (!ok) return;
      await rememberProgram(dir);
      toast(`Restored into ${dir.name}.`, 'ok');
      onOpened(dir, 'web', true);
    });

  const reopen = () =>
    attempt(async () => {
      if (!remembered) return;
      if (!(await ensurePermission(remembered, true))) {
        setMessage('Access to the folder was not allowed.');
        return;
      }
      await use(new FsaDir(remembered));
    });

  if (!supportsFolders) {
    return (
      <div class="start">
        <div class="card">
          <h1>Utility Soft</h1>
          <p class="warn">
            This browser cannot open folders on your computer. Please use <b>Google Chrome</b> or <b>Microsoft Edge</b> on a desktop or
            laptop computer.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div class="start">
      <div class="card">
        <h1>Utility Soft</h1>
        <p class="lead">Billing for clients, year by year.</p>
        {remembered && (
          <button class="primary big" onClick={reopen}>
            Continue with “{remembered.name}”
          </button>
        )}
        <button class={remembered ? 'big' : 'primary big'} onClick={choose}>
          {remembered ? 'Open a different folder…' : 'Open Utility Soft folder…'}
        </button>
        <button class="big" onClick={startNew}>
          Start a new Utility Soft…
        </button>
        {drive && (drive.ok || drive.reason === 'setup') && (
          <button class="big" onClick={restoreDrive}>
            Restore from Google Drive…
          </button>
        )}
        <label class="file-button link-like">
          <input
            type="file"
            accept=".usbackup"
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const f = input.files?.[0];
              input.value = '';
              if (f) restoreFile(f);
            }}
          />
          <span>Restore from a backup file (.usbackup)…</span>
        </label>
        <p class="hint">
          To use your existing bills, open the folder with your Utility Soft data, or the desktop program folder (the one with{' '}
          <code>billing.jar</code>, <code>pass.txt</code> and <code>impinfo.txt</code>). To start from nothing, choose where to keep the new
          files. Your files stay on this computer, encrypted with your password.
        </p>
        {message && <p class="warn">{message}</p>}
      </div>
    </div>
  );
}

// ---------- Login ----------

/** A folder that was opened, before the password is entered. */
export type Place = { kind: 'desktop' | 'web'; dir: FsDir };

/** The password of a web data folder (opens it), or of a desktop folder (before copying it). */
export function Login({
  place, message, onLogin, onRecovery, onBack,
}: {
  place: Place;
  message?: string;
  onLogin: (ws: WebBooks | null, password: string) => void;
  onRecovery: () => void;
  onBack: () => void;
}) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState(false);

  const submit = (e: Event) => {
    e.preventDefault();
    attempt(async () => {
      const ok = await busy('Opening…', async () => {
        if (place.kind === 'desktop') return (await checkDesktopPassword(place.dir, pw)) ? null : false;
        return (await unlock(place.dir, pw)) ?? false;
      });
      if (ok === undefined) return;
      if (ok === false) {
        setError(true);
        setPw('');
      } else onLogin(ok, pw);
    });
  };

  return (
    <div class="start">
      <form class="card" onSubmit={submit}>
        <h1>Utility Soft</h1>
        <p class="lead">{place.dir.name}</p>
        {message && <p class="notice">{message}</p>}
        <label class="field">
          <span>Password</span>
          <input type="password" autoFocus value={pw} onInput={(e) => (setPw((e.target as HTMLInputElement).value), setError(false))} />
        </label>
        {error && <p class="warn">Wrong password. Try again.</p>}
        <div class="row">
          <button type="button" onClick={onBack}>
            Back
          </button>
          <span class="grow" />
          <button class="primary" type="submit">
            OK
          </button>
        </div>
        {place.kind === 'web' && (
          <div class="forgot">
            <button type="button" onClick={onRecovery}>
              Forgot the password? Use the recovery code…
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

/**
 * Choosing a password: for a new installation (which is then created), or for
 * the copy of a desktop folder that has none (nothing is written to that folder).
 */
export function SetPassword({ program, isNew, onDone, onBack }: { program: FsDir; isNew: boolean; onDone: (ws: WebBooks | null, password: string) => void; onBack: () => void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: Event) => {
    e.preventDefault();
    if (a === '') return setError('Choose a password.');
    if (a !== b) return setError('The two passwords do not match.');
    if (!isNew) return onDone(null, a);
    busy('Setting up…', async () => {
      const { books } = await createStore(program, a);
      onDone(books.as({ computer: await thisComputer() }), a);
    });
  };
  return (
    <div class="start">
      <form class="card" onSubmit={submit}>
        <h1>{isNew ? 'New Utility Soft' : 'Choose a password'}</h1>
        <p class="lead">
          {isNew
            ? 'Choose the password used to open Utility Soft. Everything is encrypted with it.'
            : 'This desktop folder has no password (pass.txt). Choose one for the copy in the new format.'}
        </p>
        <label class="field">
          <span>Password</span>
          <input type="password" autoFocus value={a} onInput={(e) => setA((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Password again</span>
          <input type="password" value={b} onInput={(e) => setB((e.target as HTMLInputElement).value)} />
        </label>
        {error && <p class="warn">{error}</p>}
        <div class="row">
          <button type="button" onClick={onBack}>
            Back
          </button>
          <button class="primary" type="submit">
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------- Letterhead (Java "Registration") ----------

export function LetterheadForm({
  save: store, initial, year, onDone, onSkip, embedded,
}: {
  save: (lh: Letterhead) => Promise<void>;
  /** The year the index title is shown and typed for (it is stored for every year). */
  year?: string | null;
  initial: Letterhead | null;
  onDone: () => void;
  onSkip?: () => void;
  embedded?: boolean;
}) {
  const [name, setName] = useState((initial?.firmName ?? []).join('\n'));
  const [address, setAddress] = useState((initial?.firmAddress ?? []).join('\n'));
  const y = year ?? financialYearOf(new Date());
  const [titles, setTitles] = useState<string[]>((initial?.indexTitles ?? ['', '', '']).map((t) => expandYear(t, y)));
  const stored = (): [string, string, string] => [collapseYear(titles[0], y), collapseYear(titles[1], y), collapseYear(titles[2], y)];
  // Blank lines inside a block are kept (they space the printout); trailing ones are dropped.
  const lines = (s: string) => {
    const out = s.split('\n').map((l) => l.trimEnd());
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  };

  const save = (e: Event) => {
    e.preventDefault();
    attempt(async () => {
      await store({ firmName: lines(name), firmAddress: lines(address), indexTitles: stored() });
      toast('Letterhead saved.', 'ok');
      onDone();
    });
  };

  const [focus, setFocus] = useState<LetterheadPart | null>(null);
  const track = (part: LetterheadPart) => ({ onFocus: () => setFocus(part), onBlur: () => setFocus(null) });

  const body = (
    <form class={embedded ? 'letterhead' : 'card letterhead-card letterhead'} onSubmit={save}>
      {!embedded && <h1>Your letterhead</h1>}
      <p class="lead">Printed at the bottom of every bill, and at the top of the index sheet. The preview shows where each part goes.</p>
      <div class="lh-layout">
        <div class="lh-fields">
          <label class="field">
            <span>Address and other lines (printed on the left)</span>
            <textarea
              rows={4}
              value={address}
              autoFocus
              placeholder={`e.g. ${SAMPLE.address.join('\n')}`}
              {...track('address')}
              onInput={(e) => setAddress((e.target as HTMLTextAreaElement).value)}
            />
          </label>
          <label class="field">
            <span>Firm name and signature lines (printed on the right)</span>
            <textarea
              rows={4}
              value={name}
              placeholder={`e.g. ${SAMPLE.firm.join('\n')}`}
              {...track('firm')}
              onInput={(e) => setName((e.target as HTMLTextAreaElement).value)}
            />
          </label>
          <fieldset>
            <legend>Index sheet title (up to 3 lines)</legend>
            <p class="hint">Write the year as it is for {y}; each year's index sheet shows its own year.</p>
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                aria-label={`Index sheet title line ${i + 1}`}
                placeholder={SAMPLE.titles[i] ? `e.g. ${SAMPLE.titles[i].split('##').join(y)}` : `Line ${i + 1}`}
                value={titles[i]}
                {...track('titles')}
                onInput={(e) => {
                  const t = [...titles];
                  t[i] = (e.target as HTMLInputElement).value;
                  setTitles(t);
                }}
              />
            ))}
          </fieldset>
        </div>
        <LetterheadPreview
          letterhead={{ firmName: lines(name), firmAddress: lines(address), indexTitles: stored() }}
          year={y}
          focus={focus}
        />
      </div>
      <div class="row">
        {onSkip && (
          <button type="button" onClick={onSkip}>
            {embedded ? 'Cancel' : 'Later'}
          </button>
        )}
        <button class="primary" type="submit">
          Save
        </button>
      </div>
    </form>
  );
  return embedded ? body : <div class="start">{body}</div>;
}

export function Closed({ onReopen }: { onReopen: () => void }) {
  return (
    <div class="start">
      <div class="card">
        <h1>Utility Soft is closed</h1>
        <p class="lead">You can close this tab now.</p>
        <button class="primary big" onClick={onReopen}>
          Open again
        </button>
      </div>
    </div>
  );
}
