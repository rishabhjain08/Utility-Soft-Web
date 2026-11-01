// Byte/text codec compatible with the Java program's file handling.
//
// Most data files are "encrypted" by the Java program by shifting every UTF-16
// code unit down by 10 (passwordpro.encrypt/decrypt). Lines are separated by
// CRLF which is written raw (unshifted). A few files (ddown.txt,
// loaddatafrom.txt, activelocation.txt) are plain text.
//
// Java reads the shifted files as UTF-8 but writes them with the platform
// default charset (windows-1252 on Windows with Java 8). Plain files are both
// read and written with the default charset. We therefore read UTF-8 when the
// bytes are valid UTF-8 and fall back to windows-1252 otherwise.

const SHIFT = 10;

export function encrypt(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) - SHIFT);
  return out;
}

export function decrypt(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) + SHIFT);
  return out;
}

/**
 * Removes characters that the Java program cannot store safely:
 * control characters (their shifted value would be negative or a line break),
 * characters whose shifted value is a Java line terminator (U+0085, U+2028,
 * U+2029), and surrogates/private-use code units whose shifted value would be
 * an unpaired surrogate. Tabs and newlines become spaces.
 */
export function sanitize(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13) { out += ' '; continue; }
    if (c < 32 || (c >= 0x7f && c <= 0x9f)) continue;
    if (c === 0x2032 || c === 0x2033) { out += "'"; continue; }
    if (c > 0xffff || (c >= 0xd800 && c <= 0xdfff) || (c >= 0xe000 && c <= 0xe009)) continue;
    out += ch;
  }
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp1252 = new TextDecoder('windows-1252');

export function decodeBytes(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return cp1252.decode(bytes);
  }
}

// windows-1252 bytes 0x80-0x9F map to these code points.
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** UTF-8 encoding; used for the shifted files, which Java reads as UTF-8. */
export function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Encoding for plain files that Java reads with the platform default charset.
 * ASCII is identical everywhere; otherwise prefer windows-1252 (Java 8 on
 * Windows) when every character fits, else UTF-8.
 */
export function encodePlain(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) bytes.push(c);
    else if (CP1252_HIGH[c] !== undefined) bytes.push(CP1252_HIGH[c]);
    else return encodeUtf8(s);
  }
  return new Uint8Array(bytes);
}

/**
 * Splits text into lines the way java.util.Scanner.nextLine() does:
 * terminators are \r\n, \n, \r, U+2028, U+2029 and U+0085, and a trailing
 * terminator does not start an extra (empty) line.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|[\n\r\u2028\u2029\u0085]/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Decodes a shifted file into its plain lines. */
export function decodeCipherLines(bytes: Uint8Array): string[] {
  return splitLines(decodeBytes(bytes)).map(decrypt);
}

/** Encodes plain lines as a shifted file, each line followed by CRLF. */
export function encodeCipherLines(lines: string[]): Uint8Array {
  return encodeUtf8(lines.map((l) => encrypt(sanitize(l)) + '\r\n').join(''));
}

/** Encodes a single shifted value with no line terminator (serialno.txt, billfromto.txt, pass.txt...). */
export function encodeCipherValue(value: string): Uint8Array {
  return encodeUtf8(encrypt(sanitize(value)));
}

/** First line of a shifted file, or '' when empty. */
export function decodeCipherValue(bytes: Uint8Array): string {
  return decodeCipherLines(bytes)[0] ?? '';
}

export function decodePlainLines(bytes: Uint8Array): string[] {
  return splitLines(decodeBytes(bytes));
}

export function encodePlainLines(lines: string[]): Uint8Array {
  return encodePlain(lines.map((l) => l + '\r\n').join(''));
}
