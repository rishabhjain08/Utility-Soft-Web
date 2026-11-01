import { ComponentChildren, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { UserError } from '../core/workspace';

// ---------- toasts ----------

type ToastKind = 'info' | 'ok' | 'error';
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

let toastSeq = 0;
let setToastsGlobal: ((f: (t: Toast[]) => Toast[]) => void) | null = null;

export function toast(text: string, kind: ToastKind = 'info'): void {
  const id = ++toastSeq;
  setToastsGlobal?.((t) => [...t, { id, kind, text }]);
  setTimeout(() => setToastsGlobal?.((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3500);
}

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  setToastsGlobal = setToasts;
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast toast-${t.kind}`} onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function errorText(e: unknown): string {
  if (e instanceof UserError) return e.message;
  if (e instanceof Error) {
    if (e.name === 'NotAllowedError') return 'Permission to use the folder was denied. Please allow access and try again.';
    if (e.name === 'NoModificationAllowedError' || e.name === 'InvalidModificationError')
      return 'A file could not be changed. It may be open in another program or read-only.';
    return `Something went wrong: ${e.message}`;
  }
  return 'Something went wrong.';
}

/** Runs an action, showing a toast for errors. Returns undefined on error. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(errorText(e), 'error');
    return undefined;
  }
}

// ---------- busy overlay ----------

let setBusyGlobal: ((s: string | null) => void) | null = null;

export async function busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  setBusyGlobal?.(label);
  try {
    return await attempt(fn);
  } finally {
    setBusyGlobal?.(null);
  }
}

export function setBusyLabel(label: string) {
  setBusyGlobal?.(label);
}

export function BusyOverlay() {
  const [label, setLabel] = useState<string | null>(null);
  setBusyGlobal = setLabel;
  if (!label) return null;
  return (
    <div class="busy" role="alert" aria-busy="true">
      <div class="busy-box">
        <div class="spinner" />
        {label}
      </div>
    </div>
  );
}

// ---------- modal ----------

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
  /** Prevents closing with Escape / backdrop (e.g. while working). */
  locked?: boolean;
  class?: string;
}

export function Modal({ title, onClose, children, footer, wide, locked, class: cls }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[autofocus], input:not([disabled]), textarea, select, button.primary, button');
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !locked) {
      e.stopPropagation();
      e.preventDefault();
      onClose();
    }
    if (e.key === 'Tab' && ref.current) {
      const f = Array.from(ref.current.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex="0"]')).filter(
        (x) => !x.hasAttribute('disabled') && x.offsetParent !== null,
      );
      if (f.length === 0) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
        e.preventDefault();
        f[0].focus();
      }
    }
    e.stopPropagation();
  };
  return (
    <div class="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !locked && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''} ${cls ?? ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} onKeyDown={onKey}>
        <div class="modal-head">
          <h2>{title}</h2>
          {!locked && (
            <button class="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- imperative dialogs (confirm / prompt) ----------

function mount<T>(build: (done: (v: T) => void) => ComponentChildren): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const done = (v: T) => {
      render(null, host);
      host.remove();
      resolve(v);
    };
    render(<>{build(done)}</>, host);
  });
}

interface ConfirmOpts {
  title: string;
  message: ComponentChildren;
  ok?: string;
  cancel?: string;
  danger?: boolean;
}

export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  return mount<boolean>((done) => (
    <Modal
      title={o.title}
      onClose={() => done(false)}
      footer={
        <>
          <button onClick={() => done(false)}>{o.cancel ?? 'Cancel'}</button>
          <button class={o.danger ? 'danger' : 'primary'} autoFocus onClick={() => done(true)}>
            {o.ok ?? 'OK'}
          </button>
        </>
      }
    >
      <div class="message">{o.message}</div>
    </Modal>
  ));
}

interface PromptOpts {
  title: string;
  label: string;
  value?: string;
  ok?: string;
  hint?: ComponentChildren;
  validate?: (v: string) => string | null;
  upper?: boolean;
}

export function promptDialog(o: PromptOpts): Promise<string | null> {
  return mount<string | null>((done) => <PromptBody o={o} done={done} />);
}

function PromptBody({ o, done }: { o: PromptOpts; done: (v: string | null) => void }) {
  const [v, setV] = useState(o.value ?? '');
  const err = o.validate?.(v) ?? null;
  const submit = () => !err && done(v);
  return (
    <Modal
      title={o.title}
      onClose={() => done(null)}
      footer={
        <>
          <button onClick={() => done(null)}>Cancel</button>
          <button class="primary" disabled={!!err} onClick={submit}>
            {o.ok ?? 'OK'}
          </button>
        </>
      }
    >
      <label class="field">
        <span>{o.label}</span>
        <input
          autoFocus
          value={v}
          class={o.upper ? 'upper' : ''}
          onInput={(e) => setV((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </label>
      {err && v !== '' && <p class="warn">{err}</p>}
      {o.hint && <p class="hint">{o.hint}</p>}
    </Modal>
  );
}
