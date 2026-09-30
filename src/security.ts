import crypto from "node:crypto";
import { env } from "./env.js";

// ---------- Encryption for stored secrets (AES-256-GCM) ----------

const key = crypto.createHash("sha256").update(`enc:${env.appSecret}`).digest();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decrypt(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const [v, iv, tag, data] = blob.split(":");
  if (v !== "v1") throw new Error("Unknown secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/** "sk-ant-api03-abc…xyz" → "sk-ant-…wxyz" for display. */
export function mask(secret: string | null): string {
  if (!secret) return "";
  if (secret.length <= 10) return "••••";
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

// ---------- Passwords (scrypt) ----------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split(":");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** Readable temporary password, e.g. "tulip-7342-river". */
export function tempPassword(): string {
  const words = ["amber", "river", "tulip", "cedar", "maple", "orbit", "pixel", "coral", "lotus", "delta", "ember", "falcon", "harbor", "jasmine", "kiwi", "lemon"];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${crypto.randomInt(1000, 9999)}-${pick()}`;
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Use at least one letter and one number.";
  return null;
}

// ---------- Tokens ----------

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function hmacHex(secret: string, data: Buffer | string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- Simple in-memory rate limiter ----------

const buckets = new Map<string, { count: number; reset: number }>();
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  b.count++;
  return b.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();
