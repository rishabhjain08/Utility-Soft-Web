import { useEffect, useState } from 'preact/hooks';
import { FsaDir } from '../core/fsa';
import { FsDir } from '../core/fs';
import { Letterhead, writeDataPath, writePassword } from '../core/config';
import { createStore } from '../core/webstore';
import { ensurePermission, pickFolder, rememberPath, rememberProgram, rememberedProgram, relativeTo, supportsFolders } from './folders';
import { PasswordStore, Place, inspectProgram, looksLikeData, passwordStore, prepareDataFolder } from './session';
import { attempt, busy, confirmDialog, toast } from './ui';
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
        <p class="hint">
          To use your existing bills, open the folder with your Utility Soft data, or the desktop program folder (the one with{' '}
          <code>billing.jar</code>, <code>pass.txt</code> and <code>impinfo.txt</code>). To start from nothing, choose where to keep the new
          files. Your files stay on this computer.
        </p>
        {message && <p class="warn">{message}</p>}
      </div>
    </div>
  );
}

// ---------- Login ----------

export function Login({ place, onLogin, onBack }: { place: Place; onLogin: (password: string) => void; onBack: () => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState(false);
  const [changing, setChanging] = useState(false);

  const submit = (e: Event) => {
    e.preventDefault();
    attempt(async () => {
      if (await passwordStore(place).checkPassword(pw)) onLogin(pw);
      else {
        setError(true);
        setPw('');
      }
    });
  };

  if (changing) return <ChangePassword store={passwordStore(place)} onDone={() => setChanging(false)} />;

  return (
    <div class="start">
      <form class="card" onSubmit={submit}>
        <h1>Utility Soft</h1>
        <p class="lead">{place.dir.name}</p>
        <label class="field">
          <span>Password</span>
          <input type="password" autoFocus value={pw} onInput={(e) => (setPw((e.target as HTMLInputElement).value), setError(false))} />
        </label>
        {error && <p class="warn">Wrong password. Try again.</p>}
        <div class="row">
          <button type="button" onClick={onBack}>
            Back
          </button>
          <button type="button" onClick={() => setChanging(true)}>
            Change password
          </button>
          <button class="primary" type="submit">
            OK
          </button>
        </div>
      </form>
    </div>
  );
}

export function ChangePassword({ store, onDone }: { store: PasswordStore; onDone: () => void }) {
  const [old, setOld] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: Event) => {
    e.preventDefault();
    attempt(async () => {
      if (!(await store.checkPassword(old))) return setError('The old password is wrong.');
      if (a === '') return setError('The new password cannot be empty.');
      if (a !== b) return setError('The two new passwords do not match.');
      await store.setPassword(a);
      toast('Password changed.', 'ok');
      onDone();
    });
  };
  return (
    <div class="start">
      <form class="card" onSubmit={submit}>
        <h1>Change password</h1>
        <label class="field">
          <span>Old password</span>
          <input type="password" autoFocus value={old} onInput={(e) => setOld((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>New password</span>
          <input type="password" value={a} onInput={(e) => setA((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>New password again</span>
          <input type="password" value={b} onInput={(e) => setB((e.target as HTMLInputElement).value)} />
        </label>
        {error && <p class="warn">{error}</p>}
        <div class="row">
          <button type="button" onClick={onDone}>
            Cancel
          </button>
          <button class="primary" type="submit">
            Change
          </button>
        </div>
      </form>
    </div>
  );
}

/** First run: a new installation (in the web format), or a desktop folder without pass.txt. */
export function SetPassword({ program, isNew, onDone, onBack }: { program: FsDir; isNew: boolean; onDone: (password: string) => void; onBack: () => void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: Event) => {
    e.preventDefault();
    if (a === '') return setError('Choose a password.');
    if (a !== b) return setError('The two passwords do not match.');
    busy('Setting up…', async () => {
      if (isNew) await createStore(program, a);
      else await writePassword(program, a);
      onDone(a);
    });
  };
  return (
    <div class="start">
      <form class="card" onSubmit={submit}>
        <h1>{isNew ? 'New Utility Soft' : 'Set a password'}</h1>
        <p class="lead">{isNew ? 'Choose the password used to open Utility Soft.' : 'This folder has no password file (pass.txt). Choose a password.'}</p>
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
  save: store, initial, onDone, onSkip, embedded,
}: {
  save: (lh: Letterhead) => Promise<void>;
  initial: Letterhead | null;
  onDone: () => void;
  onSkip?: () => void;
  embedded?: boolean;
}) {
  const [name, setName] = useState((initial?.firmName ?? []).join('\n'));
  const [address, setAddress] = useState((initial?.firmAddress ?? []).join('\n'));
  const [titles, setTitles] = useState<string[]>([...(initial?.indexTitles ?? ['', '', ''])]);
  // Blank lines inside a block are kept (they space the printout); trailing ones are dropped.
  const lines = (s: string) => {
    const out = s.split('\n').map((l) => l.trimEnd());
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  };

  const save = (e: Event) => {
    e.preventDefault();
    attempt(async () => {
      await store({ firmName: lines(name), firmAddress: lines(address), indexTitles: [titles[0], titles[1], titles[2]] });
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
            <legend>Index sheet title (up to 3 lines; ## is replaced by the year)</legend>
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                aria-label={`Index sheet title line ${i + 1}`}
                placeholder={SAMPLE.titles[i] ? `e.g. ${SAMPLE.titles[i]}` : `Line ${i + 1}`}
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
          letterhead={{ firmName: lines(name), firmAddress: lines(address), indexTitles: [titles[0], titles[1], titles[2]] }}
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

// ---------- Data folder ----------

export function DataFolder({
  program, path, reason, onChosen, onBack,
}: {
  program: FsDir;
  path: string;
  reason: 'missing-relative' | 'needs-folder';
  onChosen: (data: FsDir, label: string) => void;
  onBack: () => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const choose = () =>
    attempt(async () => {
      const dir = await pickFolder('utility-soft-data', program);
      if (!dir) return;
      if (!(await looksLikeData(dir))) {
        const ok = await confirmDialog({
          title: 'No bills in this folder',
          message: (
            <p>
              The folder <b>{dir.name}</b> has no <code>bills</code> folder. Use it anyway and start with no bills there?
            </p>
          ),
          ok: 'Use this folder',
        });
        if (!ok) return;
      }
      await prepareDataFolder(dir);
      const rel = await relativeTo(program, dir);
      if (rel !== null) {
        // Inside the program folder: store a relative path Java understands too.
        await writeDataPath(program, rel === 'data' ? '' : rel);
        onChosen(dir, `${program.name}\\${rel}`);
      } else {
        await rememberPath('data', path, dir);
        onChosen(dir, path);
      }
    });
  return (
    <div class="start">
      <div class="card">
        <h1>Where is your data?</h1>
        {reason === 'needs-folder' ? (
          <p>
            Your bills are kept in <b class="path">{path}</b>. The browser needs you to select that folder once.
          </p>
        ) : (
          <p>
            The data folder <b class="path">{path}</b> was not found inside {program.name}. Select the data folder.
          </p>
        )}
        <p class="hint">Select the folder that contains the “bills” folder.</p>
        {message && <p class="warn">{message}</p>}
        <div class="row">
          <button onClick={onBack}>Back</button>
          <button class="primary" onClick={() => (setMessage(null), choose())}>
            Select folder…
          </button>
        </div>
      </div>
    </div>
  );
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
