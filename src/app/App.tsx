import { useEffect, useRef, useState } from 'preact/hooks';
import { FsDir } from '../core/fs';
import { Letterhead, readImpinfo, needsLetterhead, writeLetterhead } from '../core/config';
import { FsaDir } from '../core/fsa';
import { WebBooks } from '../core/webstore';
import { Client } from '../core/workspace';
import { Place, Session, openSession, openWebSession, resolveData } from './session';
import { Closed, DataFolder, LetterheadForm, Login, SetPassword, Welcome } from './start';
import { DesktopChoice, openCopy } from './migrate';
import { Main } from './main';
import { Editor, confirmNextYearCopy } from './editor';
import { autoBackup } from './utility';
import { loadPrefs } from './folders';
import { BusyOverlay, Toasts, attempt, confirmDialog, toast } from './ui';

/**
 * Quietly fixes bills that the desktop (Java) version could not open — it can
 * write such data itself at any time. See protectForJava in core/bill.ts.
 */
function checkForDesktop(s: Session) {
  if (s.ws.kind !== 'desktop') return;
  s.ws
    .protectAll(undefined, { skipOpen: true })
    .then((r) => {
      if (r.fixed) toast(`Prepared ${r.fixed} bill${r.fixed === 1 ? '' : 's'} so the desktop version can open ${r.fixed === 1 ? 'it' : 'them'}.`, 'info');
    })
    .catch((e) => console.warn('Desktop check skipped:', e));
}

type Stage =
  | { kind: 'welcome' }
  | { kind: 'login'; place: Place }
  | { kind: 'set-password'; program: FsDir; isNew: boolean }
  | { kind: 'desktop-choice'; program: FsDir; password: string }
  | { kind: 'letterhead'; save: (lh: Letterhead) => Promise<void>; next: () => Promise<void> }
  | { kind: 'data'; program: FsDir; path: string; reason: 'missing-relative' | 'needs-folder'; password: string }
  | { kind: 'main'; s: Session }
  | { kind: 'editor'; s: Session; year: string; client: Client }
  | { kind: 'closed' };

export function App() {
  const [stage, setStage] = useState<Stage>({ kind: 'welcome' });
  const [year, setYear] = useState<string | null>(null);
  const [focusName, setFocusName] = useState<string | null>(null);

  // The client currently locked in activelocation.txt by this tab.
  const held = useRef<{ s: Session; year: string; name: string } | null>(null);

  // Release the lock if the tab is closed while a client is open.
  useEffect(() => {
    const release = () => {
      const h = held.current;
      if (h) h.s.ws.unlock(h.year, h.name).catch(() => undefined);
    };
    window.addEventListener('pagehide', release);
    return () => window.removeEventListener('pagehide', release);
  }, []);

  const afterLogin = (place: Place, password: string) =>
    attempt(async () => {
      if (place.kind === 'desktop') {
        setStage({ kind: 'desktop-choice', program: place.dir, password });
        return;
      }
      const web = new WebBooks(place.dir);
      const open = async () => setStage({ kind: 'main', s: await openWebSession(place.dir, password) });
      if ((await web.letterhead()) === null) {
        setStage({ kind: 'letterhead', save: (lh) => web.saveLetterhead(lh), next: open });
        return;
      }
      await open();
    });

  /** Working on the desktop files themselves. */
  const keepDesktop = (program: FsDir, password: string) =>
    attempt(async () => {
      if (needsLetterhead(await readImpinfo(program))) {
        setStage({ kind: 'letterhead', save: (lh) => writeLetterhead(program, lh), next: () => connectData(program, password) });
        return;
      }
      await connectData(program, password);
    });

  const connectData = async (program: FsDir, password: string) => {
    const r = await resolveData(program);
    if (!r.ok) {
      setStage({ kind: 'data', program, path: r.path, reason: r.reason, password });
      return;
    }
    const s = await openSession(program, r.data, r.label, password);
    setStage({ kind: 'main', s });
    checkForDesktop(s);
  };

  /** A web copy made earlier: opens it with the same password, or asks for its own. */
  const openWebCopy = (dir: FsaDir, password: string) =>
    attempt(async () => {
      const s = await openCopy(dir, password);
      setStage(s ? { kind: 'main', s } : { kind: 'login', place: { kind: 'web', dir } });
    });

  const openClient = (s: Session, y: string, client: Client) =>
    attempt(async () => {
      if (await s.ws.isLocked(y, client.name)) {
        const ok = await confirmDialog({
          title: 'Already open',
          message: (
            <>
              <p>
                <b>{client.name}</b> ({y}) is open on another computer.
              </p>
              <p class="hint">If nobody else is working on it (for example Utility Soft was closed without pressing Done), you can open it anyway.</p>
            </>
          ),
          ok: 'Open anyway',
          cancel: 'Cancel',
        });
        if (!ok) return;
      }
      await s.ws.lock(y, client.name);
      held.current = { s, year: y, name: client.name };
      setStage({ kind: 'editor', s, year: y, client });
    });

  const relock = async (s: Session, from: string, to: string, name: string) => {
    if (await s.ws.isLocked(to, name)) {
      const ok = await confirmDialog({
        title: 'Already open',
        message: (
          <p>
            <b>{name}</b> ({to}) is open on another computer. Open it anyway?
          </p>
        ),
        ok: 'Open anyway',
      });
      if (!ok) return false;
    }
    await s.ws.unlock(from, name);
    await s.ws.lock(to, name);
    held.current = { s, year: to, name };
    return true;
  };

  const closeEditor = (s: Session, y: string, name: string) =>
    attempt(async () => {
      await s.ws.unlock(y, name);
      held.current = null;
      await confirmNextYearCopy(s, y, name);
      setYear(y);
      setFocusName(name);
      setStage({ kind: 'main', s });
    });

  const exit = (s: Session) =>
    attempt(async () => {
      const prefs = await loadPrefs();
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
          onDone={(pw) => afterLogin({ kind: stage.isNew ? 'web' : 'desktop', dir: stage.program }, pw)}
        />
      );
      break;
    case 'login':
      body = <Login place={stage.place} onLogin={(pw) => afterLogin(stage.place, pw)} onBack={() => setStage({ kind: 'welcome' })} />;
      break;
    case 'desktop-choice':
      body = (
        <DesktopChoice
          program={stage.program}
          password={stage.password}
          onMigrated={(s) => setStage({ kind: 'main', s })}
          onKeep={() => keepDesktop(stage.program, stage.password)}
          onOpenCopy={(dir) => openWebCopy(dir, stage.password)}
          onBack={() => setStage({ kind: 'welcome' })}
        />
      );
      break;
    case 'letterhead':
      body = <LetterheadForm save={stage.save} initial={null} onDone={() => attempt(stage.next)} onSkip={() => attempt(stage.next)} />;
      break;
    case 'data':
      body = (
        <DataFolder
          program={stage.program}
          path={stage.path}
          reason={stage.reason}
          onBack={() => setStage({ kind: 'welcome' })}
          onChosen={(data, label) =>
            attempt(async () => {
              const s = await openSession(stage.program, data, label, stage.password);
              setStage({ kind: 'main', s });
              checkForDesktop(s);
            })
          }
        />
      );
      break;
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
          onDone={(y, name) => closeEditor(stage.s, y, name)}
        />
      );
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
