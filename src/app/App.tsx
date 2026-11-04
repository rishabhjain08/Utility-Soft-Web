import { useEffect, useRef, useState } from 'preact/hooks';
import { FsDir } from '../core/fs';
import { FsaDir } from '../core/fsa';
import { Client, LockInfo, WebBooks } from '../core/webstore';
import { Session, openWebSession } from './session';
import { Closed, LetterheadForm, Login, Place, SetPassword, Welcome } from './start';
import { DesktopChoice, openCopy } from './migrate';
import { RecoveryLogin, RecoverySetup } from './recovery';
import { PaymentsPage } from './payments';
import { OpenAt } from './search';
import { Main } from './main';
import { Editor, confirmNextYearCopy } from './editor';
import { autoBackup } from './utility';
import { loadPrefs } from './folders';
import { BusyOverlay, Toasts, attempt, busy, confirmDialog, setErrorLog, toast } from './ui';
import { backupToDrive, driveDue } from '../core/backup';
import { driveState, googleDrive } from './google';

/** Locks the data after this long without use (the computer is shared). */
const IDLE_LOCK = 15 * 60_000;
/** How often an open client is marked as still open (see LOCK_STALE). */
const HEARTBEAT = 60_000;

type Stage =
  | { kind: 'welcome' }
  | { kind: 'login'; place: Place; message?: string }
  | { kind: 'recovery-login'; dir: FsDir }
  | { kind: 'set-password'; program: FsDir; isNew: boolean }
  | { kind: 'desktop-choice'; program: FsDir; password: string }
  | { kind: 'recovery-setup'; s: Session }
  | { kind: 'letterhead'; s: Session }
  | { kind: 'main'; s: Session }
  | { kind: 'editor'; s: Session; year: string; client: Client; at?: { folder?: string; bill?: string }; back?: 'payments' }
  | { kind: 'payments'; s: Session; year: string | null }
  | { kind: 'closed' };

