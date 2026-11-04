// Moving to the web format (once), exporting back for the desktop version, and
// comparing the two. Everything is written into a new folder; the folder copied
// from is only read.

import { useEffect, useState } from 'preact/hooks';
import { FsaDir } from '../core/fsa';
import { FsDir, findEntry, isNotFound } from '../core/fs';
import { decodePlainLines } from '../core/codec';
import { readPassword } from '../core/config';
import { DesktopFolders, exportToDesktop, isInside, migrateDesktop } from '../core/migrate';
import { VerifyReport, verify } from '../core/verify';
import { LOCKS } from '../core/desktop';
import { ensurePermission, migrationOf, pickFolder, rememberMigration, rememberPath, rememberProgram } from './folders';
import { Session, findDesktopData, inspectProgram, openWebSession, thisComputer, unlock } from './session';
import { Modal, attempt, busy, confirmDialog, mountDialog, promptDialog, setBusyLabel, toast } from './ui';

// ---------- choosing where a new folder goes ----------

/**
 * Asks where to put a new folder: the chosen folder itself when it is empty,
 * otherwise a new folder inside it, named by the user. Never inside `outside`.
 * null when cancelled.
 */
export async function chooseNewFolder(o: {
  id: string;
  title: string;
  suggestion: string;
  outside?: FsDir[];
  /** Lets the caller handle a chosen folder itself: return a folder, null to cancel, undefined to go on. */
  check?: (place: FsaDir) => Promise<FsaDir | null | undefined>;
}): Promise<FsaDir | null> {
  const place = await pickFolder(o.id);
  if (!place) return null;
  for (const out of o.outside ?? []) {
    if (await isInside(out, place)) {
      await confirmDialog({
        title: o.title,
        message: (
          <p>
            Choose a place outside <b>{out.name}</b>, so that it stays exactly as it is (for example Documents or D:\).
          </p>
        ),
        ok: 'OK',
      });
      return null;
    }
  }
  if (o.check) {
    const r = await o.check(place);
    if (r !== undefined) return r;
  }
  const entries = await place.list();
  if (entries.length === 0) return place;
  const taken = new Set(entries.map((e) => e.name.toLowerCase()));
  let suggestion = o.suggestion;
  for (let i = 2; taken.has(suggestion.toLowerCase()); i++) suggestion = `${o.suggestion} ${i}`;
  const name = await promptDialog({
    title: o.title,
    label: 'Name of the new folder',
    value: suggestion,
    ok: 'Create',
    hint: (
      <>
        It will be created inside <b>{place.name}</b>.
      </>
    ),
    validate: (v) => {
      const n = v.trim();
      if (n === '') return 'Type a name.';
      if (/[\\/:*?"<>|]/.test(n) || /[. ]$/.test(v)) return 'A folder name cannot contain \\ / : * ? " < > | or end with a dot.';
      if (taken.has(n.toLowerCase())) return `“${n}” already exists in ${place.name}.`;
      return null;
    },
  });
  if (name === null) return null;
  return (await place.dir(name.trim(), true)) as FsaDir;
}

// ---------- the report ----------

export function ReportView({ report, desktopLabel, webLabel }: { report: VerifyReport; desktopLabel: string; webLabel: string }) {
  const c = report.counts;
  const what = `${c.years} year${c.years === 1 ? '' : 's'}, ${c.clients} client${c.clients === 1 ? '' : 's'} and ${c.bills} bill${c.bills === 1 ? '' : 's'} (${c.rows} row${c.rows === 1 ? '' : 's'})`;
  return (
    <div class="report">
      {report.ok ? (
        <p class="report-ok">
          <span class="report-mark" aria-hidden="true">
            ✓
          </span>
          Everything matches: {what}, the letterhead, tabs, drop-down lists and password.
        </p>
      ) : (
        <p class="report-bad">
          <span class="report-mark" aria-hidden="true">
            !
          </span>
          {report.differences.length + report.more} difference{report.differences.length + report.more === 1 ? '' : 's'} found (checked {what}).
        </p>
      )}
      {report.notes.length > 0 && (
        <ul class="report-notes">
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {report.differences.length > 0 && (
        <div class="report-table">
          <table>
            <thead>
              <tr>
                <th>Where</th>
                <th>{desktopLabel}</th>
                <th>{webLabel}</th>
              </tr>
            </thead>
            <tbody>
              {report.differences.map((d, i) => (
                <tr key={i}>
                  <td>{d.where}</td>
                  <td>{d.desktop}</td>
                  <td>{d.web}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.more > 0 && <p class="hint">…and {report.more} more.</p>}
        </div>
      )}
    </div>
  );
}

function reportDialog(o: { title: string; intro: preact.ComponentChildren; report: VerifyReport; ok?: string; cancel?: string }): Promise<boolean> {
  return mountDialog<boolean>((done) => (
    <Modal
      title={o.title}
      wide
      onClose={() => done(false)}
      footer={
        <>
          {o.ok && <button onClick={() => done(false)}>{o.cancel ?? 'Close'}</button>}
          <button class="primary" autoFocus onClick={() => done(!!o.ok)}>
            {o.ok ?? o.cancel ?? 'Close'}
          </button>
        </>
      }
    >
      {o.intro}
      <ReportView report={o.report} desktopLabel="Desktop folder" webLabel="Web format" />
    </Modal>
  ));
}

// ---------- finding a desktop installation's data ----------

/** The program and data folders of a desktop installation, asking for the data folder if needed. */
async function desktopFolders(program: FsDir): Promise<DesktopFolders | null> {
  const r = await findDesktopData(program);
  if ('data' in r) return { program, data: r.data, dataLabel: r.label };
  const ok = await confirmDialog({
    title: 'Where is the data?',
    message: (
      <p>
        The bills of <b>{program.name}</b> are kept in <b class="path">{r.path}</b>. Select that folder so the browser can read it.
      </p>
    ),
    ok: 'Select folder…',
  });
  if (!ok) return null;
  const dir = await pickFolder('utility-soft-data');
  if (!dir) return null;
  await rememberPath('data', r.path, dir);
  return { program, data: dir, dataLabel: r.path };
}

async function openInDesktop(data: FsDir | null): Promise<string[]> {
  if (!data) return [];
  const e = await findEntry(data, LOCKS, 'file');
  if (!e) return [];
  try {
    return decodePlainLines(await data.read(e.name)).filter((l) => l.trim() !== '');
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

// ---------- migration ----------

/**
 * Copies a desktop installation into a new folder in the web format and checks
 * the copy. Returns the session on the copy when the user opens it.
 */
export async function migrateFlow(program: FsDir, password: string): Promise<Session | null> {
  // A desktop folder without pass.txt: the password chosen for the copy is used.
  const src = await desktopFolders(program);
  if (!src) return null;
  const open = await openInDesktop(src.data);
  if (open.length) {
    const ok = await confirmDialog({
      title: 'Clients open in the desktop version',
      message: (
        <>
          <p>
            These are open in the desktop version right now: <b>{open.map((l) => l.replace(',', ' ')).join(', ')}</b>.
          </p>
          <p class="hint">
            Changes not yet saved there will not be in the copy. Press Done in the desktop version first. If it was closed without pressing Done,
            make the copy anyway.
          </p>
        </>
      ),
      ok: 'Make the copy anyway',
    });
    if (!ok) return null;
  }
  const dest = await chooseNewFolder({
    id: 'utility-soft-copy',
    title: 'Where should the copy go?',
    suggestion: 'Utility Soft Data',
    outside: [program, ...(src.data ? [src.data] : [])],
  });
  if (!dest) return null;
  const result = await busy('Copying…', () => migrateDesktop(src, dest, { password, onProgress: setBusyLabel }));
  if (!result) return null;
  const go = await reportDialog({
    title: result.report.ok ? 'Copy made and checked' : 'The copy does not match',
    intro: result.report.ok ? (
      <>
        <p>
          Your bills are now also in <b>{dest.name}</b>, in the web format, encrypted: nobody can read them without the password. <b>{program.name}</b>{' '}
          was not changed.
        </p>
        <p class="warn">
          The desktop folder <b>{program.name}</b> is not encrypted: anyone using this computer can read it. Once you have checked your bills in the
          copy, move it to a USB stick kept somewhere safe, or delete it.
        </p>
      </>
    ) : (
      <p class="warn">
        The copy in <b>{dest.name}</b> is different from <b>{program.name}</b>. Nothing was changed in {program.name}. Please keep using it and
        report this problem; the copy can be deleted.
      </p>
    ),
    report: result.report,
    ok: result.report.ok ? 'Open the copy' : undefined,
    cancel: result.report.ok ? 'Not now' : 'Close',
  });
  if (!result.report.ok) return null;
  await rememberMigration(program, dest);
  if (!go) return null;
  await rememberProgram(dest);
  toast(`Opened ${dest.name}. From now on, use Utility Soft on this folder.`, 'ok');
  return openWebSession(result.books.as({ computer: await thisComputer() }), password);
}

/** After the password of a desktop folder: the one-time move to the web format. */
export function DesktopChoice({
  program, password, onMigrated, onOpenCopy, onBack,
}: {
  program: FsDir;
  password: string;
  onMigrated: (s: Session) => void;
  onOpenCopy: (dir: FsaDir) => void;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState<{ to: FsaDir; at: Date } | null>(null);
  useEffect(() => {
    migrationOf(program).then(setCopied, () => undefined);
  }, []);
  const migrate = () =>
    attempt(async () => {
      const s = await migrateFlow(program, password);
      if (s) onMigrated(s);
      else setCopied(await migrationOf(program));
    });
  return (
    <div class="start">
      <div class="card desktop-choice">
        <h1>Move to the new format</h1>
        <p class="lead">
          <b>{program.name}</b> is in the desktop (Java) version's format.
        </p>
        {copied && (
          <div class="notice">
            <p>
              This folder was already copied to <b>{copied.to.name}</b> on {copied.at.toLocaleDateString()}. Bills entered here since then are not in
              that copy.
            </p>
            <button class="primary" onClick={() => onOpenCopy(copied.to)}>
              Open “{copied.to.name}”
            </button>
          </div>
        )}
        <p>
          Utility Soft keeps your bills in its own format, encrypted with your password. Moving is done once: the app makes a copy in a new folder
          and checks every bill, client and setting against this one. <b>This folder is not changed.</b>
        </p>
        <button class={copied ? 'big' : 'primary big'} onClick={migrate}>
          {copied ? 'Make a new copy…' : 'Make a copy in the new format…'}
        </button>
        <p class="hint">
          After moving, use the web app on the copy. Bills entered in the desktop version afterwards are not in the copy. To go back to the desktop
          version, use Utility ▸ <i>Export for the desktop version</i>.
        </p>
        <div class="row">
          <button onClick={onBack}>Back</button>
        </div>
      </div>
    </div>
  );
}

// ---------- export ----------

export async function exportFlow(s: Session): Promise<void> {
  const web = s.ws;
  const ok = await confirmDialog({
    title: 'Export for the desktop version',
    message: (
      <>
        <p>Writes all bills, clients and settings into a new folder in the desktop (Java) version's format, and checks it.</p>
        <p class="warn">
          The desktop version cannot read encrypted files, so the export is <b>not encrypted</b>: anyone using this computer can read it. Put it on a
          USB stick, or delete it when you no longer need it.
        </p>
        <p class="hint">The web data is not changed. Bills entered in the desktop version afterwards are not in the web data.</p>
      </>
    ),
    ok: 'Choose a folder…',
  });
  if (!ok) return;
  const dest = await chooseNewFolder({ id: 'utility-soft-export', title: 'Where should the export go?', suggestion: 'Utility Soft for desktop', outside: [s.root] });
  if (!dest) return;
  const r = await busy('Exporting…', () => exportToDesktop(web, dest, s.password, setBusyLabel));
  if (!r) return;
  await reportDialog({
    title: r.report.ok ? 'Exported and checked' : 'The export does not match',
    intro: r.report.ok ? (
      <p>
        <b>{dest.name}</b> now has your data in the desktop version's format. To use it there, copy <code>billing.jar</code> and the{' '}
        <code>lib</code> folder of the desktop program into {dest.name}, then start <code>billing.jar</code> from there.
      </p>
    ) : (
      <p class="warn">
        The export in <b>{dest.name}</b> is different from the web data. Please report this problem; the export can be deleted.
      </p>
    ),
    report: r.report,
  });
}

// ---------- compare ----------

export async function compareFlow(s: Session): Promise<void> {
  const web = s.ws;
  const program = await pickFolder('utility-soft-program');
  if (!program) return;
  const info = await inspectProgram(program);
  if (info.kind !== 'program') {
    toast(`“${program.name}” is not a desktop Utility Soft folder (the one with pass.txt and impinfo.txt).`, 'error');
    return;
  }
  // Its bills are only shown to someone who knows its password.
  if ((await readPassword(program)) !== s.password) {
    const pw = await promptDialog({ title: 'Compare', label: `Password of ${program.name}`, password: true, ok: 'Compare' });
    if (pw === null) return;
    if ((await readPassword(program)) !== pw) {
      toast('Wrong password.', 'error');
      return;
    }
  }
  const src = await desktopFolders(program);
  if (!src) return;
  const report = await busy('Comparing…', () => verify(src, web, { onProgress: setBusyLabel }));
  if (!report) return;
  await reportDialog({
    title: report.ok ? 'Same as the desktop folder' : 'Differences from the desktop folder',
    intro: (
      <p>
        Compared <b>{program.name}</b> (desktop) with <b>{s.dataLabel}</b> (web format). Nothing was changed.
      </p>
    ),
    report,
  });
}

/** The web copy as a session, when it still has the same password as the desktop folder it came from. */
export async function openCopy(dir: FsaDir, password: string): Promise<Session | null> {
  if (!(await ensurePermission(dir.handle, true))) return null;
  const info = await inspectProgram(dir);
  if (info.kind !== 'web') {
    toast(`“${dir.name}” is no longer a Utility Soft data folder.`, 'error');
    return null;
  }
  const ws = await unlock(dir, password);
  if (!ws) return null;
  await rememberProgram(dir);
  toast(`Opened ${dir.name}.`, 'ok');
  return openWebSession(ws, password);
}
