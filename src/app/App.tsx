import { useEffect, useRef, useState } from 'preact/hooks';
import { FsDir } from '../core/fs';
import { readBackupPath, readImpinfo, needsLetterhead } from '../core/config';
import { Client } from '../core/workspace';
import { Session, openSession, resolveData } from './session';
import { Closed, DataFolder, LetterheadForm, Login, SetPassword, Welcome } from './start';
import { Main } from './main';
import { Editor, confirmNextYearCopy } from './editor';
import { autoBackup } from './utility';
import { loadPrefs } from './folders';
import { BusyOverlay, Toasts, attempt, confirmDialog, toast } from './ui';

type Stage =
  | { kind: 'welcome' }
  | { kind: 'login'; program: FsDir }
  | { kind: 'set-password'; program: FsDir; isNew: boolean }
  | { kind: 'letterhead'; program: FsDir }
  | { kind: 'data'; program: FsDir; path: string; reason: 'missing-relative' | 'needs-folder' }
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

  const afterLogin = (program: FsDir) =>
    attempt(async () => {
      if (needsLetterhead(await readImpinfo(program))) {
        setStage({ kind: 'letterhead', program });
        return;
      }
      await connectData(program);
    });

  const connectData = async (program: FsDir) => {
    const r = await resolveData(program);
    if (!r.ok) {
      setStage({ kind: 'data', program, path: r.path, reason: r.reason });
      return;
    }
    setStage({ kind: 'main', s: await openSession(program, r.data, r.label) });
  };

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
      if (prefs.askBackupOnExit && (await readBackupPath(s.program))) {
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
          onOpened={(program, hasPassword) =>
            setStage(hasPassword ? { kind: 'login', program } : { kind: 'set-password', program, isNew: true })
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
          onDone={() => afterLogin(stage.program)}
        />
      );
      break;
    case 'login':
      body = <Login program={stage.program} onLogin={() => afterLogin(stage.program)} onBack={() => setStage({ kind: 'welcome' })} />;
      break;
    case 'letterhead':
      body = (
        <LetterheadForm
          program={stage.program}
          initial={null}
          onDone={() => attempt(() => connectData(stage.program))}
          onSkip={() => attempt(() => connectData(stage.program))}
        />
      );
      break;
    case 'data':
      body = (
        <DataFolder
          program={stage.program}
          path={stage.path}
          reason={stage.reason}
          onBack={() => setStage({ kind: 'welcome' })}
          onChosen={(data, label) => attempt(async () => setStage({ kind: 'main', s: await openSession(stage.program, data, label) }))}
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
