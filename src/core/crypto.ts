// Encryption of the web data folder.
//
// One random data key (AES-256-GCM) encrypts every file. The key itself is
// stored only "wrapped" (encrypted) by keys derived from the password and
// from the recovery code, so either one opens the data, and changing the
// password does not re-encrypt anything.
//
// An encrypted file is: "USW1" | 12-byte IV | AES-GCM ciphertext and tag.
// The file's path inside the data folder is authenticated with it, so files
// cannot be swapped around unnoticed.

const MAGIC = new TextEncoder().encode('USW1');
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PASSWORD_ITERATIONS = 600_000;
// The recovery code has 120 random bits; it needs no slow derivation, but gets some anyway.
const RECOVERY_ITERATIONS = 100_000;

export interface Wrap {
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  key: string;
}

export const b64 = (u8: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const buf = (u8: Uint8Array) => u8 as BufferSource;

async function deriveWrappingKey(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** The data key, usable to encrypt files and to name files without revealing what they are about. */
export class DataKey {
  private constructor(
    readonly raw: Uint8Array,
    private readonly aes: CryptoKey,
    private readonly mac: CryptoKey,
  ) {}

  static async fromRaw(raw: Uint8Array): Promise<DataKey> {
    const aes = await crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    // A separate key for names, derived from the data key.
    const hk = await crypto.subtle.importKey('raw', buf(raw), 'HKDF', false, ['deriveKey']);
    const mac = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: buf(new Uint8Array(32)), info: buf(enc.encode('utility-soft names')) },
      hk,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
    return new DataKey(raw, aes, mac);
  }

  static async generate(): Promise<DataKey> {
    return DataKey.fromRaw(crypto.getRandomValues(new Uint8Array(32)));
  }

  async encrypt(path: string, plain: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(enc.encode(path)) }, this.aes, buf(plain)));
    const out = new Uint8Array(MAGIC.length + iv.length + ct.length);
    out.set(MAGIC, 0);
    out.set(iv, MAGIC.length);
    out.set(ct, MAGIC.length + iv.length);
    return out;
  }

  /** Throws DamagedError when the file is not one of ours or was changed. */
  async decrypt(path: string, data: Uint8Array): Promise<Uint8Array> {
    if (data.length < MAGIC.length + 12 + 16 || !MAGIC.every((b, i) => data[i] === b)) throw new DamagedError(path);
    const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(enc.encode(path)) }, this.aes, buf(data.subarray(MAGIC.length + 12))),
      );
    } catch {
      throw new DamagedError(path);
    }
  }

  async encryptText(path: string, text: string): Promise<Uint8Array> {
    return this.encrypt(path, enc.encode(text));
  }

  async decryptText(path: string, data: Uint8Array): Promise<string> {
    return dec.decode(await this.decrypt(path, data));
  }

  /** A file name for `text` (such as a client's name) that does not reveal it. */
  async name(text: string): Promise<string> {
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', this.mac, buf(enc.encode(text))));
    return Array.from(sig.subarray(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async wrap(secret: string, iterations: number): Promise<Wrap> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await deriveWrappingKey(secret, salt, iterations);
    const key = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, k, buf(this.raw)));
    return { kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv), key: b64(key) };
  }

  /** The data key from a wrap, or null when the secret is wrong. */
  static async unwrap(w: Wrap, secret: string): Promise<DataKey | null> {
    const k = await deriveWrappingKey(secret, unb64(w.salt), w.iterations);
    try {
      return DataKey.fromRaw(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(unb64(w.iv)) }, k, buf(unb64(w.key)))));
    } catch {
      return null;
    }
  }
}

export class DamagedError extends Error {
  constructor(readonly path: string) {
    super(`The file ${path} is damaged or was changed outside Utility Soft.`);
    this.name = 'DamagedError';
  }
}

// ---------- recovery code ----------

// Crockford's base 32: no I, L, O or U, so it is hard to misread or mistype.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 24 random characters in groups of four: 1A2B-3C4D-… */
export function newRecoveryCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(24));
  const chars = Array.from(r, (x) => ALPHABET[x % 32]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/**
 * The code as typed or pasted (any case, spaces or dashes, O for 0, I or L for 1;
 * also the whole text of the saved note), or null when it cannot be one.
 */
export function normalizeRecoveryCode(typed: string): string | null {
  // A whole pasted email or note: the code is the 6 groups of 4 with dashes in it.
  const inNote = /(?:^|[^0-9a-z])([0-9a-z]{4}(?:-[0-9a-z]{4}){5})(?![0-9a-z])/i.exec(typed) ?? /([0-9a-z]{4}(?:[-\s][0-9a-z]{4}){5})\s*$/i.exec(typed.trim());
  const t = (inNote ? inNote[1] : typed).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (t.length !== 24 || [...t].some((c) => !ALPHABET.includes(c))) return null;
  return t.match(/.{4}/g)!.join('-');
}

export { RECOVERY_ITERATIONS };

export async function sha256(data: Uint8Array): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', buf(data))));
}
