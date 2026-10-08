// Shared HTTP plumbing for the fetch-based adapters: timeouts, one retry on flaky errors, and error mapping.
import { AIError } from "./types.js";

export async function callJson(url: string, init: { method?: string; headers: Record<string, string>; body?: unknown }, who: string, model = ""): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      last = new AIError("down", `Couldn't reach ${who} just now. Try again shortly.`);
      continue;
    }
    const text = await res.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.ok) return j;
    const err = mapHttpError(res.status, errMessage(j) || text.slice(0, 300), who, model);
    if (err.kind === "down" && attempt === 0) { last = err; await new Promise((r) => setTimeout(r, 800)); continue; }
    throw err;
  }
  throw last;
}

function errMessage(j: any): string {
  if (!j) return "";
  if (Array.isArray(j)) return errMessage(j[0]);
  const e = j.error ?? j;
  return String(e?.message ?? e?.msg ?? (typeof e === "string" ? e : "") ?? "");
}

export function mapHttpError(status: number, msg: string, who: string, model: string): AIError {
  const m = msg.toLowerCase();
  if (status === 401 || status === 403 || /api key not valid|invalid api key|incorrect api key|invalid_api_key|unauthori[sz]ed/.test(m))
    return new AIError("key", `This ${who} API key is not valid. Copy it again from ${who}.`, status);
  if (status === 402 || /insufficient[_ ](quota|balance|credits?)|billing|credit balance|exceeded your current quota|prepayment/.test(m))
    return new AIError("credit", `The ${who} key works, but the account has no credit. Add credit in ${who}'s billing page.`, status);
  if (status === 404 || /model.*(not found|does not exist|not supported|unknown|invalid)|no endpoints found/.test(m))
    return new AIError("model", `The version "${model}" isn't available for this ${who} key. Pick another version.`, status);
  if (status === 429) return new AIError("rate", `${who} is busy (rate limit). Wait a minute and try again.`, status);
  if (status >= 500) return new AIError("down", `${who} had a problem just now. Try again shortly.`, status);
  return new AIError("bad_request", `${who}: ${msg || `error ${status}`}`, status);
}

export function parseArgs(s: unknown): any {
  if (s && typeof s === "object") return s;
  try { const v = JSON.parse(String(s || "{}")); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