/** "is open on Office PC since 10:32" */
export function openWhere(l: LockInfo): string {
  const since = new Date(l.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (l.mine) return `is open in another window of this browser (since ${since})`;
  return `is open on ${l.computer.name || 'another computer'} (since ${since})`;
}

export function App() {
  const [stage, setStage] = useState<Stage>({ kind: 'welcome' });
  const [year, setYear] = useState<string | null>(null);
  const [focusName, setFocusName] = useState<string | null>(null);

  // The client this tab has open (marked in the data folder's open/).
  const held = useRef<{ s: Session; year: string; name: string } | null>(null);
  // Marking and releasing it happen one after another, so a late "still open" cannot follow a release.
  const marks = useRef<Promise<unknown>>(Promise.resolve());
  const mark = (fn: () => Promise<unknown>) => (marks.current = marks.current.then(fn, fn));

  // Release it if the tab is closed while a client is open.
  useEffect(() => {
    const release = () => {
      const h = held.current;
      if (h) h.s.ws.unlock(h.year, h.name).catch(() => undefined);
    };
    window.addEventListener('pagehide', release);
    const beat = window.setInterval(() => {
      const h = held.current;
      if (h) mark(() => h.s.ws.heartbeat(h.year, h.name).catch(() => undefined));
    }, HEARTBEAT);
    return () => {
      window.removeEventListener('pagehide', release);
      window.clearInterval(beat);
    };
  }, []);

  const session = stage.kind === 'main' || stage.kind === 'editor' || stage.kind === 'payments' ? stage.s : null;
  useEffect(() => setErrorLog(session ? (m) => session.ws.log(m) : null), [session?.ws]);

  // Lock after a while without use: back to the password.
  useEffect(() => {
    if (!session) return;
    let timer = 0;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const h = held.current;
        held.current = null;
        if (h) mark(() => h.s.ws.unlock(h.year, h.name).catch(() => undefined));
        setStage({ kind: 'login', place: { kind: 'web', dir: session.root }, message: 'Locked after 15 minutes without use. Enter the password to go on.' });
      }, IDLE_LOCK);
    };
    const events = ['keydown', 'pointerdown', 'wheel'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [session?.ws]);

  /** After the data is opened: the recovery code must be saved, then the letterhead filled in. */
  const proceed = (s: Session) =>
    attempt(async () => {
      if (!(await s.ws.recoverySaved())) setStage({ kind: 'recovery-setup', s });
      else if (!s.letterhead) setStage({ kind: 'letterhead', s });
      else setStage({ kind: 'main', s });
    });

  const opened = (ws: WebBooks, password: string) => attempt(async () => proceed(await openWebSession(ws, password)));

  const afterLogin = (place: Place, ws: WebBooks | null, password: string) => {
    if (place.kind === 'desktop' || !ws) setStage({ kind: 'desktop-choice', program: place.dir, password });
    else opened(ws, password);
  };

  /** A web copy made earlier: opens it with the same password, or asks for its own. */
  const openWebCopy = (dir: FsaDir, password: string) =>
    attempt(async () => {
      const s = await openCopy(dir, password);
      if (s) proceed(s);
      else setStage({ kind: 'login', place: { kind: 'web', dir } });
    });

  const confirmOpen = async (name: string, y: string, l: LockInfo) =>
    confirmDialog({
      title: 'Already open',
      message: (
        <>
          <p>
            <b>{name}</b> ({y}) {openWhere(l)}.
          </p>
          <p class="hint">
            If nobody is working on it there (for example Utility Soft was closed without pressing Done), you can open it anyway. If both save the same bill,
            the second one is asked which version to keep.
          </p>
        </>
      ),
      ok: 'Open anyway',
      cancel: 'Cancel',
    });

  const openClient = (s: Session, y: string, client: Client, at?: { folder?: string; bill?: string }, back?: 'payments') =>
    attempt(async () => {
      const l = await s.ws.lockInfo(y, client.name);
      if (l && !(await confirmOpen(client.name, y, l))) return;
      await mark(() => s.ws.lock(y, client.name));
      held.current = { s, year: y, name: client.name };
      setStage({ kind: 'editor', s, year: y, client, at, back });
    });

  /** A client of any year, at a bill (from searching or the payments page). */
  const openAt = (s: Session, at: OpenAt, back?: 'payments') =>
    attempt(async () => {
      const c = (await s.ws.clients(at.year)).find((x) => x.name === at.client);
      if (!c) return toast(`${at.client} is no longer in ${at.year}.`, 'error');
      setYear(at.year);
      await openClient(s, at.year, c, { folder: at.folder, bill: at.bill }, back);
    });

  const relock = async (s: Session, from: string, to: string, name: string) => {
    const l = await s.ws.lockInfo(to, name);
    if (l && !(await confirmOpen(name, to, l))) return false;
    await mark(async () => {
      await s.ws.unlock(from, name);
      await s.ws.lock(to, name);
    });
    held.current = { s, year: to, name };
    return true;
  };

  const closeEditor = (s: Session, y: string, name: string, back?: 'payments') =>
    attempt(async () => {
      held.current = null;
      await mark(() => s.ws.unlock(y, name));
      await confirmNextYearCopy(s, y, name);
      setYear(y);
      setFocusName(name);
      setStage(back === 'payments' ? { kind: 'payments', s, year: y } : { kind: 'main', s });
    });

  const exit = (s: Session) =>
    attempt(async () => {
      const prefs = await loadPrefs();
      if ((await driveState()).ok && driveDue((await s.ws.settings()).drive)) {
        const yes = await confirmDialog({ title: 'Exit', message: <p>Today's backup to Google Drive is not made yet. Make it before closing?</p>, ok: 'Back up to Drive', cancel: 'Not now' });
        if (yes && !(await busy('Backing up to Google Drive…', async () => (await backupToDrive(s.ws, googleDrive()), true)))) return;
      }
      if (prefs.askBackupOnExit && (await s.ws.backupPath())) {
        const yes = await confirmDialog({ title: 'Exit', message: <p>Back up the data before closing?</p>, ok: 'Yes', cancel: 'No' });
        if (yes && !(await autoBackup(s))) {
          toast('Backup was not made.', 'error');
          return;
        }
      }
      setStage({ kind: 'closed' });
    });

  let body;
  switch (stage.kind) {
    case 'welcome':
      body = (
        <Welcome
          onOpened={(dir, kind, hasPassword) =>
            setStage(
              kind === 'new'
                ? { kind: 'set-password', program: dir, isNew: true }
                : hasPassword
                  ? { kind: 'login', place: { kind, dir } }
                  : { kind: 'set-password', program: dir, isNew: false },
            )
          }
        />
      );
      break;
    case 'set-password':
      body = (
        <SetPassword
          program={stage.program}
          isNew={stage.isNew}
          onBack={() => setStage({ kind: 'welcome' })}
          onDone={(ws, pw) => (ws ? opened(ws, pw) : setStage({ kind: 'desktop-choice', program: stage.program, password: pw }))}
        />
      );
      break;
    case 'login':
      body = (
        <Login
          place={stage.place}
          message={stage.message}
          onLogin={(ws, pw) => afterLogin(stage.place, ws, pw)}
          onRecovery={() => setStage({ kind: 'recovery-login', dir: stage.place.dir })}
          onBack={() => setStage({ kind: 'welcome' })}
        />
      );
      break;
    case 'recovery-login':
      body = <RecoveryLogin dir={stage.dir} onOpened={opened} onBack={() => setStage({ kind: 'login', place: { kind: 'web', dir: stage.dir } })} />;
      break;
    case 'desktop-choice':
      body = (
        <DesktopChoice
          program={stage.program}
          password={stage.password}
          onMigrated={proceed}
          onOpenCopy={(dir) => openWebCopy(dir, stage.password)}
          onBack={() => setStage({ kind: 'welcome' })}
        />
      );
      break;
    case 'recovery-setup':
      body = <RecoverySetup ws={stage.s.ws} folder={stage.s.dataLabel} onDone={() => proceed(stage.s)} />;
      break;
    case 'letterhead': {
      const s = stage.s;
      const next = async () => setStage({ kind: 'main', s: { ...s, letterhead: await s.ws.letterhead() } });
      body = <LetterheadForm save={(lh) => s.ws.saveLetterhead(lh)} initial={null} onDone={() => attempt(next)} onSkip={() => attempt(next)} />;
      break;
    }
    case 'main':
      body = (
        <Main
          s={stage.s}
          year={year}
          setYear={(y) => {
            setFocusName(null);
            setYear(y);
          }}
          focusName={focusName}
          onOpen={(c) => year && openClient(stage.s, year, c)}
          onOpenAt={(at) => openAt(stage.s, at)}
          onPayments={() => setStage({ kind: 'payments', s: stage.s, year })}
          onExit={() => exit(stage.s)}
          onSession={(s) => setStage({ kind: 'main', s })}
        />
      );
      break;
    case 'editor':
      body = (
        <Editor
          key={`${stage.client.name}`}
          s={stage.s}
          year={stage.year}
          client={stage.client}
          relock={(from, to, name) => relock(stage.s, from, to, name)}
          at={stage.at}
          onDone={(y, name) => closeEditor(stage.s, y, name, stage.back)}
        />
      );
      break;
    case 'payments':
      body = <PaymentsPage s={stage.s} year={stage.year} onOpenAt={(at) => openAt(stage.s, at, 'payments')} onBack={() => setStage({ kind: 'main', s: stage.s })} />;
      break;
    case 'closed':
      body = <Closed onReopen={() => setStage({ kind: 'welcome' })} />;
      break;
  }

  return (
    <>
      {body}
      <Toasts />
      <BusyOverlay />
    </>
  );
}
