import { useEffect, useState } from 'preact/hooks';
import { FsaDir } from '../core/fsa';
import { FsDir } from '../core/fs';
import { Letterhead, readPassword, writeDataPath, writeLetterhead, writePassword } from '../core/config';
import { ensurePermission, pickFolder, rememberPath, rememberProgram, rememberedProgram, relativeTo, supportsFolders } from './folders';
import { checkPassword, createProgram, inspectProgram, looksLikeData, prepareDataFolder } from './session';
import { attempt, busy, confirmDialog, toast } from './ui';

// ---------- Welcome: choose the program folder ----------

export function Welcome({ onOpened }: { onOpened: (dir: FsDir, hasPassword: boolean) => void }) {
  const [remembered, setRemembered] = useState<FileSystemDirectoryHandle | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    rememberedProgram().then((h) => h && setRemembered(h));
  }, []);

  const use = async (dir: FsaDir) => {
    const info = await inspectProgram(dir);
    if (info.kind === 'program') {
      await rememberProgram(dir);
      onOpened(dir, info.hasPassword);
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
            <p class="hint">To use your existing bills, choose the folder that has billing.jar, pass.txt and impinfo.txt instead.</p>
          </>
        ),
        ok: 'Set up here',
      });
      if (ok) {
        await rememberProgram(dir);
        onOpened(dir, false);
      }
      return;
    }
    setMessage(
      `"${dir.name}" does not look like the Utility Soft folder (pass.txt and impinfo.txt were not found). Choose the folder that contains billing.jar.`,
    );
  };

  const choose = () =>
    attempt(async () => {
      setMessage(null);
      const dir = await pickFolder('utility-soft-program');
      if (dir) await use(dir);
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
        <p class="hint">
          Choose the Utility Soft program folder (the one with <code>billing.jar</code>, <code>pass.txt</code> and <code>impinfo.txt</code>).
          Your files stay on this computer and keep working with the desktop (Java) version.
        </p>
        {message && <p class="warn">{message}</p>}
      </div>
    </div>
  );
}

// ---------- Login ----------

export function Login({ program, onLogin, onBack }: { program: FsDir; onLogin: () => void; onBack: () => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState(false);
  const [changing, setChanging] = useState(false);

  const submit = (e: Event) => {
    e.preventDefault();
    attempt(async () => {
      if (await checkPassword(program, pw)) onLogin();
      else {
        setError(true);
        setPw('');
      }
    });
  };

  if (changing) return <ChangePassword program={program} onDone={() => setChanging(false)} />;

  return (
    <div class="start">
      <form class="card" onSubmit={submit}>
        <h1>Utility Soft</h1>
        <p class="lead">{program.name}</p>
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

export function ChangePassword({ program, onDone }: { program: FsDir; onDone: () => void }) {
  const [old, setOld] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: Event) => {
    e.preventDefault();
    attempt(async () => {
      if ((await readPassword(program)) !== old) return setError('The old password is wrong.');
      if (a === '') return setError('The new password cannot be empty.');
      if (a !== b) return setError('The two new passwords do not match.');
      await writePassword(program, a);
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

/** First run in a folder without pass.txt. */
export function SetPassword({ program, isNew, onDone, onBack }: { program: FsDir; isNew: boolean; onDone: () => void; onBack: () => void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: Event) => {
    e.preventDefault();
    if (a === '') return setError('Choose a password.');
    if (a !== b) return setError('The two passwords do not match.');
    busy('Setting up…', async () => {
      if (isNew) await createProgram(program, a);
      else await writePassword(program, a);
      onDone();
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
  program, initial, onDone, onSkip, embedded,
}: {
  program: FsDir;
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
      await writeLetterhead(program, { firmName: lines(name), firmAddress: lines(address), indexTitles: [titles[0], titles[1], titles[2]] });
      toast('Letterhead saved.', 'ok');
      onDone();
    });
  };

  const body = (
    <form class={embedded ? 'letterhead' : 'card wide letterhead'} onSubmit={save}>
      {!embedded && <h1>Your letterhead</h1>}
      <p class="lead">Printed at the bottom of every bill, and at the top of the index sheet.</p>
      <div class="two-col">
        <label class="field">
          <span>Address and other lines (printed on the left)</span>
          <textarea rows={5} value={address} autoFocus onInput={(e) => setAddress((e.target as HTMLTextAreaElement).value)} />
        </label>
        <label class="field">
          <span>Firm name and signature lines (printed on the right)</span>
          <textarea rows={5} value={name} onInput={(e) => setName((e.target as HTMLTextAreaElement).value)} />
        </label>
      </div>
      <fieldset>
        <legend>Index sheet title (up to 3 lines; ## is replaced by the year)</legend>
        {[0, 1, 2].map((i) => (
          <input
            key={i}
            placeholder={`Line ${i + 1}`}
            value={titles[i]}
            onInput={(e) => {
              const t = [...titles];
              t[i] = (e.target as HTMLInputElement).value;
              setTitles(t);
            }}
          />
        ))}
      </fieldset>
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
