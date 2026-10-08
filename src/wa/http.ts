import { WaError } from "./types.js";

/** JSON/form HTTP call with a timeout and readable errors ("Twilio rejected these details…"). */
export async function call(who: string, url: string, init: { method?: string; headers?: Record<string, string>; json?: unknown; form?: Record<string, string> } = {}): Promise<any> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.json); }
  if (init.form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(init.form).toString(); }
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new WaError(`Couldn't reach ${who}. Try again in a minute.`);
  }
  const text = await res.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
  if (res.status === 401 || res.status === 403) throw new WaError(`${who} rejected these details. Copy them again and check nothing is missing.`);
  if (!res.ok) throw new WaError(`${who} error ${res.status}: ${errText(j) || text.slice(0, 160)}`);
  return j;
}

function errText(j: any): string {
  if (!j) return "";
  const e = j.error ?? j.errors?.[0] ?? j;
  return String(e?.message ?? e?.error_user_msg ?? e?.info ?? e?.detail ?? (typeof e === "string" ? e : "") ?? "").slice(0, 200);
}

/** Raw download (media). Follows redirects; never forwards auth to another host. */
export async function download(who: string, url: string, headers: Record<string, string> = {}): Promise<{ bytes: Buffer; mime: string }> {
  let res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  for (let i = 0; i < 3 && res.status >= 300 && res.status < 400 && res.headers.get("location"); i++) {
    const next = new URL(res.headers.get("location")!, url);
    const sameHost = next.host === new URL(url).host;
    res = await fetch(next, { headers: sameHost ? headers : {}, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    url = next.toString();
  }
  if (!res.ok) throw new WaError(`${who}: couldn't download the photo (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mime: (res.headers.get("content-type") || "image/jpeg").split(";")[0]! };
}

export const digits = (s: unknown) => String(s ?? "").replace(/[^\d]/g, "");
export const base = (envKey: string, fallback: string) => (process.env[envKey] || fallback).replace(/\/+$/, "");
