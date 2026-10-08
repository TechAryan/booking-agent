// Crypto helpers built only on Web Crypto, so the same code runs in Node 22 and in Cloudflare Workers.
// Formats match src/security.ts exactly (encrypted secrets are "v1:iv:tag:data", base64, AES-256-GCM).
const te = new TextEncoder();
const subtle = globalThis.crypto.subtle;

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
type Bytes = Uint8Array<ArrayBuffer> | string;
const bytes = (d: Bytes): Uint8Array<ArrayBuffer> => (typeof d === "string" ? te.encode(d) : d);

export async function sha256Hex(data: Bytes) {
  return toHex(await subtle.digest("SHA-256", bytes(data)));
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();
export async function hmacHex(secret: string, data: Bytes) {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (hmacKeys.size > 500) hmacKeys.clear();
    hmacKeys.set(secret, k);
  }
  return toHex(await subtle.sign("HMAC", await k, bytes(data)));
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const aesKeys = new Map<string, Promise<CryptoKey>>();
/** Decrypts a secret stored by src/security.ts encrypt(). */
export async function decryptSecret(appSecret: string, blob: string | null | undefined): Promise<string | null> {
  if (!blob) return null;
  const [v, iv, tag, data] = blob.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unknown secret format");
  let k = aesKeys.get(appSecret);
  if (!k) {
    k = subtle.digest("SHA-256", te.encode(`enc:${appSecret}`)).then((raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]));
    aesKeys.set(appSecret, k);
  }
  const ct = new Uint8Array([...fromB64(data), ...fromB64(tag)]); // Web Crypto wants the tag appended
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await k, ct);
  return new TextDecoder().decode(plain);
}

/** Signature the app checks on /internal/* (see src/routes/internal.ts). */
export function internalSig(appSecret: string, ts: number, path: string) {
  return hmacHex(appSecret, `internal:${ts}:${path}`);
}
