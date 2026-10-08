// File storage for photos (payment screenshots) and, later, call transcripts.
// Uses Cloudflare R2 (S3-compatible, 10 GB free, no download fees) when R2_* settings exist; otherwise the
// caller keeps the bytes in the database as before. Keys are private: files are only served through the app.
import { AwsClient } from "aws4fetch";

const cfg = () => ({
  account: process.env.R2_ACCOUNT_ID || "",
  keyId: process.env.R2_ACCESS_KEY_ID || "",
  secret: process.env.R2_SECRET_ACCESS_KEY || "",
  bucket: process.env.R2_BUCKET || "",
  endpoint: (process.env.R2_ENDPOINT || "").replace(/\/+$/, ""), // tests point this at a fake
});

export function storageReady() {
  const c = cfg();
  return !!(c.keyId && c.secret && c.bucket && (c.account || c.endpoint));
}

let client: AwsClient | null = null;
function s3() {
  const c = cfg();
  client ??= new AwsClient({ accessKeyId: c.keyId, secretAccessKey: c.secret, service: "s3", region: "auto" });
  const base = c.endpoint || `https://${c.account}.r2.cloudflarestorage.com`;
  return { client, url: (key: string) => `${base}/${c.bucket}/${key.split("/").map(encodeURIComponent).join("/")}` };
}

export async function putFile(key: string, body: Uint8Array, contentType: string) {
  const { client, url } = s3();
  const r = await client.fetch(url(key), { method: "PUT", body: new Uint8Array(body) as Uint8Array<ArrayBuffer>, headers: { "Content-Type": contentType } });
  if (!r.ok) throw new Error(`Storage upload failed (${r.status})`);
}

export async function getFile(key: string): Promise<{ bytes: Buffer; type: string } | null> {
  const { client, url } = s3();
  const r = await client.fetch(url(key));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Storage read failed (${r.status})`);
  return { bytes: Buffer.from(await r.arrayBuffer()), type: r.headers.get("Content-Type") || "application/octet-stream" };
}

export async function deleteFile(key: string) {
  const { client, url } = s3();
  const r = await client.fetch(url(key), { method: "DELETE" });
  if (!r.ok && r.status !== 404) throw new Error(`Storage delete failed (${r.status})`);
}
