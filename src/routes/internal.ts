// Signed endpoints the edge worker calls to wake the app: process the inbox, run due jobs.
// Signature: HMAC-SHA256(APP_SECRET, "internal:<unix ms>:<path>") in X-Internal-Sig, time in X-Internal-Ts (±5 min).
import { Router, Request, Response, NextFunction } from "express";
import { env } from "../env.js";
import { drainInbox } from "../inbox.js";
import { runDueJobs } from "../jobs.js";
import { hmacHex, safeEqual } from "../security.js";

export const internalRoutes = Router();

export function internalSig(ts: number, path: string) {
  return hmacHex(env.appSecret, `internal:${ts}:${path}`);
}

function signed(req: Request, res: Response, next: NextFunction) {
  const ts = Number(req.header("X-Internal-Ts") || 0);
  const sig = String(req.header("X-Internal-Sig") || "");
  if (!ts || Math.abs(Date.now() - ts) > 5 * 60_000 || !safeEqual(sig, internalSig(ts, req.path))) return res.sendStatus(401);
  next();
}

// Answer at once (the edge doesn't wait); the work continues in the background.
internalRoutes.post("/internal/drain", signed, (_req, res) => {
  res.json({ ok: true });
  drainInbox().catch((e) => console.error("drain", e?.message));
});

internalRoutes.post("/internal/tick", signed, (_req, res) => {
  res.json({ ok: true });
  runDueJobs().catch((e) => console.error("jobs", e?.message));
  drainInbox().catch((e) => console.error("drain", e?.message));
});
