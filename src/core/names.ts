// Names that become file or folder names in the desktop (Java) layout. The web
// format keeps the same rules, so its data can always be exported back.

import { sameName } from './sort';

export class UserError extends Error {}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Validates a client, bill or tab name that becomes a file or folder name. */
export function checkName(name: string, what = 'Name'): string {
  const n = name.trim();
  if (n === '') throw new UserError(`${what} cannot be empty.`);
  if (/[<>:"/\\|?*\x00-\x1f]/.test(n)) throw new UserError(`${what} cannot contain any of  < > : " / \\ | ? *`);
  if (/[.]$/.test(n)) throw new UserError(`${what} cannot end with a dot.`);
  if (WINDOWS_RESERVED.test(n)) throw new UserError(`"${n}" is a reserved name on Windows.`);
  if (n.length > 120) throw new UserError(`${what} is too long.`);
  return n;
}

/** A new tab name: a valid folder name, without the characters impinfo.txt uses, not already taken. */
export function checkTabName(raw: string, taken: { folder: string; tab: string }[]): string {
  const name = checkName(raw, 'Tab name');
  if (/[()^%]/.test(name)) throw new UserError('Tab name cannot contain ( ) ^ or %');
  if (taken.some((t) => sameName(t.tab, name) || sameName(t.folder, name))) throw new UserError('This tab name already exists.');
  return name;
}
