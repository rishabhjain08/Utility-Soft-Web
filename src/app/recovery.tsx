// The recovery code: shown once as a QR code to save on a phone, and used to
// get back in when the password is forgotten.

import { useMemo, useState } from 'preact/hooks';
import { renderSVG } from 'uqr';
import { newRecoveryCode, normalizeRecoveryCode } from '../core/crypto';
import { FsDir } from '../core/fs';
import { WebBooks } from '../core/webstore';
import { unlockWithRecovery } from './session';
import { attempt, busy, toast } from './ui';

/**
 * Shows a new recovery code as a QR code with the steps to save it on a phone,
 * and does not go on until a part of it is typed back from the phone. Only then
 * is it made the recovery code.
 */
export function RecoverySetup({ ws, folder, onDone, onCancel }: { ws: WebBooks; folder: string; onDone: () => void; onCancel?: () => void }) {
  const code = useMemo(() => newRecoveryCode(), []);
  const group = useMemo(() => 2 + Math.floor(Math.random() * 4), []);
  const [typed, setTyped] = useState('');
  const [asText, setAsText] = useState(false);
  const groups = code.split('-');
  const want = groups[group - 1];
  const norm = typed.toUpperCase().replace(/\s/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const right = norm === want;
  const qr = useMemo(() => renderSVG(`Utility Soft recovery code for “${folder}”: ${code}`, { border: 2, ecc: 'M' }), [code]);

  const save = () =>
    busy('Saving…', async () => {
      await ws.setRecoveryCode(code);
      toast('Recovery code saved.', 'ok');
      onDone();
    });

  return (
    <div class="start">
      <form
        class="card recovery-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (right) save();
        }}
      >
        <h1>Save your recovery code</h1>
        <p class="lead">
          If you ever forget the password, this code is the only way to open your bills. Nobody can get it back for you, so save it on your phone now.
        </p>
        <div class="recovery">
          <div class="qr-box">
            <div class="qr" aria-label="Recovery code as a QR code" role="img" dangerouslySetInnerHTML={{ __html: qr }} />
            {asText ? (
              <p class="code-text" aria-label="Recovery code">
                {code}
              </p>
            ) : (
              <button type="button" class="link" onClick={() => setAsText(true)}>
                Can't scan? Show the code as text
              </button>
            )}
          </div>
          <ol class="steps">
            <li>
              On your phone, open the <b>Camera</b> (or <b>Google Lens</b>) and point it at the square code.
            </li>
            <li>
              Tap the text that appears, then tap <b>Copy</b>.
            </li>
            <li>
              Open <b>Google Keep</b>, tap <b>+</b> for a new note, paste the text and name the note <i>Utility Soft recovery code</i>.
              <span class="hint"> Keep saves it in your Google account, so it is safe even if you lose the phone.</span>
            </li>
            <li>
              To check it was saved, type <b>group {group}</b> of the code from your note (the {ordinal(group)} block of 4 characters):
              <label class="field check-code">
                <span>Group {group} of the code</span>
                <input
                  value={typed}
                  maxLength={6}
                  autoComplete="off"
                  spellcheck={false}
                  aria-invalid={norm.length === 4 && !right}
                  onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
                />
              </label>
              {norm.length >= 4 && !right && <p class="warn">That is not group {group}. Look again at the note on your phone.</p>}
            </li>
          </ol>
        </div>
        <div class="row">
          {onCancel && (
            <button type="button" onClick={onCancel}>
              Cancel (keep the old code)
            </button>
          )}
          <button class="primary" type="submit" disabled={!right}>
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}

function ordinal(n: number): string {
  return ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][n - 1];
}

/** Opening with the recovery code, then choosing a new password. */
export function RecoveryLogin({ dir, onOpened, onBack }: { dir: FsDir; onOpened: (ws: WebBooks, password: string) => void; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [ws, setWs] = useState<WebBooks | null>(null);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);

  const open = (e: Event) => {
    e.preventDefault();
    attempt(async () => {
      if (!normalizeRecoveryCode(code)) return setError('That is not a whole recovery code: it has 24 letters and digits in 6 groups of 4.');
      const w = await busy('Checking…', () => unlockWithRecovery(dir, code));
      if (w === undefined) return;
      if (!w) return setError(`This is not the recovery code of ${dir.name}. If you have more than one note, try the other one; a newer code replaces older ones.`);
      setError(null);
      setWs(w);
    });
  };
  const setPassword = (e: Event) => {
    e.preventDefault();
    if (a === '') return setError('Choose a password.');
    if (a !== b) return setError('The two passwords do not match.');
    busy('Saving…', async () => {
      await ws!.setPassword(a);
      toast('New password set.', 'ok');
      onOpened(ws!, a);
    });
  };

  return (
    <div class="start">
      {!ws ? (
        <form class="card" onSubmit={open}>
          <h1>Forgot the password?</h1>
          <p class="lead">
            The recovery code opens <b>{dir.name}</b> and lets you choose a new password. It was shown as a QR code when this data was set up, to
            save on your phone.
          </p>
          <div class="notice find-code">
            <p>
              <b>Where to find it:</b> on your phone, open <b>Google Keep</b> and search for <b>recovery code</b>. The note is called{' '}
              <i>Utility Soft recovery code</i>, and its text starts with <i>Utility Soft recovery code for “{dir.name}”</i>.
            </p>
            <p>
              <b>What it looks like:</b> 24 letters and digits in 6 groups of 4, such as <code>7K2Q-M9XD-4R1T-B8VN-3HJW-P6CZ</code>.
            </p>
            <p class="hint">Type it, or paste the whole note. Small letters, spaces, and O for 0 are all fine.</p>
          </div>
          <label class="field">
            <span>Recovery code</span>
            <input autoFocus value={code} autoComplete="off" spellcheck={false} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" onInput={(e) => (setCode((e.target as HTMLInputElement).value), setError(null))} />
          </label>
          {error && <p class="warn">{error}</p>}
          <div class="row">
            <button type="button" onClick={onBack}>
              Back
            </button>
            <button class="primary" type="submit">
              Open
            </button>
          </div>
        </form>
      ) : (
        <form class="card" onSubmit={setPassword}>
          <h1>Choose a new password</h1>
          <p class="lead">The recovery code was right. Choose the password to use from now on.</p>
          <label class="field">
            <span>New password</span>
            <input type="password" autoFocus value={a} onInput={(e) => setA((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>New password again</span>
            <input type="password" value={b} onInput={(e) => setB((e.target as HTMLInputElement).value)} />
          </label>
          {error && <p class="warn">{error}</p>}
          <div class="row">
            <button class="primary" type="submit">
              Save and open
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
