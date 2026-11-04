// Setting up Google Drive backups, step by step, for someone who has never used
// Google Cloud: the owner's own Google Cloud project, kept only in this browser.

import { useEffect, useState } from 'preact/hooks';
import { APP_URL, CLIENT_ID_FORM, clientId, forgetGoogle, googleDrive, preloadGoogle, setClientId } from './google';
import { Modal, attempt, busy, confirmDialog, mountDialog, toast } from './ui';
import { kvDel } from './kv';

export { APP_URL, driveProblem, driveState, googleDrive } from './google';
export type { DriveState } from './google';

const APP_NAME = 'Utility Soft';

function Copy({ text }: { text: string }) {
  return (
    <span class="copy">
      <code>{text}</code>
      <button
        type="button"
        class="small"
        onClick={() =>
          attempt(async () => {
            await navigator.clipboard.writeText(text);
            toast('Copied.', 'ok');
          })
        }
      >
        Copy
      </button>
    </span>
  );
}

function Go({ href, children }: { href: string; children: preact.ComponentChildren }) {
  return (
    <a class="go" href={href} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  );
}

interface Step {
  title: string;
  body: preact.ComponentChildren;
}

function steps(origin: string): Step[] {
  return [
    {
      title: 'Sign in to Google Cloud and make a project',
      body: (
        <>
          <p>
            <Go href="https://console.cloud.google.com/projectcreate">Open “New Project” in Google Cloud</Go>. Sign in with the Google account whose
            Drive should keep the backups (for example your Gmail). If asked, agree to the terms of service; it is free.
          </p>
          <ul>
            <li>
              Project name: <Copy text={APP_NAME} />
            </li>
            <li>Leave “Location” as it is, and click <b>Create</b>.</li>
            <li>
              Wait until the bell at the top right says the project is made, then click <b>Select project</b> there. The name at the top left must
              say <b>Utility Soft</b> for every following step.
            </li>
          </ul>
        </>
      ),
    },
    {
      title: 'Switch on the Google Drive API',
      body: (
        <>
          <p>
            <Go href="https://console.cloud.google.com/apis/library/drive.googleapis.com">Open “Google Drive API”</Go> and click the blue{' '}
            <b>Enable</b> button. (If it says <b>Manage</b> instead, it is already on.)
          </p>
        </>
      ),
    },
    {
      title: 'Describe the app (the screen Google shows when you allow it)',
      body: (
        <>
          <p>
            <Go href="https://console.cloud.google.com/auth/branding">Open “Google Auth Platform ▸ Branding”</Go> and click <b>Get started</b>.
          </p>
          <ol>
            <li>
              App name: <Copy text={APP_NAME} />, User support email: choose your email. <b>Next</b>.
            </li>
            <li>
              Audience: choose <b>External</b>. <b>Next</b>.
            </li>
            <li>
              Contact information: type your email. <b>Next</b>.
            </li>
            <li>
              Tick “I agree…”, <b>Continue</b>, then <b>Create</b>.
            </li>
          </ol>
        </>
      ),
    },
    {
      title: 'Allow only your own Google account',
      body: (
        <>
          <p>
            <Go href="https://console.cloud.google.com/auth/audience">Open “Audience”</Go>. Leave “Publishing status” at <b>Testing</b>: do not
            publish the app.
          </p>
          <ul>
            <li>
              Under <b>Test users</b>, click <b>+ Add users</b>, type your Gmail address (and only those of people you trust, such as a second
              office account), and <b>Save</b>.
            </li>
            <li>Google then refuses everyone else, so nobody else can use your project.</li>
          </ul>
        </>
      ),
    },
    {
      title: 'Allow only the backups folder (the smallest permission)',
      body: (
        <>
          <p>
            <Go href="https://console.cloud.google.com/auth/scopes">Open “Data access”</Go> and click <b>Add or remove scopes</b>.
          </p>
          <ul>
            <li>
              In “Filter”, type <Copy text="drive.file" /> and tick the one row that appears:{' '}
              <i>…/auth/drive.file — See, edit, create, and delete only the specific Google Drive files you use with this app</i>.
            </li>
            <li>
              Click <b>Update</b>, then <b>Save</b> at the bottom of the page.
            </li>
            <li>
              Do not tick anything else. With this, Utility Soft sees only the files it makes itself (its “Utility Soft backups” folder), never your
              other Drive files.
            </li>
          </ul>
        </>
      ),
    },
    {
      title: 'Make the Client ID',
      body: (
        <>
          <p>
            <Go href="https://console.cloud.google.com/auth/clients/create">Open “Create OAuth client ID”</Go>.
          </p>
          <ul>
            <li>
              Application type: <b>Web application</b>. Name: <Copy text={APP_NAME} />
            </li>
            <li>
              Under <b>Authorized JavaScript origins</b>, click <b>+ Add URI</b> and paste exactly: <Copy text={origin} />
            </li>
            <li>Leave “Authorized redirect URIs” empty, and click <b>Create</b>.</li>
            <li>
              A window shows the <b>Client ID</b> (it ends with <code>.apps.googleusercontent.com</code>). Click the copy symbol next to it. You do
              not need the “Client secret”; Utility Soft never uses it.
            </li>
          </ul>
        </>
      ),
    },
  ];
}

/** The guided setup; true when a Client ID was saved (and checked). */
export function askClientId(): Promise<boolean> {
  return mountDialog<boolean>((done) => <Wizard done={done} />);
}

function Wizard({ done }: { done: (v: boolean) => void }) {
  useEffect(() => preloadGoogle(), []);
  const origin = location.protocol === 'file:' ? new URL(APP_URL).origin : location.origin;
  const all = steps(origin);
  const [at, setAt] = useState(0);
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const last = at === all.length;
  const save = () =>
    attempt(async () => {
      const v = id.trim();
      if (!CLIENT_ID_FORM.test(v)) return setError('That is not a Client ID. It looks like 123456789012-abc123def456.apps.googleusercontent.com');
      const old = await clientId();
      await setClientId(v);
      // Check it: Google opens its window (choose your account, then Continue twice), and the backups folder is made.
      const ok = await busy('Checking with Google…', async () => {
        await googleDrive().folder();
        return true;
      });
      if (!ok) {
        if (old) await setClientId(old);
        else await kvDel('googleClientId');
        return setError('Google did not accept it. Check the steps (especially the test user and the origin), then try again.');
      }
      toast('Google Drive is set up on this computer.', 'ok');
      done(true);
    });
  return (
    <Modal
      title="Set up Google Drive backups"
      wide
      class="wizard"
      onClose={() => done(false)}
      footer={
        <>
          <span class="hint grow">{last ? 'Last step' : `Step ${at + 1} of ${all.length + 1}`}</span>
          {at > 0 && <button onClick={() => (setAt(at - 1), setError(null))}>Back</button>}
          {last ? (
            <button class="primary" onClick={save}>
              Save and check
            </button>
          ) : (
            <button class="primary" onClick={() => setAt(at + 1)}>
              Done, next step
            </button>
          )}
        </>
      }
    >
      {at === 0 && (
        <div class="notice">
          <p>
            Your backups will go to <b>your own</b> Google Drive, through a Google Cloud project that is <b>yours alone</b>. This takes about 10
            minutes, once. Each step below opens the right Google page in a new tab: do what it says, then come back here.
          </p>
          <p class="hint">
            It is free for this use. Utility Soft only ever sees its own backups folder in your Drive, and the backups are encrypted before they
            leave this computer.
          </p>
        </div>
      )}
      <ol class="wizard-steps">
        {all.map((st, i) => (
          <li key={st.title} class={i === at ? 'current' : i < at ? 'done' : ''}>
            <button type="button" class="link step-title" onClick={() => setAt(i)}>
              {i < at ? '✓ ' : ''}
              {st.title}
            </button>
            {i === at && <div class="step-body">{st.body}</div>}
          </li>
        ))}
        <li class={last ? 'current' : ''}>
          <button type="button" class="link step-title" onClick={() => setAt(all.length)}>
            Paste the Client ID here
          </button>
          {last && (
            <div class="step-body">
              <label class="field">
                <span>Client ID</span>
                <input autoFocus value={id} placeholder="123456789012-abc123def456.apps.googleusercontent.com" onInput={(e) => (setId((e.target as HTMLInputElement).value), setError(null))} />
              </label>
              <p class="hint">
                “Save and check” opens Google's window: choose your account. Google warns that it “hasn't verified this app”: that is your own app, so
                click <b>Continue</b>, then allow access to the files Utility Soft makes, and <b>Continue</b>. The Client ID is kept only in this
                browser. Save it with your recovery code to use on another computer.
              </p>
              {error && <p class="warn">{error}</p>}
            </div>
          )}
        </li>
      </ol>
    </Modal>
  );
}

/** Utility ▸ Google Drive: which project is used here, change it, or stop using Drive on this computer. */
export function driveSettingsDialog(): Promise<void> {
  return mountDialog<void>((done) => <DriveSettings done={done} />);
}

function DriveSettings({ done }: { done: () => void }) {
  const [id, setId] = useState<string | null | undefined>(undefined);
  if (id === undefined) clientId().then((v) => setId(v || null), () => setId(null));
  const change = () =>
    attempt(async () => {
      if (id) {
        const ok = await confirmDialog({
          title: 'Change the Google Cloud project',
          message: (
            <>
              <p>Utility Soft will use another Google Cloud project (Client ID) on this computer.</p>
              <p class="hint">
                Google lets each project see only the files it made. So backups made with the old project stay in your Drive but are no longer
                listed here. To restore one of them, download it from drive.google.com (folder “Utility Soft backups”) and use Utility ▸ Backups ▸{' '}
                <i>Restore from a backup file</i>.
              </p>
            </>
          ),
          ok: 'Continue',
        });
        if (!ok) return;
      }
      if (await askClientId()) setId(await clientId());
    });
  const off = () =>
    attempt(async () => {
      const ok = await confirmDialog({
        title: 'Stop using Google Drive on this computer',
        message: <p>The Client ID is removed from this browser. The backups already in your Drive stay there.</p>,
        ok: 'Stop',
        danger: true,
      });
      if (!ok) return;
      await kvDel('googleClientId');
      forgetGoogle();
      setId(null);
      toast('Google Drive is no longer used on this computer.', 'ok');
    });
  return (
    <Modal title="Google Drive" onClose={done} footer={<button onClick={done}>Close</button>}>
      {id === undefined ? (
        <p>Loading…</p>
      ) : id ? (
        <>
          <p>
            Backups go to your Google Drive through your Google Cloud project with the Client ID <code>{`${id.slice(0, 12)}…${id.slice(-30)}`}</code>.
          </p>
          <p class="hint">Permission: only the files Utility Soft makes in your Drive (drive.file). Kept only in this browser.</p>
          <div class="row left">
            <button onClick={change}>Change the Google Cloud project…</button>
            <button onClick={off}>Stop using Google Drive here…</button>
          </div>
        </>
      ) : (
        <>
          <p>Google Drive is not set up on this computer.</p>
          <button class="primary" onClick={change}>
            Set up Google Drive…
          </button>
        </>
      )}
    </Modal>
  );
}
